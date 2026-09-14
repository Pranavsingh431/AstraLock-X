// @vitest-environment node
/**
 * Pixel to bearing, and back.
 *
 * The round trip is the strong test: take a known world direction, project it
 * through the *simulator's* optics into pixels, then recover a bearing using
 * only the pixel, the believed calibration and the measured pose. When the
 * measured pose equals the true pose the recovered bearing must equal the
 * original to numerical precision — anything else is a sign or convention
 * error, and a convention error here would point the mount the wrong way while
 * every individual component looked correct.
 *
 * The second half checks what happens when the measured pose is *not* the true
 * pose, which is the normal case: the recovered bearing is wrong by exactly the
 * encoder error, and the tracker is not allowed to correct for it.
 */

import { describe, expect, it } from 'vitest';

import { loadScenario } from '@/scenarios';
import { cameraStateFrom } from '@/core/runtime/closed-loop';
import { cameraBasis, projectPoint, resolveIntrinsics } from '@/core/sensors/pinhole';

import { bearingToPixel, pixelToBearing, pixelToCameraRay } from './bearing';

const config = loadScenario('camera-boresight');
const camera = cameraStateFrom(config);
const intrinsics = resolveIntrinsics(config.camera);

/** A unit world vector at the given bearing. */
const direction = (azimuth: number, elevation: number) => ({
  x: Math.sin(azimuth) * Math.cos(elevation),
  y: Math.cos(azimuth) * Math.cos(elevation),
  z: Math.sin(elevation),
});

/** Forward projection through the simulator's own optics. */
function project(
  targetAz: number,
  targetEl: number,
  poseAz: number,
  poseEl: number,
): { u: number; v: number } | null {
  const basis = cameraBasis(poseAz, poseEl);
  // A point far enough away that near/far range never rejects it.
  const d = direction(targetAz, targetEl);
  const projection = projectPoint(
    { x: d.x * 5000, y: d.y * 5000, z: d.z * 5000 },
    basis,
    intrinsics,
  );
  return projection.imageX === null ? null : { u: projection.imageX, v: projection.imageY! };
}

const DEG = Math.PI / 180;

// This camera has an 8.0 deg x 6.0 deg field, so offsets are kept inside
// +/-3.5 deg horizontally and +/-2.5 deg vertically. A case outside the field
// has no pixel to recover from and would be testing nothing.

describe('the camera ray', () => {
  it('points along the boresight at the principal point', () => {
    const ray = pixelToCameraRay(
      camera.intrinsics.principalPointX,
      camera.intrinsics.principalPointY,
      camera,
    );
    expect(ray.x).toBeCloseTo(0, 12);
    expect(ray.y).toBeCloseTo(0, 12);
    expect(ray.z).toBeCloseTo(1, 12);
  });

  it('is a unit vector', () => {
    const ray = pixelToCameraRay(500, 100, camera);
    expect(Math.hypot(ray.x, ray.y, ray.z)).toBeCloseTo(1, 12);
  });

  it('tips right for a pixel right of centre and up for one above', () => {
    // Image rows increase downward, so "above centre" is a smaller v.
    const right = pixelToCameraRay(
      camera.intrinsics.principalPointX + 100,
      camera.intrinsics.principalPointY,
      camera,
    );
    const above = pixelToCameraRay(
      camera.intrinsics.principalPointX,
      camera.intrinsics.principalPointY - 100,
      camera,
    );

    expect(right.x).toBeGreaterThan(0);
    expect(above.y).toBeGreaterThan(0);
  });
});

describe('round trip with an exact pose', () => {
  it.each([
    ['boresight', 0, 0, 0, 0],
    ['right of centre', 3 * DEG, 0, 0, 0],
    ['left of centre', -3 * DEG, 0, 0, 0],
    ['above centre', 0, 2 * DEG, 0, 0],
    ['below centre', 0, -2 * DEG, 0, 0],
    ['combined offset', 2.5 * DEG, -1.8 * DEG, 0, 0],
    ['near the image corner', 3.4 * DEG, 2.4 * DEG, 0, 0],
    ['from a panned mount', 33 * DEG, 0, 30 * DEG, 0],
    ['from a tilted mount', 0, 22 * DEG, 0, 20 * DEG],
    ['from a panned and tilted mount', 42 * DEG, 25.5 * DEG, 40 * DEG, 24 * DEG],
    ['pointing near due West', -92 * DEG, 1.5 * DEG, -90 * DEG, 0],
    ['pointing near due South', 178 * DEG, 0, 180 * DEG, 0],
  ])('recovers %s', (_label, targetAz, targetEl, poseAz, poseEl) => {
    const pixel = project(targetAz, targetEl, poseAz, poseEl);
    expect(pixel).not.toBeNull();

    const recovered = pixelToBearing(pixel!.u, pixel!.v, camera, poseAz, poseEl);

    // Shortest-arc comparison so a target at +178 deg against a recovery at
    // -179 deg is a 3 deg difference rather than a 357 deg one.
    const azError = Math.atan2(
      Math.sin(recovered.azimuth - targetAz),
      Math.cos(recovered.azimuth - targetAz),
    );
    expect(Math.abs(azError)).toBeLessThan(1e-9);
    expect(Math.abs(recovered.elevation - targetEl)).toBeLessThan(1e-9);
  });

  it('is exact at the image corners, where a sign error shows up worst', () => {
    for (const [u, v] of [
      [0.5, 0.5],
      [639.5, 0.5],
      [0.5, 479.5],
      [639.5, 479.5],
    ] as const) {
      const bearing = pixelToBearing(u, v, camera, 0.2, 0.1);
      const back = bearingToPixel(bearing.azimuth, bearing.elevation, camera, 0.2, 0.1);
      expect(back).not.toBeNull();
      expect(back!.u).toBeCloseTo(u, 9);
      expect(back!.v).toBeCloseTo(v, 9);
    }
  });

  it('agrees with the simulator projection, not merely with itself', () => {
    // The algorithm's forward model is its own; this checks it against the
    // optics that actually made the pixels.
    const pixel = project(5 * DEG, -3 * DEG, 2 * DEG, -1 * DEG);
    const mine = bearingToPixel(5 * DEG, -3 * DEG, camera, 2 * DEG, -1 * DEG);

    expect(mine!.u).toBeCloseTo(pixel!.u, 6);
    expect(mine!.v).toBeCloseTo(pixel!.v, 6);
  });

  it('refuses a direction behind the camera', () => {
    expect(bearingToPixel(Math.PI, 0, camera, 0, 0)).toBeNull();
  });
});

describe('with a quantised pose, as the tracker actually has', () => {
  it('carries the encoder error straight into the bearing', () => {
    // The measurement chain's honest behaviour. The tracker uses the reported
    // pose because that is all it has, so its bearing is wrong by whatever the
    // encoder rounded away — and it must not be "corrected" with the truth.
    const truePose = 0.3;
    const resolution = config.gimbal.pan.encoderResolution;
    const measuredPose = Math.round(truePose / resolution) * resolution;
    const poseError = measuredPose - truePose;
    expect(poseError).not.toBe(0);

    const pixel = project(0.31, 0, truePose, 0);
    const recovered = pixelToBearing(pixel!.u, pixel!.v, camera, measuredPose, 0);

    // The bearing error is the pose error, essentially one-for-one: rotating
    // the whole ray bundle by the pose error rotates the recovered bearing by
    // the same amount.
    expect(recovered.azimuth - 0.31).toBeCloseTo(poseError, 6);
  });

  it('keeps that error bounded by half an encoder count', () => {
    const resolution = config.gimbal.pan.encoderResolution;
    let worst = 0;

    for (let step = 0; step < 40; step += 1) {
      const truePose = 0.2 + step * (resolution / 7);
      const measuredPose = Math.round(truePose / resolution) * resolution;
      const target = truePose + 0.01;

      const pixel = project(target, 0, truePose, 0);
      if (pixel === null) continue;
      const recovered = pixelToBearing(pixel.u, pixel.v, camera, measuredPose, 0);
      worst = Math.max(worst, Math.abs(recovered.azimuth - target));
    }

    expect(worst).toBeGreaterThan(0);
    expect(worst).toBeLessThanOrEqual(resolution / 2 + 1e-9);
  });
});
