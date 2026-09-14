/**
 * Geometry and reference-frame vocabulary.
 *
 * Pointing errors are frame errors more often than they are algorithm errors,
 * so every pose and bearing in AstraLock-X names the frame it is expressed in.
 * The frames are fixed here once and referred to by name everywhere else.
 */

import type { Meters, MetersPerSecond, Pixels, Radians, RadiansPerSecond } from './units';

/**
 * Frames used across the system.
 *
 * - `world-enu`      East-North-Up, right-handed, origin at the scenario datum.
 *                    The inertial frame all absolute motion is expressed in.
 * - `platform-body`  Fixed to the moving platform: x forward, y left, z up.
 * - `gimbal-base`    Fixed to the gimbal mount, related to the body frame by a
 *                    static alignment that calibration is meant to recover.
 * - `camera`         Optical frame: z along boresight, x right, y down.
 * - `image`          2D pixel coordinates, origin at the top-left of the frame.
 */
export type ReferenceFrame = 'world-enu' | 'platform-body' | 'gimbal-base' | 'camera' | 'image';

/** Two-component vector, generic over the unit of its components. */
export interface Vec2<Q extends number = number> {
  readonly x: Q;
  readonly y: Q;
}

/** Three-component vector, generic over the unit of its components. */
export interface Vec3<Q extends number = number> {
  readonly x: Q;
  readonly y: Q;
  readonly z: Q;
}

/**
 * Unit quaternion, Hamilton convention, scalar-first.
 *
 * Rotations are stored as quaternions rather than Euler angles because the
 * gimbal operates near elevations where an Euler parameterisation degenerates.
 */
export interface Quaternion {
  readonly w: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A position in metres, tagged with the frame it is expressed in. */
export interface Position {
  readonly frame: ReferenceFrame;
  readonly value: Vec3<Meters>;
}

/** A linear velocity in metres per second, tagged with its frame. */
export interface Velocity {
  readonly frame: ReferenceFrame;
  readonly value: Vec3<MetersPerSecond>;
}

/** Rigid-body pose: where a frame sits inside its parent frame. */
export interface Pose {
  /** The frame this pose is expressed in. */
  readonly frame: ReferenceFrame;
  readonly position: Vec3<Meters>;
  readonly orientation: Quaternion;
}

/**
 * Azimuth/elevation pair.
 *
 * Azimuth is measured clockwise from the frame's forward axis and elevation
 * upward from its horizontal plane. Both are wrapped to (-pi, pi].
 */
export interface Bearing {
  readonly frame: ReferenceFrame;
  readonly azimuth: Radians;
  readonly elevation: Radians;
}

/** Rate of change of a {@link Bearing}. */
export interface BearingRate {
  readonly frame: ReferenceFrame;
  readonly azimuth: RadiansPerSecond;
  readonly elevation: RadiansPerSecond;
}

/** A point on the image plane, in pixels from the top-left corner. */
export type ImagePoint = Vec2<Pixels>;

/** An axis-aligned rectangle in image coordinates. */
export interface ImageRect {
  readonly x: Pixels;
  readonly y: Pixels;
  readonly width: Pixels;
  readonly height: Pixels;
}

/** Row-major 2x2 matrix. */
export type Matrix2x2 = readonly [readonly [number, number], readonly [number, number]];

/** Row-major 4x4 matrix. */
export type Matrix4x4 = readonly [
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
  readonly [number, number, number, number],
];

/**
 * Covariance over (azimuth, elevation), in rad^2.
 *
 * Symmetric and positive semi-definite. The type cannot express those
 * constraints, so they are checked where a covariance is produced.
 */
export type BearingCovariance = Matrix2x2;

/**
 * Covariance over (azimuth, elevation, azimuth-rate, elevation-rate), in the
 * corresponding squared units.
 */
export type BearingStateCovariance = Matrix4x4;
