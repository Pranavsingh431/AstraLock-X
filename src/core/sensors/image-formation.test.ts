// @vitest-environment node
/**
 * Actual pixels, not just the projection helper.
 *
 * A projection that lands in the right place is worth nothing if the
 * rasteriser then writes the wrong thing, so these tests read the buffer.
 */

import { describe, expect, it } from 'vitest';

import { parseSimulationConfig, type SimulationConfig } from '@/core/contracts/simulation';
import { makeValidRawConfig } from '@/test/fixtures';

import type { EmitterId, OpticalEmitter } from './emitters';
import type { Vec3Lite } from './pinhole';
import { addGaussianPointSource, fillBackground, psfRadiusPixels, type RasterTarget } from './psf';
import { VirtualCameraSensor } from './virtual-camera';
import type { SensorWorldSample, WorldSampler } from './world-sampler';

const FOV_FOR_FX_800 = 2 * Math.atan(0.4);

function config(patch: Record<string, unknown> = {}): SimulationConfig {
  const raw = makeValidRawConfig();
  raw['camera'] = {
    ...(raw['camera'] as Record<string, unknown>),
    width: 64,
    height: 48,
    horizontalFov: FOV_FOR_FX_800,
    principalPoint: null,
    nearRange: 1,
    farRange: 50_000,
    frameRate: 60,
    backgroundLevel: 0,
    ...patch,
  };
  return parseSimulationConfig(raw);
}

let counter = 0;
const emitter = (position: Vec3Lite, intensity = 0.9, psfSigma = 2): OpticalEmitter => {
  counter += 1;
  return {
    id: `emitter-${String(counter)}` as EmitterId,
    hostEntityId: 'target-0',
    position,
    intensity: intensity as never,
    psfSigma: psfSigma as never,
    code: null,
  };
};

const sampler = (emitters: readonly OpticalEmitter[]): WorldSampler => ({
  policy: 'exact',
  sampleAt: (time): SensorWorldSample => ({
    time,
    cameraPosition: { x: 0, y: 0, z: 0 },
    cameraPose: {
      trueAzimuth: 0,
      trueElevation: 0,
      measuredAzimuth: 0,
      measuredElevation: 0,
      measuredAzimuthRate: 0,
      measuredElevationRate: 0,
    },
    emitters,
  }),
});

const capture = (emitters: readonly OpticalEmitter[], patch: Record<string, unknown> = {}) =>
  new VirtualCameraSensor({ config: config(patch) }).captureFrame(sampler(emitters), 0);

const sum = (data: Uint8Array): number => data.reduce((total, value) => total + value, 0);

describe('frame shape', () => {
  it('has the configured dimensions and byte length', () => {
    const { frame } = capture([]);
    expect(frame.width).toBe(64);
    expect(frame.height).toBe(48);
    expect(frame.data.length).toBe(64 * 48);
    expect(frame.format).toBe('mono8');
  });

  it('contains only values the format can hold', () => {
    const { frame } = capture([emitter({ x: 0, y: 500, z: 0 }, 1)]);
    for (const value of frame.data as Uint8Array) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(255);
    }
  });
});

describe('background', () => {
  it('is empty with no emitters', () => {
    expect(sum(capture([]).frame.data as Uint8Array)).toBe(0);
  });

  it('honours a configured pedestal', () => {
    const { frame } = capture([], { backgroundLevel: 0.2 });
    const data = frame.data as Uint8Array;
    const expected = Math.round(0.2 * 255);
    expect(data[0]).toBe(expected);
    expect(data[data.length - 1]).toBe(expected);
  });

  it('adds emitter light on top of the pedestal', () => {
    const dark = capture([emitter({ x: 0, y: 500, z: 0 }, 0.2)]);
    const lit = capture([emitter({ x: 0, y: 500, z: 0 }, 0.2)], { backgroundLevel: 0.1 });
    expect(sum(lit.frame.data as Uint8Array)).toBeGreaterThan(sum(dark.frame.data as Uint8Array));
  });
});

describe('a single emitter', () => {
  it('writes a non-empty point spread', () => {
    const { frame, truth } = capture([emitter({ x: 0, y: 500, z: 0 })]);
    expect(truth.projections[0]!.pixelsWritten).toBeGreaterThan(0);
    expect(sum(frame.data as Uint8Array)).toBeGreaterThan(0);
  });

  it('spreads further for a larger sigma', () => {
    const tight = capture([emitter({ x: 0, y: 500, z: 0 }, 0.9, 1)]);
    const broad = capture([emitter({ x: 0, y: 500, z: 0 }, 0.9, 3)]);
    expect(broad.truth.projections[0]!.pixelsWritten).toBeGreaterThan(
      tight.truth.projections[0]!.pixelsWritten,
    );
  });

  it('is brighter for a higher intensity', () => {
    const dim = capture([emitter({ x: 0, y: 500, z: 0 }, 0.3)]);
    const bright = capture([emitter({ x: 0, y: 500, z: 0 }, 0.9)]);
    expect(sum(bright.frame.data as Uint8Array)).toBeGreaterThan(sum(dim.frame.data as Uint8Array));
  });

  it('contributes nothing when off the image', () => {
    const { frame, truth } = capture([emitter({ x: 5000, y: 500, z: 0 })]);
    expect(truth.projections[0]!.visibility).toBe('outside-fov');
    expect(truth.projections[0]!.pixelsWritten).toBe(0);
    expect(sum(frame.data as Uint8Array)).toBe(0);
  });
});

describe('several emitters', () => {
  it('draws one point spread per visible emitter', () => {
    const { frame, truth } = capture([
      emitter({ x: -60, y: 500, z: 0 }),
      emitter({ x: 60, y: 500, z: 0 }),
    ]);

    expect(truth.projections).toHaveLength(2);
    for (const projection of truth.projections) {
      expect(projection.visibility).toBe('visible');
      expect(projection.pixelsWritten).toBeGreaterThan(0);
    }

    // Two separated peaks, left and right of centre.
    const data = frame.data as Uint8Array;
    const row = 24 * 64;
    const left = data.slice(row, row + 32).reduce((a, b) => a + b, 0);
    const right = data.slice(row + 32, row + 64).reduce((a, b) => a + b, 0);
    expect(left).toBeGreaterThan(0);
    expect(right).toBeGreaterThan(0);
  });

  it('adds overlapping contributions rather than taking the brighter', () => {
    // Taking the maximum would make two coincident beacons indistinguishable
    // from one, which is exactly the case a multi-target tracker must resolve.
    const single = capture([emitter({ x: 0, y: 500, z: 0 }, 0.2)]);
    const double = capture([
      emitter({ x: 0, y: 500, z: 0 }, 0.2),
      emitter({ x: 0, y: 500, z: 0 }, 0.2),
    ]);
    expect(sum(double.frame.data as Uint8Array)).toBeGreaterThan(
      sum(single.frame.data as Uint8Array) * 1.8,
    );
  });

  it('handles a mix of visible and invisible emitters', () => {
    const { truth } = capture([
      emitter({ x: 0, y: 500, z: 0 }),
      emitter({ x: 0, y: -500, z: 0 }),
      emitter({ x: 9000, y: 500, z: 0 }),
    ]);
    expect(truth.projections.map((p) => p.visibility)).toEqual([
      'visible',
      'behind-camera',
      'outside-fov',
    ]);
  });
});

describe('saturation', () => {
  it('clips at the format maximum instead of wrapping', () => {
    // Uint8Array would wrap a 300 to 44, turning the brightest pixel in the
    // image into a nearly dark one.
    const { frame } = capture([
      emitter({ x: 0, y: 500, z: 0 }, 1),
      emitter({ x: 0, y: 500, z: 0 }, 1),
      emitter({ x: 0, y: 500, z: 0 }, 1),
    ]);
    const data = frame.data as Uint8Array;
    const peak = Math.max(...data);
    expect(peak).toBe(255);
  });

  it('never exceeds the maximum anywhere', () => {
    const { frame } = capture(
      Array.from({ length: 6 }, () => emitter({ x: 0, y: 500, z: 0 }, 1, 4)),
    );
    for (const value of frame.data as Uint8Array) expect(value).toBeLessThanOrEqual(255);
  });
});

describe('the rasteriser directly', () => {
  const makeTarget = (width = 32, height = 32): RasterTarget => ({
    data: new Uint8Array(width * height),
    width,
    height,
    maxValue: 255,
  });

  it('bounds the kernel at three sigma', () => {
    expect(psfRadiusPixels(2)).toBe(6);
    expect(psfRadiusPixels(1.5)).toBe(5);
  });

  it('rejects a non-positive sigma', () => {
    expect(() => addGaussianPointSource(makeTarget(), 16, 16, 200, 0)).toThrow(RangeError);
    expect(() => addGaussianPointSource(makeTarget(), 16, 16, 200, -1)).toThrow(RangeError);
  });

  it('rejects a non-finite centre', () => {
    expect(() => addGaussianPointSource(makeTarget(), Number.NaN, 16, 200, 2)).toThrow(RangeError);
  });

  it('writes nothing for a centre far outside the image', () => {
    const target = makeTarget();
    expect(addGaussianPointSource(target, -100, -100, 255, 2)).toBe(0);
    expect(target.data.every((value) => value === 0)).toBe(true);
  });

  it('fills a background level', () => {
    const target = makeTarget(4, 4);
    fillBackground(target, 42);
    expect([...target.data]).toEqual(Array.from({ length: 16 }, () => 42));
  });

  it('clamps a background level to the format range', () => {
    const target = makeTarget(2, 2);
    fillBackground(target, 9999);
    expect([...target.data]).toEqual([255, 255, 255, 255]);
  });

  it('is symmetric about a centre on a pixel boundary', () => {
    const target = makeTarget(32, 32);
    addGaussianPointSource(target, 16, 16, 200, 2);
    const at = (x: number, y: number): number => target.data[y * 32 + x]!;
    for (let offset = 1; offset <= 4; offset += 1) {
      expect(at(16 - offset, 15)).toBe(at(15 + offset, 15));
    }
  });
});
