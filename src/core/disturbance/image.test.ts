// @vitest-environment node
/**
 * What the disturbances actually do to pixels.
 *
 * The model tests next door check the mathematics in isolation. These check that
 * the mathematics is wired into image formation the right way round: that blur
 * comes from motion during the exposure rather than from a filter, that noise
 * lands on the signal rather than on the quantised result, and that clipping
 * clamps rather than wraps.
 */

import { describe, expect, it } from 'vitest';

import { CLEAN_DISTURBANCES, type DisturbanceConfig } from '@/core/contracts/disturbance';
import { parseSimulationConfig, type SimulationConfig } from '@/core/contracts/simulation';
import type { EmitterId, OpticalEmitter } from '@/core/sensors/emitters';
import type { Vec3Lite } from '@/core/sensors/pinhole';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import type { SensorWorldSample, WorldSampler } from '@/core/sensors/world-sampler';
import { makeValidRawConfig } from '@/test/fixtures';

/** hfov such that fx = 320 / tan(hfov/2) = 800. */
const FOV_FOR_FX_800 = 2 * Math.atan(0.4);

function config(
  disturbances: DisturbanceConfig,
  cameraPatch: Record<string, unknown> = {},
): SimulationConfig {
  const raw = makeValidRawConfig();
  raw['camera'] = {
    ...(raw['camera'] as Record<string, unknown>),
    width: 640,
    height: 480,
    horizontalFov: FOV_FOR_FX_800,
    principalPoint: null,
    nearRange: 1,
    farRange: 50_000,
    frameRate: 60,
    backgroundLevel: 0,
    exposure: 1 / 120,
    ...cameraPatch,
  };
  raw['disturbances'] = disturbances;
  return parseSimulationConfig(raw);
}

function emitter(position: Vec3Lite, intensity = 0.8, psfSigma = 2): OpticalEmitter {
  return {
    id: 'emitter-0' as EmitterId,
    hostEntityId: 'target-0',
    position,
    intensity: intensity as never,
    psfSigma: psfSigma as never,
    code: null,
  };
}

/**
 * A sampler whose emitter moves at a fixed velocity through the world.
 *
 * Motion is real world motion, so any blur the sensor produces comes from the
 * emitter moving during the exposure — which is the only way blur is allowed to
 * arise here.
 */
function movingSampler(startY: number, velocity: Vec3Lite): WorldSampler {
  return {
    policy: 'exact',
    sampleAt: (time: number): SensorWorldSample => ({
      time,
      cameraPosition: { x: 0, y: 0, z: 0 },
      cameraPose: {
        trueAzimuth: 0,
        trueElevation: 0,
        measuredAzimuth: 0,
        measuredElevation: 0,
      } as SensorWorldSample['cameraPose'],
      emitters: [
        emitter({
          x: velocity.x * time,
          y: startY + velocity.y * time,
          z: velocity.z * time,
        }),
      ],
    }),
  };
}

const still = (startY = 1200): WorldSampler => movingSampler(startY, { x: 0, y: 0, z: 0 });

function patched(patch: (base: DisturbanceConfig) => DisturbanceConfig): DisturbanceConfig {
  return patch(structuredClone(CLEAN_DISTURBANCES));
}

/** Intensity-weighted centroid and total energy of a frame. */
function moments(data: Uint8Array, width: number, height: number, floor = 8) {
  let sumX = 0;
  let sumY = 0;
  let weight = 0;
  let total = 0;
  let peak = 0;
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const value = data[y * width + x]!;
      total += value;
      if (value > peak) peak = value;
      if (value >= floor) {
        sumX += x * value;
        sumY += y * value;
        weight += value;
      }
    }
  }
  return {
    x: weight === 0 ? null : sumX / weight,
    y: weight === 0 ? null : sumY / weight,
    total,
    peak,
  };
}

function render(
  disturbances: DisturbanceConfig,
  sampler: WorldSampler,
  frameIndex = 3,
  cameraPatch: Record<string, unknown> = {},
) {
  const sensor = new VirtualCameraSensor({ config: config(disturbances, cameraPatch) });
  const capture = sensor.captureFrame(sampler, frameIndex);
  const frame = capture.frame;
  const result = {
    data: new Uint8Array(frame.data as Uint8Array),
    width: frame.width as number,
    height: frame.height as number,
    truth: capture.truth,
  };
  capture.release();
  return result;
}

describe('finite exposure', () => {
  const withExposure = (subSamples: number) =>
    patched((base) => ({
      ...base,
      optics: { ...base.optics, exposure: { enabled: true, subSamples } },
    }));

  // The property that separates an exposure model from a blur filter: a target
  // that does not move must not move, however finely the exposure is sampled.
  it('does not shift a stationary beacon, at any sub-sample count', () => {
    const reference = render(withExposure(1), still());
    const referenceMoments = moments(reference.data, reference.width, reference.height);

    for (const subSamples of [2, 4, 8, 16, 32]) {
      const frame = render(withExposure(subSamples), still());
      const centre = moments(frame.data, frame.width, frame.height);
      expect(centre.x!).toBeCloseTo(referenceMoments.x!, 6);
      expect(centre.y!).toBeCloseTo(referenceMoments.y!, 6);
    }
  });

  it('reproduces instantaneous capture exactly at one sub-sample', () => {
    const instantaneous = render(CLEAN_DISTURBANCES, still());
    const single = render(withExposure(1), still());
    expect([...single.data]).toEqual([...instantaneous.data]);
  });

  // Blur is measured as the second moment of the intensity distribution, not as
  // a contour at a fixed threshold. Spreading light lowers the peak, so a fixed
  // threshold shrinks around the spot at the same time as the spot widens, and
  // the two effects very nearly cancel. The variance does not have that problem.
  it('widens the spot along the direction of travel and not across it', () => {
    const sampler = movingSampler(1200, { x: 900, y: 0, z: 0 });
    const sharp = spread(render(withExposure(1), sampler));
    const blurred = spread(render(withExposure(32), sampler));

    expect(blurred.varianceX).toBeGreaterThan(sharp.varianceX * 1.2);
    // Motion is purely cross-boresight in x, so the y profile must be untouched.
    expect(blurred.varianceY).toBeCloseTo(sharp.varianceY, 1);
  });

  // The streak length is predictable: the emitter moves v*T metres across the
  // line of sight during the exposure, which is fx*v*T/range pixels. A uniform
  // streak of length L adds L^2/12 to the variance along it.
  it('widens it by the amount the motion during the exposure implies', () => {
    const velocity = 900;
    const range = 1200;
    const exposure = 1 / 120;
    const focalLength = 800;
    const streak = (focalLength * velocity * exposure) / range;

    const sampler = movingSampler(range, { x: velocity, y: 0, z: 0 });
    const sharp = spread(render(withExposure(1), sampler));
    const blurred = spread(render(withExposure(32), sampler));

    const measured = blurred.varianceX - sharp.varianceX;
    const predicted = (streak * streak) / 12;
    expect(measured).toBeGreaterThan(predicted * 0.6);
    expect(measured).toBeLessThan(predicted * 1.6);
  });

  it('lowers the peak as it spreads the same light over a longer streak', () => {
    const sampler = movingSampler(1200, { x: 900, y: 0, z: 0 });
    const sharp = render(withExposure(1), sampler);
    const blurred = render(withExposure(16), sampler);

    expect(moments(...framePieces(blurred)).peak).toBeLessThan(moments(...framePieces(sharp)).peak);
  });

  // Convergence: past a point, more sub-samples stop changing the answer at all.
  // That is what makes the count a numerical parameter rather than a physical
  // one — and what lets a scenario choose it for cost rather than for fidelity.
  it('converges as the sub-sample count rises', () => {
    const sampler = movingSampler(1200, { x: 900, y: 0, z: 0 });
    const difference = (a: Uint8Array, b: Uint8Array): number => {
      let total = 0;
      for (let index = 0; index < a.length; index += 1) total += Math.abs(a[index]! - b[index]!);
      return total;
    };

    const reference = render(withExposure(64), sampler).data;
    const coarse = difference(render(withExposure(2), sampler).data, reference);
    const medium = difference(render(withExposure(8), sampler).data, reference);
    const fine = difference(render(withExposure(32), sampler).data, reference);

    expect(coarse).toBeGreaterThan(medium);
    expect(medium).toBeGreaterThanOrEqual(fine);
    // By 32 samples the 8-bit image is already identical to the 64-sample one.
    expect(fine).toBe(0);
  });

  it('keeps the collected light roughly constant however finely it is sampled', () => {
    const sampler = movingSampler(1200, { x: 120, y: 0, z: 0 });
    const single = moments(...framePieces(render(withExposure(1), sampler))).total;
    const many = moments(...framePieces(render(withExposure(32), sampler))).total;
    expect(many / single).toBeGreaterThan(0.9);
    expect(many / single).toBeLessThan(1.1);
  });
});

/**
 * Second moments of the intensity distribution, in pixels squared.
 *
 * The threshold-free measure of how wide a spot is. Using a brightness contour
 * instead would confound spreading with dimming, since spreading light lowers
 * the peak and pulls any fixed contour inwards.
 */
function spread(frame: { data: Uint8Array; width: number; height: number }) {
  let weight = 0;
  let sumX = 0;
  let sumY = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const value = frame.data[y * frame.width + x]!;
      weight += value;
      sumX += x * value;
      sumY += y * value;
    }
  }
  const meanX = sumX / weight;
  const meanY = sumY / weight;

  let varianceX = 0;
  let varianceY = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      const value = frame.data[y * frame.width + x]!;
      varianceX += value * (x - meanX) * (x - meanX);
      varianceY += value * (y - meanY) * (y - meanY);
    }
  }
  return { meanX, meanY, varianceX: varianceX / weight, varianceY: varianceY / weight };
}

/** Destructures a rendered frame for `moments`. */
function framePieces(frame: {
  data: Uint8Array;
  width: number;
  height: number;
}): [Uint8Array, number, number] {
  return [frame.data, frame.width, frame.height];
}

describe('sensor noise in the image', () => {
  const withReadNoise = (sigma: number) =>
    patched((base) => ({
      ...base,
      sensor: { ...base.sensor, readNoise: { enabled: true, sigma } },
    }));

  /** Statistics of a dark corner, far from the beacon. */
  function cornerStats(data: Uint8Array, width: number) {
    const values: number[] = [];
    for (let y = 0; y < 60; y += 1) {
      for (let x = 0; x < 60; x += 1) values.push(data[y * width + x]!);
    }
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    const sd = Math.sqrt(
      values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length,
    );
    return { mean, sd };
  }

  it('widens the spread as the configured sigma rises', () => {
    // A pedestal to sit on, so the noise is not half-clipped at zero.
    const pedestal = { backgroundLevel: 0.4 };
    const quiet = render(withReadNoise(1), still(), 3, pedestal);
    const loud = render(withReadNoise(6), still(), 3, pedestal);

    expect(cornerStats(quiet.data, quiet.width).sd).toBeGreaterThan(0.5);
    expect(cornerStats(loud.data, loud.width).sd).toBeGreaterThan(
      cornerStats(quiet.data, quiet.width).sd * 2,
    );
  });

  it('is zero-mean: it does not brighten or darken the image', () => {
    const pedestal = { backgroundLevel: 0.4 };
    const clean = render(CLEAN_DISTURBANCES, still(), 3, pedestal);
    const noisy = render(withReadNoise(4), still(), 3, pedestal);

    expect(cornerStats(noisy.data, noisy.width).mean).toBeCloseTo(
      cornerStats(clean.data, clean.width).mean,
      0,
    );
  });

  it('gives the sigma it was asked for, measured off the pixels', () => {
    const frame = render(withReadNoise(5), still(), 3, { backgroundLevel: 0.5 });
    const { sd } = cornerStats(frame.data, frame.width);
    // Quantisation adds about 1/sqrt(12) in quadrature; the bound is wide
    // enough that this is a check, not a coin toss.
    expect(sd).toBeGreaterThan(4);
    expect(sd).toBeLessThan(6);
  });

  it('makes bright pixels noisier than dark ones under shot noise', () => {
    const shot = patched((base) => ({
      ...base,
      sensor: { ...base.sensor, shotNoise: { enabled: true, scale: 1.2 } },
    }));
    const dim = render(shot, still(), 3, { backgroundLevel: 0.05 });
    const bright = render(shot, still(), 3, { backgroundLevel: 0.8 });

    expect(cornerStats(bright.data, bright.width).sd).toBeGreaterThan(
      cornerStats(dim.data, dim.width).sd,
    );
  });

  it('never produces a value outside the 8-bit range, and never wraps', () => {
    // A saturating beacon with heavy noise: the brightest pixels are pinned at
    // the top of the range. A wrap would turn them into the darkest ones.
    const saturating = patched((base) => ({
      ...base,
      sensor: {
        readNoise: { enabled: true, sigma: 40 },
        shotNoise: { enabled: true, scale: 3 },
      },
    }));
    const frame = render(saturating, still(), 3, { backgroundLevel: 0.95 });

    // Aggregated in a plain loop and asserted once. Three expectations per
    // pixel would be a million assertion calls for one frame, which is slow
    // enough under a loaded test runner to time out — a flaky test that says
    // nothing extra.
    let atCeiling = 0;
    let belowFloor = 0;
    let aboveCeiling = 0;
    let nonInteger = 0;
    for (const value of frame.data) {
      if (value < 0) belowFloor += 1;
      if (value > 255) aboveCeiling += 1;
      if (!Number.isInteger(value)) nonInteger += 1;
      if (value === 255) atCeiling += 1;
    }
    expect({ belowFloor, aboveCeiling, nonInteger }).toEqual({
      belowFloor: 0,
      aboveCeiling: 0,
      nonInteger: 0,
    });
    expect(atCeiling).toBeGreaterThan(0);

    // If clipping wrapped, a frame this bright would be full of near-black
    // pixels. It should have almost none.
    const dark = [...frame.data].filter((value) => value < 40).length;
    expect(dark / frame.data.length).toBeLessThan(0.01);
  });

  it('gives the same frame the same noise field every time', () => {
    const noisy = withReadNoise(5);
    const first = render(noisy, still(), 11);
    const second = render(noisy, still(), 11);
    expect([...second.data]).toEqual([...first.data]);
  });

  it('gives different frames different noise fields', () => {
    const noisy = withReadNoise(5);
    const first = render(noisy, still(), 11, { backgroundLevel: 0.4 });
    const second = render(noisy, still(), 12, { backgroundLevel: 0.4 });
    expect([...second.data]).not.toEqual([...first.data]);
  });

  // The reason for indexing noise by frame rather than by draw count. A live
  // view renders only the newest frame due; a headless run renders every one.
  it('gives a frame the same noise whether earlier frames were rendered or skipped', () => {
    const noisy = withReadNoise(5);
    const sensor = new VirtualCameraSensor({ config: config(noisy) });
    for (let index = 0; index < 40; index += 1) sensor.captureFrame(still(), index).release();
    const afterMany = sensor.captureFrame(still(), 40);
    const warm = new Uint8Array(afterMany.frame.data as Uint8Array);
    afterMany.release();

    const cold = render(noisy, still(), 40);
    expect([...cold.data]).toEqual([...warm]);
  });
});

describe('background in the image', () => {
  it('raises the floor of the whole frame', () => {
    const ambient = patched((base) => ({
      ...base,
      optics: {
        ...base.optics,
        background: {
          enabled: true,
          level: 0.25 as never,
          gradient: 0 as never,
          gradientAngle: 0 as never,
        },
      },
    }));
    const frame = render(ambient, still());
    expect(frame.data[0]).toBe(Math.round(0.25 * 255));
  });

  it('reduces contrast without removing the beacon', () => {
    const ambient = patched((base) => ({
      ...base,
      optics: {
        ...base.optics,
        background: {
          enabled: true,
          level: 0.3 as never,
          gradient: 0 as never,
          gradientAngle: 0 as never,
        },
      },
    }));
    const clean = render(CLEAN_DISTURBANCES, still());
    const hazy = render(ambient, still());

    const cleanMoments = moments(...framePieces(clean));
    const hazyMoments = moments(...framePieces(hazy), 90);

    // The beacon is still the brightest thing and still in the same place.
    expect(hazyMoments.peak).toBeGreaterThan(cleanMoments.peak * 0.9);
    expect(hazyMoments.x!).toBeCloseTo(cleanMoments.x!, 1);
  });
});

describe('attenuation and scintillation in the image', () => {
  it('dims the beacon by the transmittance, leaving the background alone', () => {
    const attenuated = patched((base) => ({
      ...base,
      atmosphere: { ...base.atmosphere, attenuation: { enabled: true, dbPerKm: 10 } },
    }));
    // The emitter sits at 1200 m, so 10 dB/km is 12 dB and a transmittance of
    // about 0.063.
    const clean = render(CLEAN_DISTURBANCES, still());
    const dim = render(attenuated, still());

    const cleanPeak = moments(...framePieces(clean)).peak;
    const dimPeak = moments(...framePieces(dim), 1).peak;
    expect(dimPeak / cleanPeak).toBeGreaterThan(0.04);
    expect(dimPeak / cleanPeak).toBeLessThan(0.09);

    // Nothing was added to the empty corner: attenuation acts on the beacon.
    expect(dim.data[0]).toBe(0);
  });

  it('varies the beacon brightness from frame to frame under scintillation', () => {
    const twinkling = patched((base) => ({
      ...base,
      atmosphere: {
        ...base.atmosphere,
        scintillation: {
          enabled: true,
          logAmplitudeSigma: 0.5,
          correlationTime: 0.02 as never,
        },
      },
    }));
    const peaks = Array.from({ length: 40 }, (_, index) => {
      const frame = render(twinkling, still(), index);
      return moments(...framePieces(frame)).peak;
    });
    const spread = Math.max(...peaks) - Math.min(...peaks);
    expect(spread).toBeGreaterThan(5);
  });
});

describe('the truth record under disturbance', () => {
  it('separates where the emitter is from where its light landed', () => {
    const wandering = patched((base) => ({
      ...base,
      atmosphere: {
        ...base.atmosphere,
        wander: { enabled: true, rms: 2e-3 as never, correlationTime: 1 as never },
      },
    }));
    const frame = render(wandering, still(), 5);
    const projection = frame.truth.projections[0]!;

    expect(projection.imageX).not.toBeNull();
    expect(projection.apparentImageX).not.toBeNull();
    // A 2 mrad wander at fx = 800 px/rad moves the spot well over a pixel.
    expect(Math.abs(projection.apparentImageX! - projection.imageX!)).toBeGreaterThan(0.5);
  });

  it('records the realization that produced the frame', () => {
    const wandering = patched((base) => ({
      ...base,
      atmosphere: {
        ...base.atmosphere,
        wander: { enabled: true, rms: 1e-4 as never, correlationTime: 1 as never },
      },
    }));
    const frame = render(wandering, still(), 7);
    expect(frame.truth.disturbance).not.toBeNull();
    expect(frame.truth.disturbance!.frameIndex).toBe(7);
    expect(frame.truth.disturbance!.dropped).toBe(false);
  });

  it('carries no realization at all on a clean run', () => {
    expect(render(CLEAN_DISTURBANCES, still()).truth.disturbance).toBeNull();
  });

  it('keeps the two image centres identical when wander is off', () => {
    const noisy = patched((base) => ({
      ...base,
      sensor: { ...base.sensor, readNoise: { enabled: true, sigma: 3 } },
    }));
    const projection = render(noisy, still(), 4).truth.projections[0]!;
    expect(projection.apparentImageX).toBe(projection.imageX);
    expect(projection.apparentImageY).toBe(projection.imageY);
  });
});

describe('dropped frames at the sensor', () => {
  const alwaysDrop = patched((base) => ({
    ...base,
    dropouts: { ...base.dropouts, mode: 'independent', probability: 1 as never },
  }));

  it('delivers nothing at all, rather than a black frame', () => {
    const sensor = new VirtualCameraSensor({ config: config(alwaysDrop) });
    const delivered: number[] = [];
    sensor.captureRange(still(), -1, 0.2, (capture) => delivered.push(capture.frame.frameId));

    expect(delivered).toHaveLength(0);
    expect(sensor.framesDropped).toBeGreaterThan(0);
    expect(sensor.framesRasterized).toBe(0);
  });

  it('keeps the four frame counters semantically separate', () => {
    const half = patched((base) => ({
      ...base,
      dropouts: { ...base.dropouts, mode: 'independent', probability: 0.5 as never },
    }));
    const sensor = new VirtualCameraSensor({ config: config(half) });
    let delivered = 0;
    sensor.captureRange(still(), -1, 1, (capture) => {
      void capture;
      delivered += 1;
    });

    // Scheduled is what the clock called for; generated is what was rasterized;
    // dropped is what the sensor failed to produce. Superseded is a display
    // decision and captureRange makes none.
    expect(sensor.framesScheduled).toBe(delivered + sensor.framesDropped);
    expect(sensor.framesRasterized).toBe(delivered);
    expect(sensor.framesSupersededForDisplay).toBe(0);
    expect(sensor.framesDropped).toBeGreaterThan(0);
  });

  it('drops nothing when no dropout is configured', () => {
    const sensor = new VirtualCameraSensor({ config: config(CLEAN_DISTURBANCES) });
    let delivered = 0;
    sensor.captureRange(still(), -1, 1, () => {
      delivered += 1;
    });
    expect(sensor.framesDropped).toBe(0);
    expect(delivered).toBe(sensor.framesScheduled);
  });
});
