// @vitest-environment node
/**
 * Camera geometry, checked against known answers.
 *
 * These are the tests that would catch a sign error in the projection, and a
 * sign error is exactly the sort of bug a rendered image hides: a wrong picture
 * still looks like a picture. Every case here has an answer derivable by hand.
 *
 * Camera configuration throughout: 640x480, horizontal field of view chosen so
 * that `fx = fy = 800` exactly, principal point at the image centre (320, 240).
 */

import { describe, expect, it } from 'vitest';

import { parseSimulationConfig, type SimulationConfig } from '@/core/contracts/simulation';
import { makeValidRawConfig } from '@/test/fixtures';

import type { OpticalEmitter, EmitterId } from './emitters';
import type { Vec3Lite } from './pinhole';
import { VirtualCameraSensor } from './virtual-camera';
import type { SensorWorldSample, WorldSampler } from './world-sampler';

/** hfov such that fx = 320 / tan(hfov/2) = 800. */
const FOV_FOR_FX_800 = 2 * Math.atan(0.4);
const CX = 320;
const CY = 240;
const FX = 800;

function config(cameraPatch: Record<string, unknown> = {}): SimulationConfig {
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
    ...cameraPatch,
  };
  return parseSimulationConfig(raw);
}

let emitterCounter = 0;
function emitter(position: Vec3Lite, intensity = 0.9, psfSigma = 2): OpticalEmitter {
  emitterCounter += 1;
  return {
    id: `emitter-${String(emitterCounter)}` as EmitterId,
    hostEntityId: 'target-0',
    position,
    intensity: intensity as never,
    psfSigma: psfSigma as never,
  };
}

/**
 * A sampler with a fixed camera at the origin and fixed emitters.
 *
 * The pointing is supplied here rather than commanded on a mount: since Phase 3
 * the camera pose arrives with the world sample, and these tests are about the
 * pose-to-pixel mapping, not about how the pose was reached. `measured` equals
 * `true` unless a case deliberately separates them, so the geometry under test
 * is unaffected by encoder quantisation.
 */
function staticSampler(
  emitters: readonly OpticalEmitter[],
  cameraPosition: Vec3Lite = { x: 0, y: 0, z: 0 },
  azimuth = 0,
  elevation = 0,
): WorldSampler {
  return {
    policy: 'exact',
    sampleAt: (time): SensorWorldSample => ({
      time,
      cameraPosition,
      cameraPose: {
        trueAzimuth: azimuth,
        trueElevation: elevation,
        measuredAzimuth: azimuth,
        measuredElevation: elevation,
        measuredAzimuthRate: 0,
        measuredElevationRate: 0,
      },
      emitters,
    }),
  };
}

const sensorFor = (
  emitters: readonly OpticalEmitter[],
  cameraPatch: Record<string, unknown> = {},
  azimuth = 0,
  elevation = 0,
): { sensor: VirtualCameraSensor; sampler: WorldSampler } => ({
  sensor: new VirtualCameraSensor({ config: config(cameraPatch) }),
  sampler: staticSampler(emitters, { x: 0, y: 0, z: 0 }, azimuth, elevation),
});

const brightestPixel = (
  data: Uint8Array,
  width: number,
): { x: number; y: number; value: number } => {
  let best = -1;
  let index = 0;
  for (let i = 0; i < data.length; i += 1) {
    if (data[i]! > best) {
      best = data[i]!;
      index = i;
    }
  }
  return { x: index % width, y: Math.floor(index / width), value: best };
};

const sum = (data: Uint8Array): number => data.reduce((total, value) => total + value, 0);

// --- A. Boresight -----------------------------------------------------------

describe('A. boresight', () => {
  it('puts an on-axis emitter at the principal point', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: 1200, z: 0 })]);
    const capture = sensor.captureFrame(sampler, 0);
    const projection = capture.truth.projections[0]!;

    expect(projection.visibility).toBe('visible');
    expect(projection.imageX).toBeCloseTo(CX, 9);
    expect(projection.imageY).toBeCloseTo(CY, 9);
  });

  it('draws a point spread symmetric about the image centre', () => {
    // An even-width image has no centre pixel: the centre falls on the boundary
    // between columns 319 and 320, so the correct answer is symmetry, not a
    // single brightest pixel.
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: 1200, z: 0 })]);
    const { frame } = sensor.captureFrame(sampler, 0);
    const data = frame.data as Uint8Array;
    const at = (x: number, y: number): number => data[y * 640 + x]!;

    expect(at(319, 239)).toBeGreaterThan(0);
    expect(at(320, 239)).toBe(at(319, 239));
    expect(at(319, 240)).toBe(at(319, 239));
    expect(at(320, 240)).toBe(at(319, 239));

    for (let offset = 1; offset <= 3; offset += 1) {
      expect(at(319 - offset, 239)).toBe(at(320 + offset, 239));
      expect(at(319, 239 - offset)).toBe(at(319, 240 + offset));
    }
  });
});

// --- B. East moves right ----------------------------------------------------

describe('B. an emitter to the East', () => {
  it('lands right of centre for a camera facing North', () => {
    const range = 1200;
    const east = 60;
    const { sensor, sampler } = sensorFor([emitter({ x: east, y: range, z: 0 })]);
    const projection = sensor.captureFrame(sampler, 0).truth.projections[0]!;

    expect(projection.imageX).toBeCloseTo(CX + (FX * east) / range, 6);
    expect(projection.imageX!).toBeGreaterThan(CX);
    expect(projection.imageY).toBeCloseTo(CY, 9);
  });

  it('lands left of centre when to the West', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: -60, y: 1200, z: 0 })]);
    expect(sensor.captureFrame(sampler, 0).truth.projections[0]!.imageX!).toBeLessThan(CX);
  });
});

// --- C. Up moves to a lower row --------------------------------------------

describe('C. a higher emitter', () => {
  it('lands above centre, which is a lower row index', () => {
    // Rows increase downward. A target that climbs must move to a smaller v, or
    // the image is upside down.
    const range = 1200;
    const up = 48;
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: range, z: up })]);
    const projection = sensor.captureFrame(sampler, 0).truth.projections[0]!;

    expect(projection.imageY).toBeCloseTo(CY - (FX * up) / range, 6);
    expect(projection.imageY!).toBeLessThan(CY);
  });

  it('lands below centre when lower', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: 1200, z: -48 })]);
    expect(sensor.captureFrame(sampler, 0).truth.projections[0]!.imageY!).toBeGreaterThan(CY);
  });
});

// --- D. Behind the camera ---------------------------------------------------

describe('D. an emitter behind the camera', () => {
  it('produces no pixels at all', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: -1200, z: 0 })]);
    const capture = sensor.captureFrame(sampler, 0);

    expect(capture.truth.projections[0]!.visibility).toBe('behind-camera');
    expect(capture.truth.projections[0]!.imageX).toBeNull();
    expect(sum(capture.frame.data as Uint8Array)).toBe(0);
  });

  it('is reported as behind rather than out of view', () => {
    // Directly behind is a more useful diagnosis than "off the image", which
    // would also be true.
    const { sensor, sampler } = sensorFor([emitter({ x: 10, y: -1200, z: 5 })]);
    expect(sensor.captureFrame(sampler, 0).truth.projections[0]!.visibility).toBe('behind-camera');
  });
});

// --- E / F. Field-of-view edges --------------------------------------------

describe('E. horizontal field-of-view edge', () => {
  // u = 640 when 800 * east / range = 320, i.e. east = 0.4 * range.
  const range = 1000;

  it('is visible just inside', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0.399 * range, y: range, z: 0 })]);
    const projection = sensor.captureFrame(sampler, 0).truth.projections[0]!;
    expect(projection.visibility).toBe('visible');
    expect(projection.imageX!).toBeLessThan(640);
  });

  it('is rejected just outside', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0.401 * range, y: range, z: 0 })]);
    expect(sensor.captureFrame(sampler, 0).truth.projections[0]!.visibility).toBe('outside-fov');
  });

  it('is symmetric on the other side', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: -0.401 * range, y: range, z: 0 })]);
    expect(sensor.captureFrame(sampler, 0).truth.projections[0]!.visibility).toBe('outside-fov');
  });
});

describe('F. vertical field-of-view edge', () => {
  // v = 0 when 800 * up / range = 240, i.e. up = 0.3 * range.
  const range = 1000;

  it('is visible just inside', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: range, z: 0.299 * range })]);
    expect(sensor.captureFrame(sampler, 0).truth.projections[0]!.visibility).toBe('visible');
  });

  it('is rejected just outside', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: range, z: 0.301 * range })]);
    expect(sensor.captureFrame(sampler, 0).truth.projections[0]!.visibility).toBe('outside-fov');
  });

  it('is rejected below as well as above', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: range, z: -0.301 * range })]);
    expect(sensor.captureFrame(sampler, 0).truth.projections[0]!.visibility).toBe('outside-fov');
  });
});

// --- G. Range clipping ------------------------------------------------------

describe('G. range clipping', () => {
  it('rejects an emitter nearer than the near range', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: 5, z: 0 })], { nearRange: 10 });
    const capture = sensor.captureFrame(sampler, 0);
    expect(capture.truth.projections[0]!.visibility).toBe('too-near');
    expect(sum(capture.frame.data as Uint8Array)).toBe(0);
  });

  it('rejects an emitter beyond the far range', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: 90_000, z: 0 })], {
      farRange: 50_000,
    });
    const capture = sensor.captureFrame(sampler, 0);
    expect(capture.truth.projections[0]!.visibility).toBe('too-far');
    expect(sum(capture.frame.data as Uint8Array)).toBe(0);
  });

  it('accepts one exactly between the limits', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: 1200, z: 0 })], {
      nearRange: 100,
      farRange: 5000,
    });
    expect(sensor.captureFrame(sampler, 0).truth.projections[0]!.visibility).toBe('visible');
  });
});

// --- H / I. Manual pointing -------------------------------------------------

describe('H. manual pan', () => {
  it('moves a fixed beacon left when the camera pans East', () => {
    // Turning right sweeps the scene left. u = cx - fx*tan(az) for a beacon
    // due North, so the sign here is the whole correctness of pan.
    const beacon = [emitter({ x: 0, y: 1200, z: 0 })];
    const ahead = sensorFor(beacon);
    const turned = sensorFor(beacon, {}, 0.05, 0);

    const centred = ahead.sensor.captureFrame(ahead.sampler, 0).truth.projections[0]!.imageX!;
    const panned = turned.sensor.captureFrame(turned.sampler, 0).truth.projections[0]!.imageX!;

    expect(panned).toBeLessThan(centred);
    expect(panned).toBeCloseTo(CX - FX * Math.tan(0.05), 6);
  });

  it('moves it right when the camera pans West', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: 1200, z: 0 })], {}, -0.05, 0);
    expect(sensor.captureFrame(sampler, 0).truth.projections[0]!.imageX!).toBeGreaterThan(CX);
  });

  it('does not move the emitter', () => {
    const beacon = [emitter({ x: 0, y: 1200, z: 0 })];
    const ahead = sensorFor(beacon);
    const turned = sensorFor(beacon, {}, 0.4, 0.2);

    const before = ahead.sensor.captureFrame(ahead.sampler, 0).truth.projections[0]!.range;
    expect(turned.sensor.captureFrame(turned.sampler, 0).truth.projections[0]!.range).toBeCloseTo(
      before,
      9,
    );
  });

  it('can bring an out-of-view beacon into view', () => {
    // The Phase 2 workflow: the operator finds the beacon by hand.
    const beacon = [emitter({ x: 600, y: 1200, z: 0 })];
    const ahead = sensorFor(beacon);
    expect(ahead.sensor.captureFrame(ahead.sampler, 0).truth.projections[0]!.visibility).toBe(
      'outside-fov',
    );

    const { sensor, sampler } = sensorFor(beacon, {}, Math.atan2(600, 1200), 0);
    const found = sensor.captureFrame(sampler, 0);
    expect(found.truth.projections[0]!.visibility).toBe('visible');
    expect(found.truth.projections[0]!.imageX).toBeCloseTo(CX, 6);
    expect(sum(found.frame.data as Uint8Array)).toBeGreaterThan(0);
  });
});

describe('I. manual tilt', () => {
  it('moves a fixed beacon down when the camera tilts up', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: 1200, z: 0 })], {}, 0, 0.05);

    const tilted = sensor.captureFrame(sampler, 0).truth.projections[0]!.imageY!;

    expect(tilted).toBeGreaterThan(CY);
    expect(tilted).toBeCloseTo(CY + FX * Math.tan(0.05), 6);
  });

  it('centres a raised beacon when tilted to match', () => {
    const range = 1200;
    const up = 120;
    const { sensor, sampler } = sensorFor(
      [emitter({ x: 0, y: range, z: up })],
      {},
      0,
      Math.atan2(up, range),
    );

    const projection = sensor.captureFrame(sampler, 0).truth.projections[0]!;
    expect(projection.imageX).toBeCloseTo(CX, 6);
    expect(projection.imageY).toBeCloseTo(CY, 6);
  });

  it('still projects sensibly near the zenith', () => {
    // Travel limits now belong to the mount and are covered in the actuator
    // suite. What matters here is that the projection stays well behaved when
    // the pose approaches straight up, where tan(elevation) diverges.
    const nearZenith = Math.PI / 2 - 1e-3;
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: 0, z: 1200 })], {}, 0, nearZenith);

    const projection = sensor.captureFrame(sampler, 0).truth.projections[0]!;
    expect(projection.visibility).toBe('visible');
    expect(projection.imageX).toBeCloseTo(CX, 6);
    expect(Number.isFinite(projection.imageY!)).toBe(true);
  });
});

// --- J. Sub-pixel centres ---------------------------------------------------

describe('J. sub-pixel placement', () => {
  it('shifts the intensity distribution for a sub-pixel move', () => {
    // Rounding the centre to a whole pixel would cap every future centroid at
    // half a pixel of accuracy — worse than the sensor itself.
    const range = 1000;
    const shiftPixels = 0.5;
    const east = (shiftPixels * range) / FX;

    const centred = sensorFor([emitter({ x: 0, y: range, z: 0 })]);
    const shifted = sensorFor([emitter({ x: east, y: range, z: 0 })]);

    const a = centred.sensor.captureFrame(centred.sampler, 0);
    const b = shifted.sensor.captureFrame(shifted.sampler, 0);

    expect(b.truth.projections[0]!.imageX).toBeCloseTo(CX + shiftPixels, 6);
    expect(b.frame.data).not.toEqual(a.frame.data);
  });

  it('moves the intensity centroid by the sub-pixel amount', () => {
    const range = 1000;
    const measureCentroid = (eastMetres: number): number => {
      const { sensor, sampler } = sensorFor([emitter({ x: eastMetres, y: range, z: 0 })]);
      const data = sensor.captureFrame(sampler, 0).frame.data as Uint8Array;

      let weighted = 0;
      let total = 0;
      for (let index = 0; index < data.length; index += 1) {
        const value = data[index]!;
        if (value === 0) continue;
        weighted += (index % 640) * value;
        total += value;
      }
      return weighted / total;
    };

    const base = measureCentroid(0);
    const quarter = measureCentroid((0.25 * range) / FX);
    expect(quarter - base).toBeCloseTo(0.25, 1);
  });
});

// --- K. Edge clipping -------------------------------------------------------

describe('K. a point spread at the image edge', () => {
  it('clips instead of wrapping onto the opposite side', () => {
    // A wrapped write would put light on the far edge of the row above, which
    // is invisible in a thumbnail and fatal to a detector.
    const range = 1000;
    // Place the centre one pixel inside the left edge.
    const east = ((1 - CX) * range) / FX;
    const { sensor, sampler } = sensorFor([emitter({ x: east, y: range, z: 0 })]);
    const { frame, truth } = sensor.captureFrame(sampler, 0);
    const data = frame.data as Uint8Array;

    expect(truth.projections[0]!.imageX).toBeCloseTo(1, 6);
    expect(truth.projections[0]!.pixelsWritten).toBeGreaterThan(0);

    for (let row = 0; row < 480; row += 1) {
      for (let column = 600; column < 640; column += 1) {
        expect(data[row * 640 + column]).toBe(0);
      }
    }
  });

  it('writes nothing outside the buffer for a centre beyond the edge', () => {
    const range = 1000;
    const east = ((644 - CX) * range) / FX;
    const { sensor, sampler } = sensorFor([emitter({ x: east, y: range, z: 0 })]);
    const capture = sensor.captureFrame(sampler, 0);

    expect(capture.truth.projections[0]!.visibility).toBe('outside-fov');
    expect(sum(capture.frame.data as Uint8Array)).toBe(0);
  });

  it('keeps the buffer exactly the declared length', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: 1200, z: 0 })]);
    const { frame } = sensor.captureFrame(sampler, 0);
    expect(frame.data.length).toBe(640 * 480);
    expect(frame.width).toBe(640);
    expect(frame.height).toBe(480);
  });
});

// --- L. Reproducibility -----------------------------------------------------

describe('L. reproducibility', () => {
  it('produces identical pixels for identical inputs', () => {
    const a = sensorFor([emitter({ x: 37, y: 1234, z: -21 })]);
    const b = sensorFor([emitter({ x: 37, y: 1234, z: -21 })]);

    const first = a.sensor.captureFrame(a.sampler, 7);
    const second = b.sensor.captureFrame(b.sampler, 7);

    expect(second.frame.data).toEqual(first.frame.data);
    expect(second.frame.captureTime).toBe(first.frame.captureTime);
    expect(second.truth.projections[0]!.imageX).toBe(first.truth.projections[0]!.imageX);
  });

  it('does not depend on how many frames were taken before', () => {
    const a = sensorFor([emitter({ x: 37, y: 1234, z: -21 })]);
    const b = sensorFor([emitter({ x: 37, y: 1234, z: -21 })]);

    for (let index = 0; index < 20; index += 1) a.sensor.captureFrame(a.sampler, index).release();
    const late = a.sensor.captureFrame(a.sampler, 7);
    const fresh = b.sensor.captureFrame(b.sampler, 7);

    expect(late.frame.data).toEqual(fresh.frame.data);
  });

  it('carries the configuration identifier on every frame', () => {
    const { sensor, sampler } = sensorFor([emitter({ x: 0, y: 1200, z: 0 })]);
    const { frame } = sensor.captureFrame(sampler, 3);
    expect(frame.cameraConfigId).toContain('@v4');
  });
});

describe('brightest pixel sanity', () => {
  it('peaks at the pixel containing the projected centre', () => {
    // Offsets chosen so the centre falls inside a pixel rather than on a
    // boundary, where two pixels would tie by symmetry.
    const range = 1000;
    const { sensor, sampler } = sensorFor([
      emitter({ x: 0.1003 * range, y: range, z: 0.0507 * range }),
    ]);
    const { frame, truth } = sensor.captureFrame(sampler, 0);

    const peak = brightestPixel(frame.data as Uint8Array, 640);
    expect(peak.x).toBe(Math.floor(truth.projections[0]!.imageX!));
    expect(peak.y).toBe(Math.floor(truth.projections[0]!.imageY!));
  });

  it('ties between the two pixels straddling a centre on their boundary', () => {
    // u = 320 + 800 * 0.1 = 400.0 exactly, which is the edge between columns
    // 399 and 400. Equal values there is the correct answer, not a defect.
    const range = 1000;
    const { sensor, sampler } = sensorFor([emitter({ x: 0.1 * range, y: range, z: 0 })]);
    const { frame, truth } = sensor.captureFrame(sampler, 0);
    const data = frame.data as Uint8Array;

    expect(truth.projections[0]!.imageX).toBeCloseTo(400, 9);
    expect(data[240 * 640 + 399]).toBe(data[240 * 640 + 400]);
    expect(data[240 * 640 + 399]!).toBeGreaterThan(0);
  });
});
