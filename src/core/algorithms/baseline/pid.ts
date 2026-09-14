/**
 * The outer pointing loop.
 *
 * This is a PID **around the mount's own position servo**, not a replacement
 * for it. The plant this controller sees is already closed-loop: a dynamic
 * gimbal that accepts an absolute angle and moves there over time with its own
 * bandwidth, damping, limits and backlash. So the output here is a *correction
 * to the commanded angle*, not a torque, a rate or an acceleration.
 *
 * ```
 *   estimated bearing ──▶ error against measured pose ──▶ PID ──▶ Δangle
 *                                                                  │
 *   commanded setpoint = measured pose + Δangle ◀──────────────────┘
 * ```
 *
 * Two loops in series like this interact: the outer loop must be slow enough
 * that the inner servo has settled before the outer one reacts again, or the
 * two fight and the mount rings. That is why the baseline gains are modest and
 * why there is no feed-forward — target-rate feed-forward belongs to the robust
 * controller, and adding it here would remove the lag the baseline is supposed
 * to exhibit.
 *
 * See docs/BASELINE_PAT.md.
 */

/** Tuning for one axis. */
export interface PidConfig {
  readonly kp: number;
  readonly ki: number;
  readonly kd: number;
  /** Largest correction the controller may ask for in one step, in radians. */
  readonly outputLimit: number;
  /** Cap on the integral term's own contribution, in radians. */
  readonly integralLimit: number;
  /**
   * Low-pass time constant for the derivative, in seconds.
   *
   * The error signal is a difference of a filtered estimate and a quantised
   * encoder reading, so it carries a step of up to one count. A raw derivative
   * of that is a spike of `count / dt`, which at a 0.02° encoder and a 16.7 ms
   * frame is over 20°/s of phantom rate. Zero disables the filter.
   */
  readonly derivativeFilterTau: number;
}

/** What one PID step produced, with the terms separated for diagnosis. */
export interface PidStep {
  readonly output: number;
  readonly proportional: number;
  readonly integral: number;
  readonly derivative: number;
  readonly saturated: boolean;
}

export class PidController {
  private integral = 0;
  private previousError: number | null = null;
  private filteredDerivative = 0;

  constructor(private readonly config: PidConfig) {}

  public reset(): void {
    this.integral = 0;
    this.previousError = null;
    this.filteredDerivative = 0;
  }

  /** Current integral accumulation, in radians of contribution. */
  public get integralTerm(): number {
    return this.integral;
  }

  /**
   * One control step.
   *
   * **Anti-windup by conditional integration.** The integral is accumulated
   * only when the output is not already saturated in the direction the
   * integral would push it further. That is the cheap, well-understood scheme,
   * and it has the property that matters here: when the mount is commanded
   * somewhere it cannot reach — against a travel stop, or beyond the per-step
   * correction limit — the integral stops growing instead of storing up a
   * demand that has to be unwound before the axis will come back. The integral
   * is additionally hard-capped, so even an unsaturated but persistent error
   * cannot make it unbounded.
   *
   * A non-positive or non-finite `dt` is treated as "no time has passed": the
   * proportional term is returned and the integral and derivative are left
   * alone. Dividing by it would produce an infinite derivative, and skipping
   * the step entirely would drop a real proportional correction.
   */
  public step(error: number, dt: number): PidStep {
    const usable = Number.isFinite(dt) && dt > 0;

    const proportional = this.config.kp * error;

    let derivative = 0;
    if (usable && this.previousError !== null) {
      const raw = (error - this.previousError) / dt;
      if (this.config.derivativeFilterTau > 0) {
        // First-order low pass, discretised: alpha = dt / (tau + dt).
        const alpha = dt / (this.config.derivativeFilterTau + dt);
        this.filteredDerivative += alpha * (raw - this.filteredDerivative);
        derivative = this.config.kd * this.filteredDerivative;
      } else {
        this.filteredDerivative = raw;
        derivative = this.config.kd * raw;
      }
    }

    // Provisional output without any new integral, to decide whether adding to
    // the integral would push further into saturation.
    const withoutNewIntegral = proportional + this.integral + derivative;

    if (usable && this.config.ki !== 0) {
      const contribution = this.config.ki * error * dt;
      const pushesFurtherOut =
        (withoutNewIntegral >= this.config.outputLimit && contribution > 0) ||
        (withoutNewIntegral <= -this.config.outputLimit && contribution < 0);

      if (!pushesFurtherOut) {
        this.integral = clamp(
          this.integral + contribution,
          -this.config.integralLimit,
          this.config.integralLimit,
        );
      }
    }

    if (usable) this.previousError = error;

    const raw = proportional + this.integral + derivative;
    const output = clamp(raw, -this.config.outputLimit, this.config.outputLimit);

    return {
      output,
      proportional,
      integral: this.integral,
      derivative,
      saturated: output !== raw,
    };
  }
}

const clamp = (value: number, low: number, high: number): number =>
  value < low ? low : value > high ? high : value;
