/**
 * Turning a detected pixel into a world bearing.
 *
 * This is the inverse of the pinhole projection, and it is the step where the
 * algorithm stops reasoning about the image and starts reasoning about the
 * world. Everything it uses is something real control software has: the
 * believed calibration, and the angle the encoders reported for the frame.
 *
 * It deliberately does **not** use the mount's true pose. Using it would remove
 * the encoder error from the measurement chain and hand the tracker a bearing
 * more accurate than any real system could compute — the pose that exactly
 * explains its own pixels. The quantisation error that remains here is a real
 * measurement error and the filter downstream has to live with it.
 *
 * Conventions, all from ADR-0006:
 *
 * - world frame is East-North-Up;
 * - azimuth is clockwise from North about +Up, so `atan2(east, north)`;
 * - elevation is positive upward;
 * - image coordinates are continuous with pixel centres at half-integers, so
 *   the centre of pixel `(i, j)` is `(i + 0.5, j + 0.5)`.
 *
 * See docs/BASELINE_PAT.md.
 */

import type { CameraState } from '@/core/contracts/sensors';
import type { Radians } from '@/core/contracts/units';
import { radians } from '@/core/contracts/units';

/** A unit vector in the camera frame: x right, y up, z along the boresight. */
export interface CameraRay {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** An angular measurement derived from one detection. */
export interface BearingMeasurement {
  readonly azimuth: Radians;
  readonly elevation: Radians;
}

/**
 * Back-projects a pixel to a unit ray in the camera frame.
 *
 * ```
 *   x = (u - cx) / fx
 *   y = -(v - cy) / fy
 *   z = 1
 * ```
 *
 * then normalised. The vertical sign is negative because image rows increase
 * downward while the camera's y axis points up — the same sign that appears in
 * the forward projection, inverted.
 *
 * No distortion correction: the simulator's optics are an exact pinhole and the
 * believed intrinsics carry zero distortion coefficients. Applying an
 * undistortion with zero coefficients would be an identity dressed up as work.
 * When a distorted sensor arrives, it belongs here.
 */
export function pixelToCameraRay(u: number, v: number, camera: CameraState): CameraRay {
  const x = (u - camera.intrinsics.principalPointX) / camera.intrinsics.focalLengthX;
  const y = -(v - camera.intrinsics.principalPointY) / camera.intrinsics.focalLengthY;
  const length = Math.hypot(x, y, 1);
  return { x: x / length, y: y / length, z: 1 / length };
}

/**
 * Rotates a camera-frame ray into world ENU using a no-roll mount pose.
 *
 * The basis matches the one the forward projection uses:
 *
 * ```
 *   forward = ( sin(az)·cos(el),  cos(az)·cos(el),  sin(el) )
 *   right   = ( cos(az),         -sin(az),          0       )
 *   up      = right × forward
 * ```
 */
export function cameraRayToWorld(
  ray: CameraRay,
  azimuth: number,
  elevation: number,
): { east: number; north: number; up: number } {
  const cosEl = Math.cos(elevation);
  const sinEl = Math.sin(elevation);
  const cosAz = Math.cos(azimuth);
  const sinAz = Math.sin(azimuth);

  const fx = sinAz * cosEl;
  const fy = cosAz * cosEl;
  const fz = sinEl;

  const rx = cosAz;
  const ry = -sinAz;
  const rz = 0;

  // up = right × forward
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  return {
    east: ray.x * rx + ray.y * ux + ray.z * fx,
    north: ray.x * ry + ray.y * uy + ray.z * fy,
    up: ray.x * rz + ray.y * uz + ray.z * fz,
  };
}

/**
 * Full pixel-to-bearing transform.
 *
 * @param u continuous image x of the detection
 * @param v continuous image y
 * @param camera believed calibration
 * @param measuredAzimuth encoder-reported pan for this frame
 * @param measuredElevation encoder-reported tilt
 */
export function pixelToBearing(
  u: number,
  v: number,
  camera: CameraState,
  measuredAzimuth: number,
  measuredElevation: number,
): BearingMeasurement {
  const ray = pixelToCameraRay(u, v, camera);
  const world = cameraRayToWorld(ray, measuredAzimuth, measuredElevation);

  return {
    azimuth: radians(Math.atan2(world.east, world.north)),
    elevation: radians(Math.atan2(world.up, Math.hypot(world.east, world.north))),
  };
}

/**
 * Where a world bearing would land on the image, given a measured pose.
 *
 * The forward direction, used for the predicted-position overlay and for
 * turning a filter estimate back into a pointing error in pixels. Returns
 * `null` when the bearing is behind the camera, where no projection exists.
 *
 * This is the algorithm's own copy of the projection, built from the *believed*
 * calibration. It is not the simulator's projection and will not agree with it
 * to the last bit — which is the correct relationship between a control system's
 * internal model and the world.
 */
export function bearingToPixel(
  azimuth: number,
  elevation: number,
  camera: CameraState,
  measuredAzimuth: number,
  measuredElevation: number,
): { u: number; v: number } | null {
  const cosEl = Math.cos(elevation);
  const target = {
    east: Math.sin(azimuth) * cosEl,
    north: Math.cos(azimuth) * cosEl,
    up: Math.sin(elevation),
  };

  const cosMel = Math.cos(measuredElevation);
  const sinMel = Math.sin(measuredElevation);
  const cosMaz = Math.cos(measuredAzimuth);
  const sinMaz = Math.sin(measuredAzimuth);

  const fx = sinMaz * cosMel;
  const fy = cosMaz * cosMel;
  const fz = sinMel;
  const rx = cosMaz;
  const ry = -sinMaz;
  const rz = 0;
  const ux = ry * fz - rz * fy;
  const uy = rz * fx - rx * fz;
  const uz = rx * fy - ry * fx;

  const cameraZ = target.east * fx + target.north * fy + target.up * fz;
  if (!(cameraZ > 0)) return null;

  const cameraX = target.east * rx + target.north * ry + target.up * rz;
  const cameraY = target.east * ux + target.north * uy + target.up * uz;

  return {
    u: camera.intrinsics.principalPointX + (camera.intrinsics.focalLengthX * cameraX) / cameraZ,
    v: camera.intrinsics.principalPointY - (camera.intrinsics.focalLengthY * cameraY) / cameraZ,
  };
}
