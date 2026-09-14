/**
 * The pan/tilt mount.
 *
 * Replaces Phase 2's `IdealCameraMount`, which teleported to whatever it was
 * told. This one has mass, limits, play and a delay, and it produces two
 * different answers on purpose:
 *
 *   - the **true** output angle, which is where the camera is really looking
 *     and therefore what forms the image;
 *   - the **measured** angle, which is what the encoder reports and therefore
 *     all a future controller will ever get.
 *
 * Those differ by up to half an encoder count, always. Collapsing them would
 * hand a controller perfect knowledge of its own pointing, which is the one
 * thing a real system never has (ADR-0011).
 *
 * See docs/GIMBAL_MODEL.md.
 */

import type {
  GimbalAxisConfig,
  GimbalCommand,
  GimbalCommandId,
  GimbalCommandRecord,
  GimbalConfig,
} from '@/core/contracts/gimbal';
import { radians, seconds } from '@/core/contracts/units';

import { type AxisState, GimbalAxis, applyDeadband } from './axis';
import { type ActuatorTruth, axisTruthFrom, brandActuatorTruth } from './actuator-truth';
import { GimbalCommandQueue, type PendingCommand } from './command-queue';
import { quantizeAngle, quantizationError } from './encoder';

/**
 * Torque disturbance injected at an axis, in rad/s^2.
 *
 * An insertion point, nothing more. Phase 3 always passes zero; base motion,
 * wind loading and bearing friction are later work, and this exists so that
 * adding them does not mean reopening the servo.
 */
export interface GimbalDisturbance {
  readonly pan: number;
  readonly tilt: number;
}

export const NO_DISTURBANCE: GimbalDisturbance = { pan: 0, tilt: 0 };

/** True pointing at one instant, for image formation. */
export interface TruePointing {
  readonly panAngle: number;
  readonly tiltAngle: number;
  readonly panRate: number;
  readonly tiltRate: number;
}

/** What the encoder reports. Algorithm-safe. */
export interface MeasuredPointing {
  readonly panAngle: number;
  readonly tiltAngle: number;
  /**
   * Rate, differentiated from successive encoder readings rather than sensed.
   *
   * Labelled as derived because it is: there is no tachometer in this model,
   * and a derived rate carries the quantisation of the positions it came from.
   */
  readonly derivedPanRate: number;
  readonly derivedTiltRate: number;
}

/** One entry in the pointing history, recorded at a tick boundary. */
interface PointingSample {
  time: number;
  panAngle: number;
  tiltAngle: number;
  panRate: number;
  tiltRate: number;
  /** Encoder reading at this instant. */
  measuredPan: number;
  measuredTilt: number;
  /** Difference of successive encoder readings. See {@link MeasuredPointing}. */
  derivedPanRate: number;
  derivedTiltRate: number;
}

/**
 * How many tick boundaries of pointing history to keep.
 *
 * A camera frame may be due anywhere inside the interval the engine just
 * stepped, and the scheduler's catch-up ceiling is 240 ticks, so a little over
 * that covers the worst case with room to spare. Bounded because an unbounded
 * history of a stateful actuator is a memory leak that only shows up on long
 * runs.
 */
const POINTING_HISTORY_CAPACITY = 512;

export class DynamicGimbal {
  public readonly config: GimbalConfig;
  public readonly pan: GimbalAxis;
  public readonly tilt: GimbalAxis;

  private readonly queue = new GimbalCommandQueue();
  private currentTime = 0;
  private lastAppliedCommand: GimbalCommandRecord | null = null;

  /** Ring of pointing samples at tick boundaries, for between-tick capture. */
  private readonly history: PointingSample[] = [];
  private historyStart = 0;
  private historyCount = 0;

  constructor(config: GimbalConfig) {
    this.config = config;
    this.pan = new GimbalAxis(config.pan);
    this.tilt = new GimbalAxis(config.tilt);
    this.recordPointing();
  }

  public get time(): number {
    return this.currentTime;
  }

  /** Commands waiting for their due time. */
  public get pendingCommands(): readonly PendingCommand[] {
    return this.queue.pendingCommands;
  }

  public get lastApplied(): GimbalCommandRecord | null {
    return this.lastAppliedCommand;
  }

  /**
   * Issues a position command.
   *
   * The command is queued, not applied: it becomes active at
   * `issuedAt + commandLatency`, in simulated time. A command issued while the
   * run is paused therefore changes nothing until the run advances, which is
   * the physically honest answer — a stationary mount does not move because
   * someone typed a number.
   */
  public commandPosition(requestedPan: number, requestedTilt: number): GimbalCommand {
    if (!Number.isFinite(requestedPan) || !Number.isFinite(requestedTilt)) {
      throw new RangeError(
        `Gimbal command must be finite, received pan=${String(requestedPan)} tilt=${String(requestedTilt)}`,
      );
    }

    const command: GimbalCommand = {
      kind: 'position',
      commandId: this.queue.allocateId(),
      issuedAt: seconds(this.currentTime),
      requestedPan: radians(requestedPan),
      requestedTilt: radians(requestedTilt),
    };
    this.queue.enqueue(command, this.config.commandLatency);
    return command;
  }

  /**
   * The most recently *requested* target, in-flight commands included.
   *
   * Not the same as the axis setpoint, which is the most recently *applied*
   * one. With a transport delay they differ for exactly as long as the delay
   * lasts, and which of the two a relative command builds on is a real
   * behavioural choice — see {@link nudge}.
   */
  private latestRequested(): { pan: number; tilt: number } {
    const queued = this.queue.pendingCommands;
    const newest = queued.length === 0 ? undefined : queued[queued.length - 1];
    return newest === undefined
      ? { pan: this.pan.setpoint, tilt: this.tilt.setpoint }
      : { pan: newest.command.requestedPan, tilt: newest.command.requestedTilt };
  }

  /**
   * Issues a command relative to the latest requested position.
   *
   * Relative to what was last *asked for*, not to where the mount currently
   * is — which matters as soon as the latency is non-zero. An operator jogging
   * the mount with a step control expects six presses to move six steps; if
   * each press were measured from the applied setpoint, every press issued
   * inside one latency window would request the same angle and five of the six
   * would be silently discarded.
   *
   * The accumulated target is clamped to travel here as well as when the
   * command is applied. Without that, jogging into a stop would wind the
   * requested angle up indefinitely and the operator would then have to jog
   * all the way back down before the mount moved at all.
   */
  public nudge(deltaPan: number, deltaTilt: number): GimbalCommand {
    const from = this.latestRequested();
    return this.commandPosition(
      clampToAxis(from.pan + deltaPan, this.config.pan),
      clampToAxis(from.tilt + deltaTilt, this.config.tilt),
    );
  }

  /**
   * Advances the mechanism to `targetTime`.
   *
   * Commands that fall due inside the interval are applied at their **exact**
   * due time, by splitting the integration there:
   *
   * ```
   *   integrate(cursor -> dueAt); applySetpoint; cursor = dueAt
   * ```
   *
   * A 23 ms latency under a 5 ms tick therefore stays 23 ms rather than being
   * rounded to 20 or 25. The cost is that sub-steps have unequal lengths, so
   * the discrete response is not bit-identical to one taken in uniform steps;
   * that is inherent to representing latency exactly, it is deterministic
   * because the split points are a function of the command times, and the
   * alternative is a mount whose delay silently depends on the tick rate.
   *
   * @throws {RangeError} when asked to move backwards.
   */
  public advanceTo(targetTime: number, disturbance: GimbalDisturbance = NO_DISTURBANCE): void {
    if (!Number.isFinite(targetTime)) {
      throw new RangeError(`Gimbal target time must be finite, received ${String(targetTime)}`);
    }
    if (targetTime < this.currentTime) {
      throw new RangeError(
        `Gimbal cannot run backwards: at ${String(this.currentTime)} s, asked for ${String(targetTime)} s`,
      );
    }
    void disturbance; // Always zero in Phase 3; see GimbalDisturbance.

    let cursor = this.currentTime;
    for (const pending of this.queue.takeDue(targetTime)) {
      // Clamp forward: a command already overdue applies at the start of the
      // interval rather than in the past.
      const applyAt = Math.max(pending.dueAt, cursor);
      this.integrate(applyAt - cursor);
      cursor = applyAt;
      this.applyCommand(pending, applyAt);
    }

    this.integrate(targetTime - cursor);
    this.currentTime = targetTime;
    this.recordPointing();
  }

  private integrate(dt: number): void {
    if (dt <= 0) return;
    this.pan.advance(dt);
    this.tilt.advance(dt);
  }

  private applyCommand(pending: PendingCommand, appliedAt: number): void {
    const { command } = pending;
    const panClamped = this.pan.setSetpoint(command.requestedPan);
    const tiltClamped = this.tilt.setSetpoint(command.requestedTilt);

    this.lastAppliedCommand = {
      command,
      dueAt: seconds(pending.dueAt),
      appliedAt: seconds(appliedAt),
      acceptedPan: radians(this.pan.setpoint),
      acceptedTilt: radians(this.tilt.setpoint),
      panClamped,
      tiltClamped,
    };
  }

  /** True pointing now. Drives image formation. */
  public truePointing(): TruePointing {
    const pan = this.pan.state();
    const tilt = this.tilt.state();
    return {
      panAngle: pan.outputAngle,
      tiltAngle: tilt.outputAngle,
      panRate: pan.outputRate,
      tiltRate: tilt.outputRate,
    };
  }

  /** What the encoder reports now. Algorithm-safe. */
  public measuredPointing(): MeasuredPointing {
    const latest = this.historyAt(this.historyCount - 1);
    return {
      panAngle: latest.measuredPan,
      tiltAngle: latest.measuredTilt,
      derivedPanRate: latest.derivedPanRate,
      derivedTiltRate: latest.derivedTiltRate,
    };
  }

  /**
   * True pointing at an arbitrary time inside the retained history.
   *
   * A camera frame due at 16.667 ms falls between the actuator states at 15 and
   * 20 ms, and the actuator is stateful, so unlike a trajectory it cannot
   * simply be evaluated there. The two bracketing samples are interpolated
   * **linearly**.
   *
   * Linearly, not along the shortest arc: these are *bounded joint*
   * coordinates, not free bearings. The axis has hard stops and physically
   * cannot take the short way round through them, so wrapping the
   * interpolation would invent a motion the mechanism cannot make. World
   * bearings, which do wrap, use shortest-path interpolation elsewhere — the
   * difference is deliberate.
   *
   * Times outside the retained history clamp to its ends rather than
   * extrapolating, since extrapolating a servo response would invent motion.
   */
  public truePointingAt(time: number): TruePointing {
    if (this.historyCount === 0) return this.truePointing();

    const first = this.historyAt(0);
    const last = this.historyAt(this.historyCount - 1);
    if (time <= first.time) return toPointing(first);
    if (time >= last.time) return toPointing(last);

    let low = 0;
    let high = this.historyCount - 1;
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (this.historyAt(mid).time <= time) low = mid;
      else high = mid;
    }

    const earlier = this.historyAt(low);
    const later = this.historyAt(high);
    const span = later.time - earlier.time;
    if (span <= 0) return toPointing(later);

    const alpha = (time - earlier.time) / span;
    return {
      panAngle: earlier.panAngle + (later.panAngle - earlier.panAngle) * alpha,
      tiltAngle: earlier.tiltAngle + (later.tiltAngle - earlier.tiltAngle) * alpha,
      panRate: earlier.panRate + (later.panRate - earlier.panRate) * alpha,
      tiltRate: earlier.tiltRate + (later.tiltRate - earlier.tiltRate) * alpha,
    };
  }

  /**
   * Encoder reading at `time`.
   *
   * The angle is the quantised interpolated truth — a reading taken at that
   * instant. The rate is the one already differenced from successive readings
   * at the bracketing samples, carried forward rather than re-differentiated,
   * because a controller cannot difference readings it did not take.
   */
  public measuredPointingAt(time: number): MeasuredPointing {
    const truth = this.truePointingAt(time);
    const nearest = this.sampleNearOrAt(time);
    return {
      panAngle: quantizeAngle(truth.panAngle, this.config.pan.encoderResolution),
      tiltAngle: quantizeAngle(truth.tiltAngle, this.config.tilt.encoderResolution),
      derivedPanRate: nearest.derivedPanRate,
      derivedTiltRate: nearest.derivedTiltRate,
    };
  }

  /** Latest history sample at or before `time`. */
  private sampleNearOrAt(time: number): PointingSample {
    if (this.historyCount === 0) throw new Error('Gimbal pointing history is empty');
    let low = 0;
    let high = this.historyCount - 1;
    if (time <= this.historyAt(0).time) return this.historyAt(0);
    while (high - low > 1) {
      const mid = (low + high) >> 1;
      if (this.historyAt(mid).time <= time) low = mid;
      else high = mid;
    }
    return this.historyAt(high).time <= time ? this.historyAt(high) : this.historyAt(low);
  }

  /**
   * What the mount is doing, in the terms an operator thinks in.
   *
   * Derived from actuator state, not decorated onto it. The thresholds are
   * properties of the instrument rather than chosen numbers: an axis is
   * *holding* when it is inside its own deadband and moving by less than half
   * an encoder count per tick — that is, when it cannot be seen to move at all.
   *
   * @param tickSeconds the physics step, which is what "per tick" is measured
   *   against.
   */
  public servoPhase(tickSeconds: number): 'active' | 'settling' | 'holding' {
    if (this.queue.size > 0) return 'active';

    const pan = this.pan.state();
    const tilt = this.tilt.state();

    // An axis is "there" once it is neither being driven nor able to observe
    // that it should be. The quantity that decides the first half is the servo's
    // own demand — the error *after* the deadband — not the raw error: a
    // subtractive deadband parks the axis anywhere within a band of the
    // setpoint, so a settled axis normally carries a residual error of exactly
    // the deadband width and is nonetheless done moving.
    //
    // Comparing that demand against half an encoder count covers the other half.
    // Without it an ideal axis, whose deadband is zero, could never report
    // holding: a second-order response approaches its setpoint asymptotically
    // and arrives exactly only in the limit.
    const panDemand = Math.abs(
      applyDeadband(pan.setpoint - pan.motorAngle, this.config.pan.deadband),
    );
    const tiltDemand = Math.abs(
      applyDeadband(tilt.setpoint - tilt.motorAngle, this.config.tilt.deadband),
    );

    const beingDriven =
      panDemand > this.config.pan.encoderResolution / 2 ||
      tiltDemand > this.config.tilt.encoderResolution / 2;
    if (beingDriven) return 'active';

    const visiblyMoving =
      Math.abs(pan.outputRate) * tickSeconds > this.config.pan.encoderResolution / 2 ||
      Math.abs(tilt.outputRate) * tickSeconds > this.config.tilt.encoderResolution / 2;
    return visiblyMoving ? 'settling' : 'holding';
  }

  /** The full interior, for the privileged debug panel and for evaluation. */
  public truth(): ActuatorTruth {
    const panState = this.pan.state();
    const tiltState = this.tilt.state();
    return brandActuatorTruth({
      time: seconds(this.currentTime),
      pan: axisTruthFrom(
        panState,
        quantizationError(panState.outputAngle, this.config.pan.encoderResolution),
      ),
      tilt: axisTruthFrom(
        tiltState,
        quantizationError(tiltState.outputAngle, this.config.tilt.encoderResolution),
      ),
      pendingCommands: [...this.queue.pendingCommands],
      lastApplied: this.lastAppliedCommand,
    });
  }

  /**
   * Returns everything to its initial state.
   *
   * Everything means everything: axis angles and rates, motor rates, the
   * backlash memory, saturation flags, the command queue, the id counter, the
   * applied-command record, the clock and the pointing history. A reset that
   * left any of those behind would make the next run depend on the previous
   * one, which is precisely what reset exists to prevent.
   */
  public reset(): void {
    this.pan.reset();
    this.tilt.reset();
    this.queue.reset();
    this.currentTime = 0;
    this.lastAppliedCommand = null;
    this.historyStart = 0;
    this.historyCount = 0;
    this.history.length = 0;
    this.recordPointing();
  }

  /** Raw axis states, for tests and the debug panel. */
  public axisStates(): { readonly pan: AxisState; readonly tilt: AxisState } {
    return { pan: this.pan.state(), tilt: this.tilt.state() };
  }

  /** Ids of commands issued so far, for replay accounting. */
  public allocateCommandId(): GimbalCommandId {
    return this.queue.allocateId();
  }

  private historyAt(index: number): PointingSample {
    return this.history[(this.historyStart + index) % POINTING_HISTORY_CAPACITY]!;
  }

  private recordPointing(): void {
    const pan = this.pan.state();
    const tilt = this.tilt.state();

    const measuredPan = quantizeAngle(pan.outputAngle, this.config.pan.encoderResolution);
    const measuredTilt = quantizeAngle(tilt.outputAngle, this.config.tilt.encoderResolution);

    // Rate as a controller would obtain it: the difference of two successive
    // encoder readings, divided by the interval between them. It therefore
    // carries the quantisation of both readings, which is exactly the noise a
    // real differentiated encoder rate has.
    const previous = this.historyCount > 0 ? this.historyAt(this.historyCount - 1) : null;
    const interval = previous === null ? 0 : this.currentTime - previous.time;
    const derivedPanRate =
      previous === null || interval <= 0 ? 0 : (measuredPan - previous.measuredPan) / interval;
    const derivedTiltRate =
      previous === null || interval <= 0 ? 0 : (measuredTilt - previous.measuredTilt) / interval;

    const sample: PointingSample = {
      time: this.currentTime,
      panAngle: pan.outputAngle,
      tiltAngle: tilt.outputAngle,
      panRate: pan.outputRate,
      tiltRate: tilt.outputRate,
      measuredPan,
      measuredTilt,
      derivedPanRate,
      derivedTiltRate,
    };

    if (this.historyCount < POINTING_HISTORY_CAPACITY) {
      const index = (this.historyStart + this.historyCount) % POINTING_HISTORY_CAPACITY;
      this.history[index] = sample;
      this.historyCount += 1;
      return;
    }

    this.history[this.historyStart] = sample;
    this.historyStart = (this.historyStart + 1) % POINTING_HISTORY_CAPACITY;
  }
}

const clampToAxis = (angle: number, axis: GimbalAxisConfig): number =>
  angle < axis.minAngle ? axis.minAngle : angle > axis.maxAngle ? axis.maxAngle : angle;

const toPointing = (sample: PointingSample): TruePointing => ({
  panAngle: sample.panAngle,
  tiltAngle: sample.tiltAngle,
  panRate: sample.panRate,
  tiltRate: sample.tiltRate,
});
