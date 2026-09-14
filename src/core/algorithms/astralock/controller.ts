/**
 * Prediction-to-actuation pointing control: feedback plus motion feed-forward.
 *
 * An outer loop around the mount's own position servo, which it never bypasses.
 * Per axis, at issue time t:
 *
 * ```
 *   h    = commandLatency + servoLag                    the controller's belief, not the simulator's
 *   θ̂(t)   target bearing estimated at issue time
 *   θ̂(t+h) the same target predicted to when the command takes effect
 *   g      measured (encoder) pose at issue time
 *
 *   e    = θ̂(t) − g                                     current estimated pointing error
 *   u_fb = kp·e + ki·∫e dt + kd·ė_filtered              feedback, on the current error only
 *   u_ff = θ̂(t+h) − θ̂(t)                               target motion over the horizon only
 *
 *   setpoint = clamp_travel(g + clamp(u_fb + u_ff, ±correctionLimit))
 * ```
 *
 * **Why nothing is counted twice.** Feedback sees only where the target is now
 * relative to where the mount is now. Feed-forward sees only how far the target
 * will move between now and when the command acts — a difference of two target
 * bearings, independent of the mount. A stationary target makes u_ff exactly
 * zero; a perfectly aligned mount makes e zero while u_ff still leads a moving
 * target. The integral absorbs whatever the belief about h gets wrong.
 *
 * **Anti-windup.** Conditional integration: the integral grows only while the
 * total command is not saturated in the direction the error would push it —
 * saturation of the correction limit or of the travel stops both count.
 *
 * Simulation time only; no wall clock, no mount truth. See ADR-0018.
 */

import { shortestAngle } from '../baseline/angles';

export interface AxisControllerConfig {
  readonly kp: number;
  readonly ki: number;
  readonly kd: number;
  readonly derivativeFilterTau: number;
  readonly integralLimit: number;
  readonly correctionLimit: number;
}

export interface PointingControllerConfig {
  readonly pan: AxisControllerConfig;
  readonly tilt: AxisControllerConfig;
  readonly commandLatency: number;
  readonly servoLag: number;
  readonly feedforward: boolean;
}

export interface Bearing2 {
  readonly azimuth: number;
  readonly elevation: number;
}

export interface TravelLimits {
  readonly azimuth: { readonly minAngle: number; readonly maxAngle: number };
  readonly elevation: { readonly minAngle: number; readonly maxAngle: number };
}

export interface PointingCommand {
  readonly setpointAzimuth: number;
  readonly setpointElevation: number;
  readonly feedbackAzimuth: number;
  readonly feedbackElevation: number;
  readonly feedforwardAzimuth: number;
  readonly feedforwardElevation: number;
  readonly saturatedAzimuth: boolean;
  readonly saturatedElevation: boolean;
}

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;

class AxisLoop {
  private integral = 0;
  private previousError: number | null = null;
  private filteredDerivative = 0;

  constructor(private readonly config: AxisControllerConfig) {}

  public reset(): void {
    this.integral = 0;
    this.previousError = null;
    this.filteredDerivative = 0;
  }

  public get integralTerm(): number {
    return this.integral;
  }

  public step(
    error: number,
    feedforward: number,
    dt: number,
    measured: number,
    travel: { readonly minAngle: number; readonly maxAngle: number },
  ): { feedback: number; setpoint: number; saturated: boolean } {
    const c = this.config;
    const usable = Number.isFinite(dt) && dt > 0;

    let derivative = 0;
    if (usable && this.previousError !== null) {
      const raw = (error - this.previousError) / dt;
      if (c.derivativeFilterTau > 0) {
        this.filteredDerivative +=
          (dt / (c.derivativeFilterTau + dt)) * (raw - this.filteredDerivative);
      } else {
        this.filteredDerivative = raw;
      }
      derivative = c.kd * this.filteredDerivative;
    }

    const shape = (integral: number) => {
      const feedback = c.kp * error + integral + derivative;
      const demand = feedback + feedforward;
      const total = clamp(demand, -c.correctionLimit, c.correctionLimit);
      const unclamped = measured + total;
      const setpoint = clamp(unclamped, travel.minAngle, travel.maxAngle);
      return { feedback, setpoint, saturated: total !== demand || setpoint !== unclamped };
    };

    if (usable && c.ki !== 0) {
      const provisional = shape(this.integral);
      const contribution = c.ki * error * dt;
      const demanded = provisional.feedback + feedforward;
      const pushesFurtherOut =
        provisional.saturated &&
        ((demanded > 0 && contribution > 0) || (demanded < 0 && contribution < 0));
      if (!pushesFurtherOut) {
        this.integral = clamp(this.integral + contribution, -c.integralLimit, c.integralLimit);
      }
    }
    if (usable) this.previousError = error;

    return shape(this.integral);
  }
}

export class PointingController {
  private readonly pan: AxisLoop;
  private readonly tilt: AxisLoop;

  constructor(private readonly config: PointingControllerConfig) {
    this.pan = new AxisLoop(config.pan);
    this.tilt = new AxisLoop(config.tilt);
  }

  /** The prediction horizon h, seconds. */
  public get horizon(): number {
    return this.config.commandLatency + this.config.servoLag;
  }

  public get integrals(): { azimuth: number; elevation: number } {
    return { azimuth: this.pan.integralTerm, elevation: this.tilt.integralTerm };
  }

  public reset(): void {
    this.pan.reset();
    this.tilt.reset();
  }

  public step(input: {
    readonly target: Bearing2;
    readonly targetAtHorizon: Bearing2;
    readonly measured: Bearing2;
    readonly dt: number;
    readonly limits: TravelLimits;
  }): PointingCommand {
    const { target, targetAtHorizon, measured, dt, limits } = input;
    const errorAz = shortestAngle(target.azimuth, measured.azimuth);
    const errorEl = target.elevation - measured.elevation;
    const ffAz = this.config.feedforward
      ? shortestAngle(targetAtHorizon.azimuth, target.azimuth)
      : 0;
    const ffEl = this.config.feedforward ? targetAtHorizon.elevation - target.elevation : 0;

    const az = this.pan.step(errorAz, ffAz, dt, measured.azimuth, limits.azimuth);
    const el = this.tilt.step(errorEl, ffEl, dt, measured.elevation, limits.elevation);

    return {
      setpointAzimuth: az.setpoint,
      setpointElevation: el.setpoint,
      feedbackAzimuth: az.feedback,
      feedbackElevation: el.feedback,
      feedforwardAzimuth: ffAz,
      feedforwardElevation: ffEl,
      saturatedAzimuth: az.saturated,
      saturatedElevation: el.saturated,
    };
  }
}
