/**
 * The authoritative simulation.
 *
 * This class is the world. It has no dependency on React, Three.js, the DOM or
 * a render loop, and it never will — the lint barrier over `src/core` enforces
 * that. A renderer reads snapshots from it; nothing writes back. Driving it
 * from a test or a future headless benchmark runner is the same code path the
 * interactive UI uses, which is what makes the two agree by construction rather
 * than by care.
 *
 * See ADR-0006 and docs/SIMULATION.md.
 */

import type { GroundTruthState, WorldState } from '@/core/contracts/ground-truth';
import { brandAsGroundTruth } from '@/core/contracts/ground-truth';
import type { SimulationConfig } from '@/core/contracts/simulation';
import type { Seconds } from '@/core/contracts/units';

import { SimulationClock } from './clock';
import { RandomStreams } from './rng';
import { type Trajectory, createTrajectory } from './trajectory';
import { sampleGroundTruth } from './world';

/** Recursively freezes a snapshot so a consumer cannot edit the world. */
function deepFreeze<T>(value: T): T {
  if (typeof value !== 'object' || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

/**
 * FNV-1a over the raw bytes of every float in the state.
 *
 * Hashing the IEEE-754 bytes rather than a rounded decimal rendering is what
 * makes this a real determinism check: two runs that differ in the last bit of
 * a position produce different hashes, which is exactly the difference a
 * repeatability test needs to catch.
 */
class FloatHasher {
  private hash = 0x811c9dc5;
  private readonly buffer = new ArrayBuffer(8);
  private readonly view = new DataView(this.buffer);
  private readonly bytes = new Uint8Array(this.buffer);

  public addNumber(value: number): void {
    this.view.setFloat64(0, value, true);
    for (let index = 0; index < 8; index += 1) {
      this.hash = Math.imul(this.hash ^ this.bytes[index]!, 0x01000193) >>> 0;
    }
  }

  public addString(value: string): void {
    for (let index = 0; index < value.length; index += 1) {
      this.hash = Math.imul(this.hash ^ value.charCodeAt(index), 0x01000193) >>> 0;
    }
  }

  public digest(): string {
    return (this.hash >>> 0).toString(16).padStart(8, '0');
  }
}

/** Stable digest of the true state, for repeatability tests and replay checks. */
export function hashGroundTruth(truth: GroundTruthState): string {
  const hasher = new FloatHasher();
  hasher.addNumber(truth.tick);
  hasher.addNumber(truth.time);
  hasher.addNumber(truth.pointingError ?? Number.NaN);

  const platform = truth.platform.pose.position;
  hasher.addNumber(platform.x);
  hasher.addNumber(platform.y);
  hasher.addNumber(platform.z);

  hasher.addNumber(truth.gimbal.azimuth);
  hasher.addNumber(truth.gimbal.elevation);

  for (const target of truth.targets) {
    hasher.addString(target.id);
    hasher.addNumber(target.pose.position.x);
    hasher.addNumber(target.pose.position.y);
    hasher.addNumber(target.pose.position.z);
    hasher.addNumber(target.velocity.x);
    hasher.addNumber(target.velocity.y);
    hasher.addNumber(target.velocity.z);
    hasher.addNumber(target.range);
    hasher.addNumber(target.bearingFromGimbal.azimuth);
    hasher.addNumber(target.bearingFromGimbal.elevation);
  }

  return hasher.digest();
}

/** Options for {@link SimulationEngine.step}. */
export interface StepOptions {
  /**
   * Run past the configured duration.
   *
   * Off by default. A finite experiment that quietly kept going would no longer
   * be the experiment that was configured, so exceeding it is an explicit act —
   * useful for stress tests and headless exploration, never something the UI
   * does by accident.
   */
  readonly beyondDuration?: boolean;
}

export class SimulationEngine {
  public readonly config: SimulationConfig;
  public readonly clock: SimulationClock;

  private readonly streams: RandomStreams;
  private trajectories: readonly Trajectory[];

  /** Memoised snapshot; invalidated whenever the tick advances. */
  private cachedSnapshot: WorldState | null = null;

  /**
   * @throws {RangeError} via the clock when the tick rate is not positive, and
   * via a trajectory family when its configuration is unusable.
   */
  constructor(config: SimulationConfig) {
    this.config = config;
    this.clock = new SimulationClock(config.tickRate);
    this.streams = new RandomStreams(config.seed);
    this.trajectories = this.buildTrajectories();
  }

  /**
   * Constructs the trajectories from a freshly reset trajectory stream.
   *
   * Building here rather than lazily is what makes the stream cursor a function
   * of the configuration alone: a seeded manoeuvre draws its whole schedule at
   * construction, so the cursor after setup does not depend on which targets
   * happened to be sampled first.
   */
  private buildTrajectories(): readonly Trajectory[] {
    const stream = this.streams.get('trajectory');
    stream.reset();
    return this.config.targets.map((target) =>
      createTrajectory(target.trajectory, {
        stream,
        durationSeconds: this.config.duration,
      }),
    );
  }

  public get tick(): number {
    return this.clock.tick;
  }

  public get time(): Seconds {
    return this.clock.time;
  }

  /** Simulated seconds the scenario asked for. */
  public get duration(): Seconds {
    return this.config.duration;
  }

  /**
   * Last tick belonging to the run.
   *
   * A scenario declares a duration, so a run is finite and its last tick is
   * `floor(duration * tickRate)`. Deriving it from the integer tick index
   * rather than comparing accumulated time keeps the boundary exact.
   */
  public get finalTick(): number {
    return Math.floor(this.config.duration * this.config.tickRate);
  }

  /** True once the run has reached its final tick. */
  public get isComplete(): boolean {
    return this.clock.tick >= this.finalTick;
  }

  /**
   * Advances the world by whole ticks, stopping at the end of the run.
   *
   * `step(1)` a thousand times and `step(1000)` once leave the world in
   * identical states, because the world is a function of the tick index rather
   * than an accumulation of increments. The test suite asserts that rather than
   * assuming it.
   *
   * **The run is bounded by its configured duration.** Without that, an
   * interactive session left running would keep producing ticks past the end of
   * the experiment — the scenario would still be "playing" but would no longer
   * be the experiment anyone configured, and for a seeded manoeuvre it would
   * run past the end of the generated schedule into the coast regime. Ticks
   * beyond the final tick are therefore not taken, and the return value says
   * how many actually were.
   *
   * Deliberate overrun is still possible for tests and headless exploration,
   * but it has to be asked for.
   *
   * @returns the number of ticks actually advanced.
   * @throws {RangeError} when `ticks` is not a non-negative integer.
   */
  public step(ticks = 1, options: StepOptions = {}): number {
    if (!Number.isInteger(ticks) || ticks < 0) {
      throw new RangeError(`Tick count must be a non-negative integer, received ${String(ticks)}`);
    }

    const allowed =
      options.beyondDuration === true
        ? ticks
        : Math.min(ticks, Math.max(0, this.finalTick - this.clock.tick));

    if (allowed > 0) {
      this.clock.advance(allowed);
      this.cachedSnapshot = null;
    }
    return allowed;
  }

  /** Returns to tick zero, replaying every random stream from its start. */
  public reset(): void {
    this.clock.reset();
    this.streams.reset();
    this.trajectories = this.buildTrajectories();
    this.cachedSnapshot = null;
  }

  /**
   * The world at the current tick: frozen, branded, and safe to hand to the UI.
   *
   * Deep-frozen so a component cannot reach through a rendered prop and edit
   * the world — an accident that would otherwise be invisible until a run
   * stopped reproducing. Memoised per tick, so the freeze is paid once however
   * many observers ask.
   */
  public snapshot(): WorldState {
    if (this.cachedSnapshot !== null) return this.cachedSnapshot;

    const truth = sampleGroundTruth({
      config: this.config,
      trajectories: this.trajectories,
      tick: this.clock.tick,
      timeSeconds: this.clock.time,
    });

    const world = brandAsGroundTruth({
      config: this.config,
      truth,
      randomStreamCursors: this.streams.cursors(),
      // No camera frames are produced in Phase 1; the sensor model arrives in
      // Phase 2 and will own this counter.
      frameCounter: 0,
    }) satisfies WorldState;

    this.cachedSnapshot = deepFreeze(world);
    return this.cachedSnapshot;
  }

  /**
   * The world at an arbitrary tick, without moving the engine.
   *
   * Used by the renderer to interpolate between ticks, and by tests to check a
   * time directly. Because the world is a pure function of time this is exactly
   * the state the engine would report had it stepped there.
   */
  public sampleAtTick(tick: number): GroundTruthState {
    return this.sampleAtTime(this.clock.timeAt(tick), tick);
  }

  /**
   * The world at an arbitrary simulated time, without moving the engine.
   *
   * Available because trajectories are pure functions of time, which means a
   * consumer that needs state between two ticks — the camera, whose capture
   * times do not align with the physics tick — can have the exact state rather
   * than an interpolation of the two nearest ticks.
   *
   * @param tick the tick index to label the state with; defaults to the tick
   *   containing `timeSeconds`. It is a label only: the state itself comes from
   *   the time.
   */
  public sampleAtTime(timeSeconds: number, tick?: number): GroundTruthState {
    return sampleGroundTruth({
      config: this.config,
      trajectories: this.trajectories,
      tick: tick ?? Math.floor(timeSeconds * this.config.tickRate),
      timeSeconds,
    });
  }

  /** Digest of the current true state. */
  public stateHash(): string {
    return hashGroundTruth(this.snapshot().truth);
  }

  /** The trajectories, for the ground-truth debug inspector. */
  public describeTrajectories(): readonly string[] {
    return this.trajectories.map((trajectory) => trajectory.describe());
  }

  /** The evaluator for one target, for the debug inspector. */
  public trajectoryAt(index: number): Trajectory | undefined {
    return this.trajectories[index];
  }

  /** Draw counts per random stream. */
  public randomStreamCursors(): Readonly<Record<string, number>> {
    return this.streams.cursors();
  }
}
