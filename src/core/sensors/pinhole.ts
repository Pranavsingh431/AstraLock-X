/**
 * The pinhole camera model.
 *
 * Pure geometry: given a camera pose and a relative world vector, where does
 * that point land on the image, and is it visible at all. Nothing here touches
 * the simulator, the renderer, WebGL or the DOM — it is arithmetic, and it is
 * the same arithmetic whether it runs in a test, a worker or a benchmark.
 *
 * See docs/SENSOR_MODEL.md and ADR-0009.
 */

import type { CameraConfig } from '@/core/contracts/simulation';
import type { Meters, Pixels, Radians } from '@/core/contracts/units';

/** A plain three-component vector in world ENU, or in the camera frame. */
export interface Vec3Lite {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

const dot = (a: Vec3Lite, b: Vec3Lite): number => a.x * b.x + a.y * b.y + a.z * b.z;

const cross = (a: Vec3Lite, b: Vec3Lite): Vec3Lite => ({
  x: a.y * b.z - a.z * b.y,
  y: a.z * b.x - a.x * b.z,
  z: a.x * b.y - a.y * b.x,
});

/**
 * Orthonormal camera basis for a no-roll mount, in world ENU.
 *
 * The world frame is East-North-Up, azimuth is clockwise from North about +Up,
 * and elevation is positive upward (ADR-0006).
 *
 * ```
 *   forward = ( sin(az) cos(el),  cos(az) cos(el),  sin(el) )
 *   right   = ( cos(az),         -sin(az),          0       )
 *   up      = right x forward
 * ```
 *
 * `right` is horizontal by construction, which is what "no roll" means: the
 * image horizon stays level regardless of elevation. It stays well defined at
 * every elevation including straight up, where an `up x forward` construction
 * would degenerate.
 *
 * Note that `(right, up, forward)` is **left-handed**: `right x up = -forward`.
 * That is the usual computer-vision arrangement of x-right, y-up, z-forward,
 * and it is stated here because the sign of the vertical term in the projection
 * below depends on it.
 */
export interface CameraBasis {
  readonly forward: Vec3Lite;
  readonly right: Vec3Lite;
  readonly up: Vec3Lite;
}

export function cameraBasis(azimuth: number, elevation: number): CameraBasis {
  const cosEl = Math.cos(elevation);
  const sinEl = Math.sin(elevation);
  const cosAz = Math.cos(azimuth);
  const sinAz = Math.sin(azimuth);

  const forward: Vec3Lite = { x: sinAz * cosEl, y: cosAz * cosEl, z: sinEl };
  const right: Vec3Lite = { x: cosAz, y: -sinAz, z: 0 };
  const up = cross(right, forward);

  return { forward, right, up };
}

/**
 * Camera intrinsics with everything derived once.
 *
 * Image coordinates are **continuous**, with pixel centres at half-integers:
 * pixel `(i, j)` covers `[i, i+1) x [j, j+1)` and its centre is at
 * `(i + 0.5, j + 0.5)`. The image therefore spans `[0, width] x [0, height]`,
 * the pixel containing a coordinate `u` is `floor(u)`, and the centre of the
 * image is `(width / 2, height / 2)`.
 *
 * This is the OpenCV and graphics convention. The alternative — pixel centres
 * at integers, image centre at `((width-1)/2, (height-1)/2)` — needs an offset
 * at every boundary calculation, and mixing the two is a classic source of
 * half-pixel bias in a centroid.
 */
export interface ResolvedIntrinsics {
  readonly width: number;
  readonly height: number;
  /** Focal length in pixels. */
  readonly fx: number;
  readonly fy: number;
  /** Principal point in continuous image coordinates. */
  readonly cx: number;
  readonly cy: number;
  readonly horizontalFov: number;
  readonly verticalFov: number;
  readonly nearRange: number;
  readonly farRange: number;
}

/**
 * Focal length in pixels for a horizontal field of view.
 *
 * ```
 *   fx = width / (2 tan(hfov / 2))
 * ```
 *
 * @throws {RangeError} unless `0 < horizontalFov < pi`. At zero the lens has no
 * view; at pi the tangent diverges and the model stops meaning anything.
 */
export function focalLengthFromFov(width: number, horizontalFov: number): number {
  if (!(horizontalFov > 0) || !(horizontalFov < Math.PI)) {
    throw new RangeError(
      `Horizontal field of view must be in (0, pi), received ${String(horizontalFov)} rad`,
    );
  }
  return width / (2 * Math.tan(horizontalFov / 2));
}

/** Inverse of {@link focalLengthFromFov}: the angle a sensor extent subtends. */
export function fovFromFocalLength(extentPixels: number, focalLength: number): number {
  return 2 * Math.atan(extentPixels / (2 * focalLength));
}

/**
 * Resolves a camera configuration into the numbers projection needs.
 *
 * The vertical field of view is derived rather than configured: under the
 * `square-pixels` policy `fy = fx`, so `vfov = 2 atan(height / (2 fx))`.
 * Declaring both fields of view independently would allow a scenario to specify
 * non-square pixels by accident.
 */
export function resolveIntrinsics(camera: CameraConfig): ResolvedIntrinsics {
  const width: number = camera.width;
  const height: number = camera.height;
  const fx = focalLengthFromFov(width, camera.horizontalFov);
  const fy = fx; // square-pixels policy

  return {
    width,
    height,
    fx,
    fy,
    cx: camera.principalPoint?.x ?? width / 2,
    cy: camera.principalPoint?.y ?? height / 2,
    horizontalFov: camera.horizontalFov,
    verticalFov: fovFromFocalLength(height, fy),
    nearRange: camera.nearRange,
    farRange: camera.farRange,
  };
}

/**
 * Why a point is or is not on the image.
 *
 * Reported for evaluation and debugging only. It never reaches a tracking
 * algorithm: "the target is outside the field of view" is exactly the kind of
 * answer a tracker is supposed to work out for itself.
 */
export type EmitterVisibility =
  'visible' | 'behind-camera' | 'outside-fov' | 'too-near' | 'too-far';

/** Where a point lands, and whether it lands at all. */
export interface Projection {
  readonly visibility: EmitterVisibility;
  /** Continuous image coordinates, or `null` when not visible. */
  readonly imageX: number | null;
  readonly imageY: number | null;
  /** Distance along the boresight, metres. Negative when behind the camera. */
  readonly depth: number;
  /** Straight-line distance from the camera, metres. */
  readonly range: number;
  /** Coordinates in the camera frame: x right, y up, z forward. */
  readonly cameraX: number;
  readonly cameraY: number;
  readonly cameraZ: number;
}

/**
 * Projects a world-relative vector onto the image.
 *
 * ```
 *   x_cam = r . right      y_cam = r . up      z_cam = r . forward
 *
 *   u = cx + fx * x_cam / z_cam
 *   v = cy - fy * y_cam / z_cam
 * ```
 *
 * The minus in `v` is the whole of the raster convention: `y_cam` grows upward
 * in the world, row indices grow downward in the image, so a target that climbs
 * moves to a *lower* row.
 *
 * Checks are ordered so the reported reason is the most specific one: a point
 * behind the camera is reported as behind rather than as out of range, because
 * that is the more useful thing to know when the mount is pointed the wrong way.
 */
export function projectPoint(
  relative: Vec3Lite,
  basis: CameraBasis,
  intrinsics: ResolvedIntrinsics,
): Projection {
  const cameraX = dot(relative, basis.right);
  const cameraY = dot(relative, basis.up);
  const cameraZ = dot(relative, basis.forward);
  const range = Math.sqrt(
    relative.x * relative.x + relative.y * relative.y + relative.z * relative.z,
  );

  const miss = (visibility: EmitterVisibility): Projection => ({
    visibility,
    imageX: null,
    imageY: null,
    depth: cameraZ,
    range,
    cameraX,
    cameraY,
    cameraZ,
  });

  if (!(cameraZ > 0)) return miss('behind-camera');
  if (range < intrinsics.nearRange) return miss('too-near');
  if (range > intrinsics.farRange) return miss('too-far');

  const imageX = intrinsics.cx + (intrinsics.fx * cameraX) / cameraZ;
  const imageY = intrinsics.cy - (intrinsics.fy * cameraY) / cameraZ;

  // Containment is tested on the image rectangle rather than on the angles:
  // they agree for a pinhole, and the pixel test is the one that decides
  // whether anything is actually drawn.
  if (imageX < 0 || imageX > intrinsics.width || imageY < 0 || imageY > intrinsics.height) {
    return miss('outside-fov');
  }

  return {
    visibility: 'visible',
    imageX,
    imageY,
    depth: cameraZ,
    range,
    cameraX,
    cameraY,
    cameraZ,
  };
}

/** The pixel containing a continuous image coordinate. */
export const pixelIndexOf = (imageCoordinate: number): number => Math.floor(imageCoordinate);

/** The continuous coordinate of a pixel's centre. */
export const pixelCentreOf = (pixelIndex: number): number => pixelIndex + 0.5;

/** Convenience wrapper for the branded unit types used in configuration. */
export interface CameraPoseAngles {
  readonly azimuth: Radians;
  readonly elevation: Radians;
}

/** Relative vector from the camera to a world point, both in ENU metres. */
export function relativeTo(
  cameraPosition: { readonly x: Meters; readonly y: Meters; readonly z: Meters },
  worldPoint: { readonly x: Meters; readonly y: Meters; readonly z: Meters },
): Vec3Lite {
  return {
    x: worldPoint.x - cameraPosition.x,
    y: worldPoint.y - cameraPosition.y,
    z: worldPoint.z - cameraPosition.z,
  };
}

/** Half-angles of the field of view, for containment tests elsewhere. */
export interface FieldOfViewHalfAngles {
  readonly horizontal: Radians;
  readonly vertical: Radians;
}

/** Field of view half-angles implied by the intrinsics. */
export function fieldOfViewHalfAngles(intrinsics: ResolvedIntrinsics): FieldOfViewHalfAngles {
  return {
    horizontal: (intrinsics.horizontalFov / 2) as Radians,
    vertical: (intrinsics.verticalFov / 2) as Radians,
  };
}

/** Pixels per radian at the image centre, useful for sizing a point spread. */
export const pixelsPerRadian = (intrinsics: ResolvedIntrinsics): Pixels => intrinsics.fx as Pixels;
