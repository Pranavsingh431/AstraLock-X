/**
 * The autonomous control loop.
 *
 * This is the only place in the system where the world, the mount, the camera
 * and a tracking algorithm meet. Everything about that meeting that could be
 * got subtly wrong is decided here, on purpose, in one file.
 *
 * **The algorithm does not own the mount.** It never receives `DynamicGimbal`,
 * cannot call `commandPosition`, and cannot choose a command id or a due time.
 * It returns an *intent* — "point there" — and this runtime turns that into a
 * physical command with a timestamp it did not choose. An algorithm that could
 * stamp its own commands could back-date them.
 *
 * **Commands are never back-dated.** A frame captured at 16.667 ms may not be
 * delivered until the engine has advanced to 20 ms. The command derived from it
 * is stamped 20 ms, not 16.667 ms, because that is when the request actually
 * existed. The configured mount latency then runs from there.
 *
 * ```
 *   captureTime  ──▶  frame available  ──▶  algorithm  ──▶  issue time
 *     16.667 ms          20.000 ms          (0 cost)         20.000 ms
 *                                                               │
 *                                                  + commandLatency
 *                                                               ▼
 *                                                            due time
 * ```
 *
 * Phase 4 models the algorithm's own compute cost as zero, so the issue time is
 * the moment the frame became available rather than the moment processing
 * finished. The invariant that matters is enforced regardless:
 * `issuedAt >= captureTime`, always.
 *
 * **Frames are processed in order, never skipped.** Advancing ten ticks at once
 * and handing the algorithm only the newest frame would silently drop nine
 * frames of measurements, and the loop's behaviour would then depend on how
 * often the UI happened to call it. Every frame due in an interval is delivered
 * in capture order.
 *
 * See docs/adr/0013-command-intent-and-issue-time.md and docs/BASELINE_PAT.md.
 */

import type {
  AlgorithmInstance,
  AlgorithmPlugin,
  TrackingInput,
  TrackingOutput,
} from '@/core/contracts/algorithm-plugin';
import { guardTrackingInput } from '@/core/contracts/algorithm-plugin';
import type { CommandIntent, ControlCommand } from '@/core/contracts/control';
import type { CameraSensorFrame, CameraState, GimbalState } from '@/core/contracts/sensors';
import type { SimulationConfig } from '@/core/contracts/simulation';
import {
  hertz,
  meters,
  milliseconds,
  normalized,
  pixels,
  radians,
  radiansPerSecond,
  seconds,
} from '@/core/contracts/units';
import type { DynamicGimbal } from '@/core/gimbal';
import type { SensorCapture, VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import type { WorldSampler } from '@/core/sensors/world-sampler';
import type { SimulationEngine } from '@/core/simulation/engine';

/** One command the runtime actually issued, for diagnostics and replay. */
export interface IssuedCommand {
  /** Frame that led to this command, or `null` for a tick with no frame. */
  readonly frameId: number | null;
  readonly captureTime: number | null;
  /** Simulation time the runtime stamped it with. Never before `captureTime`. */
  readonly issuedAt: number;
  readonly azimuth: number;
  readonly elevation: number;
  /** Id the mount assigned. */
  readonly commandId: number;
}

/** What one processed frame did. */
export interface LoopEvent {
  readonly frameId: number;
  readonly captureTime: number;
  readonly processedAt: number;
  readonly mode: string;
  readonly commandIssued: boolean;
}

export interface ClosedLoopOptions {
  readonly engine: SimulationEngine;
  readonly sensor: VirtualCameraSensor;
  readonly sampler: WorldSampler;
  /**
   * Any registered plugin.
   *
   * `unknown` on both parameters: the runtime does not care what a plugin's
   * config or debug types are, and must not — those are the plugin's own and
   * were checked when it passed through `defineAlgorithm`. The config below is
   * validated against the plugin's schema before construction.
   */
  readonly plugin: AlgorithmPlugin<unknown, unknown>;
  readonly config: unknown;
  /** Seeded uniform stream for stochastic algorithms. Defaults to a fixed one. */
  readonly random?: () => number;
  /** Frames of history retained for the UI. Bounded on purpose. */
  readonly historyLimit?: number;
  /**
   * Called after the algorithm has processed each frame, with the capture it
   * saw and what it decided.
   *
   * For the interface. The capture is **borrowed** — its lease is released as
   * soon as this returns — so a consumer that wants to display the frame must
   * copy it with `toOwned()`. That is the display path paying for its own
   * persistence, and it is why a slow or absent interface cannot affect the
   * control loop.
   */
  readonly onFrame?: (capture: SensorCapture, output: TrackingOutput<unknown>) => void;
  /**
   * Replaces every frame's pixels with a constant before the algorithm sees
   * them. For the anti-cheat test: with no image information the tracker must
   * fail to acquire, which it cannot do if it is reading the world some other
   * way.
   */
  readonly blankPixels?: boolean;
}

const DEFAULT_HISTORY = 256;

/**
 * Builds the algorithm's view of the camera.
 *
 * The *believed* calibration. Here it happens to equal the simulator's optics
 * because no calibration error is modelled yet; when it is, this is the single
 * place the two diverge, and nothing downstream needs to change.
 */
export function cameraStateFrom(config: SimulationConfig): CameraState {
  const width = config.camera.width;
  const height = config.camera.height;
  const fx = width / 2 / Math.tan(config.camera.horizontalFov / 2);
  const principal = config.camera.principalPoint;

  return {
    intrinsics: {
      focalLengthX: pixels(fx),
      focalLengthY: pixels(fx),
      principalPointX: pixels(principal?.x ?? width / 2),
      principalPointY: pixels(principal?.y ?? height / 2),
      radialDistortion: [0, 0, 0],
      tangentialDistortion: [0, 0],
    },
    width: pixels(width),
    height: pixels(height),
    horizontalFov: radians(config.camera.horizontalFov),
    verticalFov: radians(2 * Math.atan(height / 2 / fx)),
    frameRate: hertz(config.camera.frameRate),
    exposure: seconds(config.camera.exposure),
    gain: config.camera.gain,
    mountingRotation: { w: 1, x: 0, y: 0, z: 0 },
    mountingOffset: { x: meters(0), y: meters(0), z: meters(0) },
    regionOfInterest: null,
  };
}

/**
 * Builds the algorithm's view of the mount.
 *
 * Every field comes from the encoder side of the actuator. The mount's true
 * output angle, motor state and backlash take-up are not reachable from here.
 */
export function gimbalStateFrom(
  gimbal: DynamicGimbal,
  config: SimulationConfig,
  time: number,
): GimbalState {
  const measured = gimbal.measuredPointing();
  const pan = config.gimbal.pan;
  const tilt = config.gimbal.tilt;
  const truth = gimbal.axisStates();

  const saturation = (flags: {
    atMinLimit: boolean;
    atMaxLimit: boolean;
    rateSaturated: boolean;
  }): 'none' | 'rate-limit' | 'travel-limit' =>
    flags.atMinLimit || flags.atMaxLimit
      ? 'travel-limit'
      : flags.rateSaturated
        ? 'rate-limit'
        : 'none';

  return {
    sampleTime: seconds(time),
    azimuth: radians(measured.panAngle),
    elevation: radians(measured.tiltAngle),
    azimuthRate: radiansPerSecond(measured.derivedPanRate),
    elevationRate: radiansPerSecond(measured.derivedTiltRate),
    azimuthLimits: {
      minAngle: pan.minAngle,
      maxAngle: pan.maxAngle,
      maxRate: pan.maxRate,
      maxAcceleration: pan.maxAcceleration,
    },
    elevationLimits: {
      minAngle: tilt.minAngle,
      maxAngle: tilt.maxAngle,
      maxRate: tilt.maxRate,
      maxAcceleration: tilt.maxAcceleration,
    },
    // Saturation is an operator-visible property of the drive: a real system
    // reports "this axis is against its stop" without exposing the mechanism.
    azimuthSaturation: saturation(truth.pan.flags),
    elevationSaturation: saturation(truth.tilt.flags),
    latency: seconds(0),
    encoderHealth: normalized(1),
  };
}

export class ClosedLoopRuntime {
  private readonly engine: SimulationEngine;
  private readonly sensor: VirtualCameraSensor;
  private readonly sampler: WorldSampler;
  private readonly instance: AlgorithmInstance<unknown>;
  private readonly camera: CameraState;
  private readonly historyLimit: number;
  private readonly blankPixels: boolean;

  private capturedThrough = -1;
  private previousCommand: ControlCommand | null = null;
  private lastOutput: TrackingOutput<unknown> | null = null;
  private commands: IssuedCommand[] = [];
  private events: LoopEvent[] = [];
  private framesDelivered = 0;
  private blankBuffer: Uint8Array | null = null;
  private readonly onFrame: ClosedLoopOptions['onFrame'];

  constructor(options: ClosedLoopOptions) {
    this.engine = options.engine;
    this.sensor = options.sensor;
    this.sampler = options.sampler;
    this.camera = cameraStateFrom(options.engine.config);
    this.historyLimit = options.historyLimit ?? DEFAULT_HISTORY;
    this.blankPixels = options.blankPixels ?? false;
    this.onFrame = options.onFrame;

    const parsed = options.plugin.manifest.configSchema.parse(options.config);
    this.instance = options.plugin.create({
      config: parsed,
      camera: this.camera,
      gimbal: gimbalStateFrom(options.engine.gimbal, options.engine.config, options.engine.time),
      tickRate: hertz(options.engine.config.tickRate),
      // A fixed, seeded stream. The baseline draws from it zero times — it is
      // fully deterministic — but the contract provides one so a future
      // stochastic algorithm replays exactly rather than reaching for
      // Math.random.
      random: options.random ?? makeSeededUniform(options.engine.config.seed),
      tickBudget: milliseconds(16),
    });
  }

  public get algorithmOutput(): TrackingOutput<unknown> | null {
    return this.lastOutput;
  }

  public get issuedCommands(): readonly IssuedCommand[] {
    return this.commands;
  }

  public get loopEvents(): readonly LoopEvent[] {
    return this.events;
  }

  public get framesProcessed(): number {
    return this.framesDelivered;
  }

  public get cameraState(): CameraState {
    return this.camera;
  }

  public reset(): void {
    this.instance.reset();
    this.capturedThrough = -1;
    this.previousCommand = null;
    this.lastOutput = null;
    this.commands = [];
    this.events = [];
    this.framesDelivered = 0;
  }

  public dispose(): void {
    this.instance.dispose?.();
  }

  /**
   * Advances the world by `ticks` and runs the loop over every frame that fell
   * due, in capture order.
   *
   * The order within one call is fixed and is the whole of the loop's
   * causality:
   *
   * 1. advance the world and the mount from the previous simulation time;
   * 2. find every camera frame whose capture time lies in the interval just
   *    advanced through;
   * 3. for each, in ascending capture time:
   *    a. rasterise it from the state at its own capture instant;
   *    b. hand it to the algorithm with the mount state as measured **now**;
   *    c. take the algorithm's intent;
   *    d. stamp it with the current simulation time — never the capture time;
   *    e. submit it to the mount, which applies its own latency from there;
   *    f. release the frame lease.
   *
   * Step 3f happens in a `finally`, so a detector or filter that throws cannot
   * leak the buffer.
   *
   * A command therefore affects only the mount's *future* evolution: the world
   * has already been advanced past the point where the command was issued.
   */
  public step(ticks = 1): number {
    const tickRate = this.engine.config.tickRate;
    const targetTick = this.engine.tick + ticks;
    let processed = 0;

    // Walk forward frame by frame rather than jumping to the end of the batch.
    //
    // This is what makes the loop independent of how the caller batches ticks.
    // Advancing ten ticks and only then issuing the commands for the frames
    // inside that span would hand the mount every command late, by an amount
    // equal to the batch size — so the same scenario would behave differently
    // headless and on screen, and the display would be part of the control
    // loop. Instead the world is advanced only as far as the next frame's
    // availability, the command is issued there, and the walk continues.
    for (;;) {
      const next = this.nextFrameIndexAfter(this.capturedThrough);
      if (next === null) break;

      const availableTick = Math.round(
        this.availableAt(this.sensor.clock.captureTime(next)) * tickRate,
      );
      if (availableTick > targetTick) break;

      const advanced = this.engine.step(availableTick - this.engine.tick, { beyondDuration: true });
      if (advanced === 0 && availableTick !== this.engine.tick) break;

      const capture = this.sensor.captureFrame(this.sampler, next);
      try {
        const output = this.processFrame(capture.frame, this.engine.time);
        // The interface is told afterwards, and never gets to influence what
        // just happened.
        this.onFrame?.(capture, output);
      } finally {
        capture.release();
      }
      this.capturedThrough = this.sensor.clock.captureTime(next);
      processed += 1;
    }

    // Then run out the rest of the requested interval.
    if (this.engine.tick < targetTick) {
      this.engine.step(targetTick - this.engine.tick, { beyondDuration: true });
    }

    return processed;
  }

  /** Index of the first frame captured strictly after `time`, or `null`. */
  private nextFrameIndexAfter(time: number): number | null {
    const from = time < 0 ? -1e-9 : time;
    // A generous horizon: one second of frames is far more than any single
    // batch, and the search only needs to find the next one.
    const range = this.sensor.clock.framesBetween(from, from + 1);
    return range.count === 0 ? null : range.first;
  }

  /**
   * When a frame becomes available to the software.
   *
   * The first physics tick boundary at or after the capture instant. A frame
   * captured at 16.667 ms under a 200 Hz tick is available at 20 ms.
   *
   * Defined from the capture time alone, deliberately, so it does **not**
   * depend on how the caller batched its ticks. Stamping frames with "the time
   * the current batch ended" would make a command's issue time a function of
   * the display's frame rate: advancing twelve ticks at once would delay three
   * frames' commands to the end of the batch, and the same scenario would give
   * a different result headless and on screen. The interface must not be part
   * of the control loop.
   */
  private availableAt(captureTime: number): number {
    const tickRate = this.engine.config.tickRate;
    const boundary = Math.ceil(captureTime * tickRate - 1e-9) / tickRate;
    return Math.max(boundary, captureTime);
  }

  /** Runs the loop for `seconds` of simulated time. */
  public run(durationSeconds: number): void {
    const ticks = Math.round(durationSeconds * this.engine.config.tickRate);
    for (let index = 0; index < ticks; index += 1) this.step(1);
  }

  private processFrame(frame: CameraSensorFrame, processingTime: number): TrackingOutput<unknown> {
    // The invariant this runtime exists to hold. A frame cannot be processed
    // before it was taken, so a command derived from it cannot predate it.
    const issueTime = Math.max(processingTime, frame.captureTime);

    const delivered = this.blankPixels ? this.blankedFrame(frame) : frame;

    const input: TrackingInput = guardTrackingInput({
      tick: this.engine.tick,
      time: seconds(issueTime),
      frame: delivered,
      camera: this.camera,
      // Encoder state as of the instant the frame became available, not as of
      // the end of whatever batch the caller happened to run — same reason.
      gimbal: gimbalStateFrom(this.engine.gimbal, this.engine.config, issueTime),
      previousCommand: this.previousCommand,
    });

    const output = this.instance.update(input);
    this.lastOutput = output;
    this.framesDelivered += 1;

    const issued = this.submit(output.command, issueTime, frame);

    this.record(this.events, {
      frameId: frame.frameId,
      captureTime: frame.captureTime,
      processedAt: issueTime,
      mode: output.pat.mode,
      commandIssued: issued,
    });

    return output;
  }

  /**
   * Turns an intent into a physical command.
   *
   * The runtime — not the algorithm — supplies the time, obtains the id from
   * the mount, and lets the mount clamp to travel. A `hold` intent issues
   * nothing at all, which leaves the mount on whatever it was last told; that
   * is what holding means for a position servo.
   */
  private submit(
    intent: CommandIntent | null,
    issueTime: number,
    frame: CameraSensorFrame,
  ): boolean {
    if (intent === null || intent.kind === 'hold') {
      this.previousCommand =
        intent === null ? this.previousCommand : { kind: 'hold', issuedAt: seconds(issueTime) };
      return false;
    }

    const command = this.engine.gimbal.commandPosition(intent.azimuth, intent.elevation);

    this.previousCommand = {
      kind: 'position',
      issuedAt: seconds(issueTime),
      azimuth: intent.azimuth,
      elevation: intent.elevation,
    };

    this.record(this.commands, {
      frameId: frame.frameId,
      captureTime: frame.captureTime,
      issuedAt: issueTime,
      azimuth: intent.azimuth,
      elevation: intent.elevation,
      commandId: command.commandId,
    });

    return true;
  }

  /**
   * Replaces the pixels with a flat, valid frame.
   *
   * Used only by the anti-cheat test. The buffer is allocated once and reused,
   * so blanking does not turn a bounded run into an allocating one.
   */
  private blankedFrame(frame: CameraSensorFrame): CameraSensorFrame {
    this.blankBuffer ??= new Uint8Array(frame.width * frame.height);
    return { ...frame, data: this.blankBuffer };
  }

  /** Appends to a bounded history, dropping the oldest entry when full. */
  private record<T>(into: T[], entry: T): void {
    into.push(entry);
    if (into.length > this.historyLimit) into.shift();
  }
}

/**
 * A small seeded uniform generator for the plugin contract.
 *
 * SplitMix32. Independent of the simulator's streams, so swapping the algorithm
 * cannot perturb the scenario (ADR-0004).
 */
function makeSeededUniform(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x9e3779b9) >>> 0;
    let z = state;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
    return ((z ^ (z >>> 15)) >>> 0) / 4294967296;
  };
}
