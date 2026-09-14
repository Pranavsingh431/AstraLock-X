/**
 * Angular arithmetic that does not fall apart at the branch cut.
 *
 * Azimuth is periodic. Subtracting two azimuths either side of ±π gives an
 * answer near 2π when the true difference is near zero, and a filter handed
 * that number will conclude the target has jumped almost all the way round the
 * sky. Every angular difference in the tracker goes through
 * {@link shortestAngle}.
 *
 * Elevation is **not** periodic in the same way — it is bounded to [−π/2, π/2]
 * by geometry and the mount's travel is narrower still — so elevation
 * differences are taken directly. Wrapping an elevation would be wrong, not
 * merely unnecessary: it would silently turn an impossible measurement into a
 * plausible one.
 */

/** Wraps an angle to (−π, π]. */
export function wrapAngle(angle: number): number {
  if (!Number.isFinite(angle)) return angle;
  // Chosen so that exactly −π maps to +π, matching the half-open convention
  // the rest of the project uses.
  const wrapped = (((angle + Math.PI) % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  return wrapped - Math.PI === -Math.PI ? Math.PI : wrapped - Math.PI;
}

/**
 * Signed shortest angular difference `a − b`, in (−π, π].
 *
 * This is the innovation the Kalman filter uses and the error the PID uses. It
 * is the single most important function in the tracker for robustness: without
 * it a target crossing North produces a 2π innovation, the filter's gain
 * multiplies it, and the mount slews the long way round.
 */
export function shortestAngle(a: number, b: number): number {
  return wrapAngle(a - b);
}
