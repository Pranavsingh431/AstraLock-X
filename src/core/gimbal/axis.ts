/**
 * One pan or tilt axis, as a physical mechanism.
 *
 * The chain, in order, and each stage is separately observable:
 *
 * ```
 *   setpoint --> deadband --> servo --> accel limit --> rate limit
 *            --> motor angle --> travel stop --> backlash --> output angle
 * ```
 *
 * The **output** angle is what the camera is bolted to, so it is what forms the
 * image. The **motor** angle is what the servo controls. Between them sits the
 * play in the gearing, which is why a reversal moves the motor for a while
 * before the camera notices.
 *
 * Everything here is driven by simulated time. There is no `performance.now`,
 * no `setTimeout` and no frame callback: a run must produce the same trajectory
 * on a fast machine and a slow one.
 *
 * See docs/GIMBAL_MODEL.md.
 */

import type { GimbalAxisConfig } from '@/core/contracts/gimbal';

import { ServoTransitionCache } from './servo-transition';

/** Why an axis is not doing what it was asked. */
export interface AxisSaturationFlags {
  readonly atMinLimit: boolean;
  readonly atMaxLimit: boolean;
  readonly rateSaturated: boolean;
  readonly accelerationSaturated: boolean;
}

/** Complete mechanical state of one axis. Privileged. */
export interface AxisState {
  /** Servo target, after clamping to travel. */
  readonly setpoint: number;
  /** Motor-side angle, what the servo controls. */
  readonly motorAngle: number;
  readonly motorRate: number;
  /** Load-side angle, what the camera is bolted to. Forms the image. */
  readonly outputAngle: number;
  /**
   * Rate of the output.
   *
   * Zero while the motor is crossing the backlash gap, because the load really
   * is stationary then — that is the whole point of modelling the play.
   */
  readonly outputRate: number;
  /** Servo demand before the acceleration limit. */
  readonly commandedAcceleration: number;
  /** Servo demand after it. */
  readonly appliedAcceleration: number;
  readonly flags: AxisSaturationFlags;
}

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

/**
 * Dead-zone nonlinearity.
 *
 * Subtractive rather than a plain threshold: inside the band the servo sees no
 * error at all, and outside it the error grows continuously from zero. A
 * threshold that switched from 0 to the full error would step the demanded
 * acceleration at the boundary, which is a discontinuity the integrator would
 * turn into a visible tick in the image every time the axis crossed it.
 */
export function applyDeadband(error: number, deadband: number): number {
  if (deadband <= 0) return error;
  if (error > deadband) return error - deadband;
  if (error < -deadband) return error + deadband;
  return 0;
}

/**
 * Play (backlash) operator.
 *
 * The load is dragged by the motor but may sit anywhere within a gap of total
 * width `backlash` centred on it:
 *
 * ```
 *   output' = clamp(output, motor - backlash/2, motor + backlash/2)
 * ```
 *
 * Moving in one direction the load rides the leading face of the gap and
 * follows exactly. On a reversal the motor crosses the whole gap — `backlash`
 * radians — before touching the other face, and during that crossing the load
 * does not move at all. That is genuine hysteresis: the output depends on the
 * direction of approach, not merely on the current motor angle.
 *
 * With `backlash = 0` the clamp collapses to `output = motor`, which is exactly
 * direct coupling, with no special case needed.
 */
export function applyBacklash(outputAngle: number, motorAngle: number, backlash: number): number {
  if (backlash <= 0) return motorAngle;
  const half = backlash / 2;
  return clamp(outputAngle, motorAngle - half, motorAngle + half);
}

export class GimbalAxis {
  public readonly config: GimbalAxisConfig;

  private setpointAngle: number;
  private motorAngle: number;
  private motorRate: number;
  private outputAngle: number;
  private outputRate = 0;
  private commandedAcceleration = 0;
  private appliedAcceleration = 0;
  private rateSaturated = false;
  private accelerationSaturated = false;

  /** `2*pi*f`, precomputed because it is used twice per step. */
  private readonly omega: number;

  /** Closed-form step for the unsaturated path, cached on `dt`. */
  private readonly transition: ServoTransitionCache;

  constructor(config: GimbalAxisConfig) {
    this.config = config;
    this.omega = 2 * Math.PI * config.naturalFrequency;
    this.transition = new ServoTransitionCache(this.omega, config.dampingRatio);

    this.setpointAngle = clamp(config.initialAngle, config.minAngle, config.maxAngle);
    this.motorAngle = this.setpointAngle;
    this.motorRate = 0;
    // Starts with the gearing already taken up, which is what a mount that has
    // been driven to its start position would look like.
    this.outputAngle = this.motorAngle;
  }

  /** Returns the axis to the state it was constructed in. */
  public reset(): void {
    this.setpointAngle = clamp(
      this.config.initialAngle,
      this.config.minAngle,
      this.config.maxAngle,
    );
    this.motorAngle = this.setpointAngle;
    this.motorRate = 0;
    this.outputAngle = this.motorAngle;
    this.outputRate = 0;
    this.commandedAcceleration = 0;
    this.appliedAcceleration = 0;
    this.rateSaturated = false;
    this.accelerationSaturated = false;
  }

  /**
   * Sets the servo target, clamped to travel.
   *
   * @returns whether the request lay outside the mechanism's reach. Clamping
   * silently would let an operator believe a mount can point somewhere it
   * cannot.
   */
  public setSetpoint(angle: number): boolean {
    if (!Number.isFinite(angle)) {
      throw new RangeError(`Axis setpoint must be finite, received ${String(angle)}`);
    }
    const clamped = clamp(angle, this.config.minAngle, this.config.maxAngle);
    this.setpointAngle = clamped;
    return clamped !== angle;
  }

  public get setpoint(): number {
    return this.setpointAngle;
  }

  /**
   * Integrates one interval.
   *
   * Two paths, chosen by whether the mechanism is against a limit.
   *
   * **Unsaturated — exact.** While no limit binds, the axis is a linear
   * time-invariant second-order system and the step is taken with its closed-
   * form transition matrix (see `servo-transition.ts`). There is no
   * discretisation error at all: the result is the analytic solution evaluated
   * at the step boundary.
   *
   * The deadband does not spoil this. Outside the band the subtractive dead
   * zone is affine in the angle, so the dynamics are still LTI about a shifted
   * setpoint `setpoint − B·sign(e)`; inside it the servo demand is zero and the
   * axis coasts under damping alone, which is the same transition with the
   * shifted setpoint placed at the current angle.
   *
   * **Saturated — clamped semi-implicit Euler.** When the acceleration or rate
   * limit binds the system is no longer linear and there is no closed form, so
   * the step falls back to
   *
   * ```
   *   a      = clamp(a_raw, +/- maxAcceleration)
   *   rate'  = clamp(motorRate + a * dt, +/- maxRate)
   *   angle' = clamp(motorAngle + rate' * dt, minAngle, maxAngle)
   * ```
   *
   * which is first-order accurate. That is acceptable where it applies: a
   * saturated axis is moving at a constant clamped acceleration or a constant
   * clamped rate, and Euler integrates both of those exactly in the rate.
   *
   * Saturation is decided from the demand at the start of the step and
   * re-checked against the rate the exact step would produce. For a decaying
   * second-order response the demanded acceleration is largest at the beginning
   * of a step, so an interval that is unsaturated at both ends is unsaturated
   * throughout in every case the bundled profiles produce.
   *
   * `dt` is a parameter rather than a constant because a command that becomes
   * due mid-tick splits the tick in two; see `DynamicGimbal`.
   *
   * @throws {RangeError} for a negative or non-finite interval.
   */
  public advance(dt: number): void {
    if (!Number.isFinite(dt) || dt < 0) {
      throw new RangeError(`Axis step must be finite and non-negative, received ${String(dt)}`);
    }
    if (dt === 0) return;

    const error = applyDeadband(this.setpointAngle - this.motorAngle, this.config.deadband);

    const rawAcceleration =
      this.omega * this.omega * error - 2 * this.config.dampingRatio * this.omega * this.motorRate;
    // `maxAcceleration` and `maxRate` are branded units; the bounds are plain
    // numbers derived from them, which is what `clamp` works in.
    const accelerationBound: number = this.config.maxAcceleration;
    const rateBound: number = this.config.maxRate;
    const limitedAcceleration = clamp(rawAcceleration, -accelerationBound, accelerationBound);

    this.commandedAcceleration = rawAcceleration;
    this.appliedAcceleration = limitedAcceleration;
    this.accelerationSaturated = limitedAcceleration !== rawAcceleration;

    let proposedAngle: number;

    if (!this.accelerationSaturated) {
      // The setpoint the linear system is actually driving towards: the real
      // one, less whatever the dead zone swallows.
      const effectiveSetpoint = this.motorAngle + error;
      const phi = this.transition.at(dt);
      const e0 = this.motorAngle - effectiveSetpoint;
      const v0 = this.motorRate;

      const exactAngle = effectiveSetpoint + phi.phi11 * e0 + phi.phi12 * v0;
      const exactRate = phi.phi21 * e0 + phi.phi22 * v0;

      // The demand was within the acceleration limit at the *start* of the
      // step, but the linear solution may still ask for more than the
      // mechanism has partway through — most obviously on the step where a
      // fast-moving axis first comes out of acceleration saturation, where the
      // damping term is large. Two further checks close that gap: the mean
      // acceleration the step actually implies, and the demand at the far end.
      // A hard acceleration limit is a property of the plant, so the linear
      // path may only be used where the plant could genuinely have followed it.
      const meanAcceleration = (exactRate - v0) / dt;
      const endError = applyDeadband(this.setpointAngle - exactAngle, this.config.deadband);
      const endAcceleration =
        this.omega * this.omega * endError - 2 * this.config.dampingRatio * this.omega * exactRate;

      const exceedsAcceleration =
        Math.abs(meanAcceleration) > accelerationBound ||
        Math.abs(endAcceleration) > accelerationBound;
      const exceedsRate = Math.abs(exactRate) > rateBound;

      if (exceedsAcceleration || exceedsRate) {
        // Not a linear interval after all. Take it the clamped way.
        const unlimitedRate = v0 + limitedAcceleration * dt;
        const limitedRate = clamp(unlimitedRate, -rateBound, rateBound);
        this.rateSaturated = limitedRate !== unlimitedRate;
        this.accelerationSaturated = exceedsAcceleration;
        this.appliedAcceleration = clamp(meanAcceleration, -accelerationBound, accelerationBound);
        this.motorRate = limitedRate;
        proposedAngle = this.motorAngle + this.motorRate * dt;
      } else {
        this.rateSaturated = false;
        this.motorRate = exactRate;
        proposedAngle = exactAngle;
      }
    } else {
      const unlimitedRate = this.motorRate + limitedAcceleration * dt;
      const limitedRate = clamp(unlimitedRate, -rateBound, rateBound);
      this.rateSaturated = limitedRate !== unlimitedRate;
      this.motorRate = limitedRate;
      proposedAngle = this.motorAngle + this.motorRate * dt;
    }

    const stoppedAngle = clamp(proposedAngle, this.config.minAngle, this.config.maxAngle);

    if (stoppedAngle !== proposedAngle) {
      // Against a hard stop. Outward momentum is absorbed by the stop rather
      // than accumulating, which is what stops the axis from storing up rate
      // and leaping away the instant it is commanded back inward.
      this.motorRate = 0;
    }
    this.motorAngle = stoppedAngle;

    const previousOutput = this.outputAngle;
    const draggedOutput = applyBacklash(this.outputAngle, this.motorAngle, this.config.backlash);
    // The stop applies to the load too: the camera cannot be beyond the travel
    // even if the remaining play would otherwise carry it there.
    this.outputAngle = clamp(draggedOutput, this.config.minAngle, this.config.maxAngle);
    this.outputRate = (this.outputAngle - previousOutput) / dt;
  }

  public state(): AxisState {
    return {
      setpoint: this.setpointAngle,
      motorAngle: this.motorAngle,
      motorRate: this.motorRate,
      outputAngle: this.outputAngle,
      outputRate: this.outputRate,
      commandedAcceleration: this.commandedAcceleration,
      appliedAcceleration: this.appliedAcceleration,
      flags: {
        // "At the stop" within half an encoder count, not on exact equality. A
        // setpoint clamped to the stop is approached asymptotically and may
        // never cross it, so an exact test would leave the flag dark while the
        // axis sat against its travel limit for the rest of the run.
        atMinLimit: this.outputAngle <= this.config.minAngle + this.config.encoderResolution / 2,
        atMaxLimit: this.outputAngle >= this.config.maxAngle - this.config.encoderResolution / 2,
        rateSaturated: this.rateSaturated,
        accelerationSaturated: this.accelerationSaturated,
      },
    };
  }

  /** Restores a previously captured state. Used by reset and by replay. */
  public restore(state: AxisState): void {
    this.setpointAngle = state.setpoint;
    this.motorAngle = state.motorAngle;
    this.motorRate = state.motorRate;
    this.outputAngle = state.outputAngle;
    this.outputRate = state.outputRate;
    this.commandedAcceleration = state.commandedAcceleration;
    this.appliedAcceleration = state.appliedAcceleration;
    this.rateSaturated = state.flags.rateSaturated;
    this.accelerationSaturated = state.flags.accelerationSaturated;
  }
}
