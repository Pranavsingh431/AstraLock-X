/**
 * Small vector helpers for the simulation core.
 *
 * These operate on plain numbers rather than branded quantities. Branded units
 * catch the errors that matter at interface boundaries — passing degrees where
 * radians belong — but inside a single physics expression the products and
 * quotients change unit constantly, and threading that through the type system
 * would cost far more than it caught. Values are tagged again on the way out.
 */

/** An untagged three-component vector, used inside a calculation. */
export interface Vector3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export const vec3 = (x: number, y: number, z: number): Vector3 => ({ x, y, z });

export const ZERO: Vector3 = { x: 0, y: 0, z: 0 };

export const add = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.x + b.x,
  y: a.y + b.y,
  z: a.z + b.z,
});

export const subtract = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.x - b.x,
  y: a.y - b.y,
  z: a.z - b.z,
});

export const scale = (v: Vector3, k: number): Vector3 => ({ x: v.x * k, y: v.y * k, z: v.z * k });

export const dot = (a: Vector3, b: Vector3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const cross = (a: Vector3, b: Vector3): Vector3 => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

export const length = (v: Vector3): number => Math.hypot(v.x, v.y, v.z);

/**
 * Unit vector in the direction of `v`.
 *
 * @throws {RangeError} when `v` has zero length, which has no direction. A
 * silent fallback here would turn a misconfigured scenario into a plausible but
 * wrong trajectory.
 */
export function normalize(v: Vector3): Vector3 {
  const magnitude = length(v);
  if (magnitude === 0) {
    throw new RangeError('Cannot normalize a zero-length vector');
  }
  return scale(v, 1 / magnitude);
}

/** Linear interpolation, `alpha` in [0, 1]. */
export const lerp = (a: Vector3, b: Vector3, alpha: number): Vector3 => ({
  x: a.x + (b.x - a.x) * alpha,
  y: a.y + (b.y - a.y) * alpha,
  z: a.z + (b.z - a.z) * alpha,
});

/**
 * Any two unit vectors spanning the plane with normal `normal`.
 *
 * The pair is produced by Gram-Schmidt against whichever world axis is least
 * aligned with the normal, which keeps the construction well conditioned for
 * every normal and — more importantly — makes it deterministic. A circular
 * trajectory's phase is measured from the first of these, so an arbitrary
 * choice here would move where the target starts.
 */
export function planeBasis(normal: Vector3): readonly [Vector3, Vector3] {
  const n = normalize(normal);
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  const az = Math.abs(n.z);

  const seed: Vector3 =
    ax <= ay && ax <= az ? vec3(1, 0, 0) : ay <= az ? vec3(0, 1, 0) : vec3(0, 0, 1);

  const u = normalize(subtract(seed, scale(n, dot(seed, n))));
  const w = cross(n, u);
  return [u, w];
}

/** True when every component is finite. */
export const isFinite3 = (v: Vector3): boolean =>
  Number.isFinite(v.x) && Number.isFinite(v.y) && Number.isFinite(v.z);
