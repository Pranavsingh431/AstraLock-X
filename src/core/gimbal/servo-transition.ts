/**
 * Exact discrete transition for a damped second-order servo.
 *
 * The axis obeys
 *
 * ```
 *   x'' + 2·ζ·ω·x' + ω²·x = ω²·u
 * ```
 *
 * and while `u` is constant this is linear and time-invariant, so it has a
 * closed-form discrete transition: writing the error `e = x − u`, the state
 * `[e, ė]` advances by the matrix exponential `Φ(dt) = exp(A·dt)` with
 * `A = [[0, 1], [−ω², −2ζω]]`. Applying Φ is **exact** — not an approximation
 * that improves with smaller steps, but the analytic answer evaluated at the
 * step boundary.
 *
 * This replaces the semi-implicit Euler integration Phase 3 used on the
 * unsaturated path. That integrator was stable and symplectic, but it was
 * first-order accurate, and at the bundled tick that cost 13.3% of a step in
 * peak transient error on the near-ideal profile and 7.3% on the realistic-lab
 * one — far too much to tune a pointing controller against, because the
 * controller would have been compensating for the integrator rather than for
 * the mechanism. See docs/GIMBAL_MODEL.md and
 * docs/adr/0012-exact-servo-discretisation.md.
 *
 * Three damping regimes need separate expressions. A single formula written
 * for the under-damped case degenerates to 0/0 at ζ = 1 and to the difference
 * of two nearly equal large numbers just past it, so each is handled directly.
 */

/** Rows of the 2x2 transition matrix, in error coordinates. */
export interface ServoTransition {
  readonly phi11: number;
  readonly phi12: number;
  readonly phi21: number;
  readonly phi22: number;
}

/** Band around ζ = 1 treated as critically damped. */
const CRITICAL_BAND = 1e-7;

/**
 * Builds `Φ(dt)` for natural frequency `omega` and damping ratio `zeta`.
 *
 * `omega` is in rad/s (not Hz) and `dt` in seconds.
 */
export function servoTransition(omega: number, zeta: number, dt: number): ServoTransition {
  if (dt === 0) return { phi11: 1, phi12: 0, phi21: 0, phi22: 1 };

  const sigma = zeta * omega;
  const decay = Math.exp(-sigma * dt);

  if (Math.abs(zeta - 1) <= CRITICAL_BAND) {
    // Repeated root at −ω. Φ = e^(−ωt)·[[1 + ωt, t], [−ω²t, 1 − ωt]].
    const wt = omega * dt;
    return {
      phi11: decay * (1 + wt),
      phi12: decay * dt,
      phi21: -decay * omega * omega * dt,
      phi22: decay * (1 - wt),
    };
  }

  if (zeta < 1) {
    // Complex conjugate roots: damped oscillation at ω_d.
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const cos = Math.cos(wd * dt);
    const sin = Math.sin(wd * dt);
    return {
      phi11: decay * (cos + (sigma / wd) * sin),
      phi12: (decay * sin) / wd,
      phi21: (-decay * omega * omega * sin) / wd,
      phi22: decay * (cos - (sigma / wd) * sin),
    };
  }

  // Two distinct real roots. Written with cosh/sinh rather than as a
  // difference of exponentials: for large ζ the two exponentials differ by
  // orders of magnitude and subtracting them loses most of the mantissa.
  const rate = omega * Math.sqrt(zeta * zeta - 1);
  const cosh = Math.cosh(rate * dt);
  const sinh = Math.sinh(rate * dt);
  return {
    phi11: decay * (cosh + (sigma / rate) * sinh),
    phi12: (decay * sinh) / rate,
    phi21: (-decay * omega * omega * sinh) / rate,
    phi22: decay * (cosh - (sigma / rate) * sinh),
  };
}

/**
 * Caches the transition for one axis.
 *
 * `dt` is the fixed tick on almost every step; it differs only when a command
 * falling due mid-tick splits the interval. Recomputing four transcendentals
 * per axis per tick for a value that almost never changes is waste, so the
 * last one is kept. A single-entry cache is enough: a split tick produces two
 * unequal sub-steps and then returns to the fixed tick, so a larger cache
 * would buy nothing.
 */
export class ServoTransitionCache {
  private cachedDt = Number.NaN;
  private cached: ServoTransition = { phi11: 1, phi12: 0, phi21: 0, phi22: 1 };

  constructor(
    private readonly omega: number,
    private readonly zeta: number,
  ) {}

  public at(dt: number): ServoTransition {
    if (dt !== this.cachedDt) {
      this.cached = servoTransition(this.omega, this.zeta, dt);
      this.cachedDt = dt;
    }
    return this.cached;
  }
}
