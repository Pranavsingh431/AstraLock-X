/**
 * The engineering coordinate convention, and its mapping to the renderer.
 *
 * AstraLock-X computes in East-North-Up. Three.js draws in Y-up. Those are
 * different conventions and the difference is handled in exactly one place —
 * here — rather than by quietly relabelling axes at each call site. A pointing
 * error caused by a frame mix-up looks identical to a tracking bug, so the
 * conversion is explicit, one-directional, and tested.
 *
 * See docs/adr/0006-engineering-coordinate-convention.md.
 */

import type { Vec3 } from '@/core/contracts/geometry';
import {
  type Meters,
  type MetersPerSecond,
  type Radians,
  type RadiansPerSecond,
  meters,
  radians,
  radiansPerSecond,
} from '@/core/contracts/units';

/**
 * World frame: `world-enu`.
 *
 * - **X = East**, **Y = North**, **Z = Up**, in metres.
 * - Right-handed: `East x North = Up`.
 * - The origin is the scenario datum; the frame is treated as inertial.
 *
 * Angles in the core are radians throughout. Degrees appear only at
 * configuration and display boundaries.
 */
export const WORLD_FRAME = 'world-enu' as const;

/**
 * Azimuth: **clockwise from North**, about the +Up axis, wrapped to (-pi, pi].
 *
 * North is zero, East is +pi/2. This is the compass convention every pointing
 * mount uses, and it is worth being explicit that it is a *left-handed*
 * rotation about +Up even though the frame itself is right-handed. Choosing
 * mathematical convention here instead would produce numbers that disagree with
 * every gimbal datasheet the project will eventually be checked against.
 *
 * Elevation: **positive upward** from the horizontal plane, in [-pi/2, +pi/2].
 * Zero elevation is the local horizon.
 */
export interface AzimuthElevation {
  readonly azimuth: Radians;
  readonly elevation: Radians;
}

/** Rate of change of an {@link AzimuthElevation}. */
export interface AzimuthElevationRate {
  readonly azimuth: RadiansPerSecond;
  readonly elevation: RadiansPerSecond;
}

/** A bearing together with the range it was computed from. */
export interface BearingSolution extends AzimuthElevation {
  readonly range: Meters;
}

/**
 * Bearing from `origin` to `target`, both in world ENU metres.
 *
 * When the two points are vertically aligned the ground range vanishes and
 * azimuth is genuinely undefined; it is reported as zero rather than NaN, and
 * elevation still carries the full answer. Callers that care can check
 * `range`.
 */
export function bearingTo(origin: Vec3<Meters>, target: Vec3<Meters>): BearingSolution {
  const east = target.x - origin.x;
  const north = target.y - origin.y;
  const up = target.z - origin.z;

  const groundRange = Math.hypot(east, north);
  const range = Math.hypot(groundRange, up);

  // atan2(east, north) rather than atan2(north, east): zero at North,
  // increasing toward East.
  const azimuth = groundRange === 0 ? 0 : Math.atan2(east, north);
  const elevation = range === 0 ? 0 : Math.atan2(up, groundRange);

  return { azimuth: radians(azimuth), elevation: radians(elevation), range: meters(range) };
}

/**
 * Time derivative of {@link bearingTo}, computed analytically from the relative
 * position and velocity.
 *
 * Differentiating the bearing numerically across ticks would couple the answer
 * to the timestep and add noise that no real encoder produced, so the closed
 * form is used:
 *
 * ```
 *   d(az)/dt = (north * dEast - east * dNorth) / groundRange^2
 *   d(el)/dt = (dUp * groundRange - up * dGroundRange) / range^2
 * ```
 *
 * Degenerate geometry — coincident points, or a target directly overhead —
 * yields zero rather than a division by zero.
 */
export function bearingRateTo(
  origin: Vec3<Meters>,
  originVelocity: Vec3<MetersPerSecond>,
  target: Vec3<Meters>,
  targetVelocity: Vec3<MetersPerSecond>,
): AzimuthElevationRate {
  const east = target.x - origin.x;
  const north = target.y - origin.y;
  const up = target.z - origin.z;

  const dEast = targetVelocity.x - originVelocity.x;
  const dNorth = targetVelocity.y - originVelocity.y;
  const dUp = targetVelocity.z - originVelocity.z;

  const groundRangeSquared = east * east + north * north;
  const groundRange = Math.sqrt(groundRangeSquared);
  const rangeSquared = groundRangeSquared + up * up;

  const azimuthRate =
    groundRangeSquared === 0 ? 0 : (north * dEast - east * dNorth) / groundRangeSquared;

  // d(groundRange)/dt, guarded at the singularity.
  const dGroundRange = groundRange === 0 ? 0 : (east * dEast + north * dNorth) / groundRange;
  const elevationRate =
    rangeSquared === 0 ? 0 : (dUp * groundRange - up * dGroundRange) / rangeSquared;

  return { azimuth: radiansPerSecond(azimuthRate), elevation: radiansPerSecond(elevationRate) };
}

/** Unit vector along a bearing, in world ENU. */
export function directionFromBearing(bearing: AzimuthElevation): Vec3<Meters> {
  const cosElevation = Math.cos(bearing.elevation);
  return {
    x: meters(cosElevation * Math.sin(bearing.azimuth)),
    y: meters(cosElevation * Math.cos(bearing.azimuth)),
    z: meters(Math.sin(bearing.elevation)),
  };
}

// --- Renderer mapping -------------------------------------------------------

/**
 * Three.js coordinates: `[x, y, z]`, Y-up, right-handed, default camera looking
 * down -Z.
 */
export type RenderVec3 = readonly [number, number, number];

/**
 * Domain (ENU, metres) to renderer (Three.js, scene units).
 *
 * ```
 *   renderer.x =  east
 *   renderer.y =  up
 *   renderer.z = -north
 * ```
 *
 * North maps to -Z so that a default Three.js camera, which looks down -Z,
 * faces North: the scene reads like a map with North away from the viewer and
 * East to the right. The mapping has determinant +1, so it is a rotation and
 * preserves handedness — a mirrored mapping would silently flip the sign of
 * every cross product and every azimuth drawn on screen.
 *
 * Scene units are metres. There is no scale factor, deliberately: introducing
 * one is how renderer units start leaking back into engineering numbers.
 */
export function enuToRender(v: Vec3<Meters>): RenderVec3 {
  // Destructured to plain numbers first: negating a branded quantity is a unit
  // error in general, and the brand is deliberately dropped at this boundary.
  const east: number = v.x;
  const north: number = v.y;
  const up: number = v.z;
  return [east, up, -north];
}

/** Inverse of {@link enuToRender}. */
export function renderToEnu(v: RenderVec3): Vec3<Meters> {
  const [x, y, z] = v;
  return { x: meters(x), y: meters(-z), z: meters(y) };
}
