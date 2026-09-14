/**
 * Fixed-step simulation clock, and the scheduler that drives it interactively.
 *
 * The authoritative quantity is an **integer tick index**. Simulated time is
 * derived from it, never accumulated:
 *
 * ```
 *   time = tick / tickRate
 * ```
 *
 * Accumulating `t += dt` would drift, and worse, it would make the world depend
 * on how the ticks were grouped — a run stepped 1000 times would end up at a
 * slightly different time from one stepped 1000 at once. Deriving time from a
 * counter makes those identical by construction.
 *
 * Wall-clock time may decide *how many* ticks to run. It never decides how
 * large a tick is.
 *
 * See docs/adr/0008-fixed-timestep-simulation.md.
 */

import { type Hertz, type Seconds, seconds } from '@/core/contracts/units';

/** Monotonic tick counter and its mapping to simulated time. */
export class SimulationClock {
  public readonly tickRate: Hertz;
  /** Duration of one tick. Reported for display; time is derived from the counter. */
  public readonly fixedTimestep: Seconds;

  private currentTick = 0;

  /** @throws {RangeError} when `tickRate` is not strictly positive. */
  constructor(tickRate: Hertz) {
    if (!(tickRate > 0)) {
      throw new RangeError(`Tick rate must be strictly positive, received ${String(tickRate)} Hz`);
    }
    this.tickRate = tickRate;
    this.fixedTimestep = seconds(1 / tickRate);
  }

  public get tick(): number {
    return this.currentTick;
  }

  /** Simulated time at the current tick. */
  public get time(): Seconds {
    return this.timeAt(this.currentTick);
  }

  /** Simulated time at an arbitrary tick. */
  public timeAt(tick: number): Seconds {
    return seconds(tick / this.tickRate);
  }

  /** @throws {RangeError} when `ticks` is not a non-negative integer. */
  public advance(ticks: number): void {
    if (!Number.isInteger(ticks) || ticks < 0) {
      throw new RangeError(`Tick count must be a non-negative integer, received ${String(ticks)}`);
    }
    this.currentTick += ticks;
  }

  public reset(): void {
    this.currentTick = 0;
  }
}

/** What the scheduler is currently doing. */
export type PlaybackStatus = 'idle' | 'running' | 'paused' | 'stopped';

/** Playback multipliers offered to the operator. */
export const PLAYBACK_SPEEDS = [0.25, 0.5, 1, 2, 4] as const;
export type PlaybackSpeed = (typeof PLAYBACK_SPEEDS)[number];

export interface PlaybackSchedulerOptions {
  readonly tickRate: Hertz;
  /**
   * Most ticks one `advance` call may emit.
   *
   * Catch-up protection. If the tab is backgrounded for a second, the next
   * frame reports a huge wall-clock delta; without a ceiling the scheduler
   * would try to run every missed tick at once and freeze the UI, and with a
   * variable-step integrator it would inject one enormous dt. The simulation
   * falls behind real time instead, which is the correct trade for an
   * engineering tool: simulated time stays exact, only the animation slips.
   */
  readonly maxTicksPerAdvance?: number;
}

/** How many ticks to run, and where the renderer sits between them. */
export interface TickBudget {
  readonly ticks: number;
  /**
   * Fraction of a tick already elapsed, on [0, 1). Visualisation only — the
   * renderer interpolates across it; the world never sees it.
   */
  readonly alpha: number;
  /** True when catch-up protection discarded time this call. */
  readonly clamped: boolean;
}

const DEFAULT_MAX_TICKS_PER_ADVANCE = 240;

/**
 * Turns wall-clock deltas into whole tick counts.
 *
 * Deliberately free of `requestAnimationFrame`, `performance.now` and the DOM:
 * the caller supplies elapsed seconds, which makes the scheduler ordinary
 * testable code rather than something only observable in a browser.
 */
export class PlaybackScheduler {
  public readonly tickRate: Hertz;
  public readonly maxTicksPerAdvance: number;

  private currentStatus: PlaybackStatus = 'idle';
  private currentSpeed: PlaybackSpeed = 1;
  /** Simulated seconds owed but not yet worth a whole tick. */
  private residual = 0;

  constructor(options: PlaybackSchedulerOptions) {
    if (!(options.tickRate > 0)) {
      throw new RangeError(
        `Tick rate must be strictly positive, received ${String(options.tickRate)}`,
      );
    }
    this.tickRate = options.tickRate;
    this.maxTicksPerAdvance = options.maxTicksPerAdvance ?? DEFAULT_MAX_TICKS_PER_ADVANCE;
  }

  public get status(): PlaybackStatus {
    return this.currentStatus;
  }

  public get speed(): PlaybackSpeed {
    return this.currentSpeed;
  }

  /**
   * Sets the playback multiplier.
   *
   * Affects only how fast simulated time is consumed against the wall clock.
   * The world's evolution per tick is untouched, so a trajectory sampled at a
   * given simulated time is identical at 0.25x and 4x.
   */
  public setSpeed(speed: PlaybackSpeed): void {
    this.currentSpeed = speed;
  }

  public start(): void {
    this.currentStatus = 'running';
    this.residual = 0;
  }

  public pause(): void {
    if (this.currentStatus === 'running') this.currentStatus = 'paused';
  }

  /**
   * Moves to `paused` from any state.
   *
   * Single-stepping needs this: `pause` only acts on a running scheduler, so
   * stepping a never-started run would leave it reporting `idle` while sitting
   * at a non-zero tick. Holding says what is true — the run has begun and is
   * stopped — and leaves `resume` able to pick it up.
   */
  public hold(): void {
    this.currentStatus = 'paused';
    this.residual = 0;
  }

  public resume(): void {
    if (this.currentStatus === 'paused') {
      this.currentStatus = 'running';
      // Time spent paused is not owed. Without this the first frame after
      // resuming would try to catch up the whole pause.
      this.residual = 0;
    }
  }

  public stop(): void {
    this.currentStatus = 'stopped';
    this.residual = 0;
  }

  /** Returns to the cold-start state. */
  public reset(): void {
    this.currentStatus = 'idle';
    this.residual = 0;
  }

  /**
   * Converts elapsed wall-clock time into a tick budget.
   *
   * Returns zero ticks unless running. `alpha` still advances within a tick so
   * interpolation stays smooth between whole steps.
   *
   * @throws {RangeError} when `elapsedSeconds` is negative or not finite.
   */
  public advance(elapsedSeconds: number): TickBudget {
    if (!Number.isFinite(elapsedSeconds) || elapsedSeconds < 0) {
      throw new RangeError(
        `Elapsed wall-clock time must be finite and non-negative, received ${String(elapsedSeconds)}`,
      );
    }

    if (this.currentStatus !== 'running') {
      return { ticks: 0, alpha: this.residual * this.tickRate, clamped: false };
    }

    this.residual += elapsedSeconds * this.currentSpeed;

    const tickPeriod = 1 / this.tickRate;
    let ticks = Math.floor(this.residual / tickPeriod);
    let clamped = false;

    if (ticks > this.maxTicksPerAdvance) {
      ticks = this.maxTicksPerAdvance;
      clamped = true;
      // Drop the backlog rather than carrying it: a debt that can never be
      // repaid would keep the scheduler permanently clamped.
      this.residual = 0;
      return { ticks, alpha: 0, clamped };
    }

    this.residual -= ticks * tickPeriod;
    return { ticks, alpha: this.residual * this.tickRate, clamped };
  }
}
