// @vitest-environment node
/**
 * Memory and backpressure.
 *
 * A 640x480 GRAY8 frame is 307,200 bytes; at 60 FPS that is 18 MB/s of fresh
 * allocation if every frame is new. These tests pin down the two policies that
 * keep the live pipeline bounded, and the vocabulary that keeps a display
 * decision from being mistaken for a sensor fault.
 */

import { describe, expect, it } from 'vitest';

import { parseSimulationConfig, type SimulationConfig } from '@/core/contracts/simulation';
import { makeValidRawConfig } from '@/test/fixtures';

import type { EmitterId, OpticalEmitter } from './emitters';
import { FrameBufferPool } from './frame-pool';
import { IdealCameraMount } from './mount';
import { VirtualCameraSensor, copyFramePixels } from './virtual-camera';
import { lerpAngleShortestPath, type SensorWorldSample, type WorldSampler } from './world-sampler';

function config(patch: Record<string, unknown> = {}): SimulationConfig {
  const raw = makeValidRawConfig();
  raw['camera'] = {
    ...(raw['camera'] as Record<string, unknown>),
    width: 64,
    height: 48,
    horizontalFov: 2 * Math.atan(0.4),
    principalPoint: null,
    nearRange: 1,
    farRange: 50_000,
    frameRate: 60,
    initialAzimuth: 0,
    initialElevation: 0,
    backgroundLevel: 0,
    ...patch,
  };
  return parseSimulationConfig(raw);
}

const movingEmitter = (offset: number): OpticalEmitter => ({
  id: 'emitter-0' as EmitterId,
  hostEntityId: 'target-0',
  position: { x: offset, y: 500, z: 0 },
  intensity: 0.9 as never,
  psfSigma: 2 as never,
});

/** A sampler whose emitter drifts with time, so frames genuinely differ. */
const driftingSampler = (): WorldSampler => ({
  policy: 'exact',
  sampleAt: (time): SensorWorldSample => ({
    time,
    cameraPosition: { x: 0, y: 0, z: 0 },
    platformAzimuth: 0 as never,
    platformElevation: 0 as never,
    emitters: [movingEmitter(time * 40)],
  }),
});

describe('frame buffer pool', () => {
  it('allocates lazily and never beyond its capacity', () => {
    const pool = new FrameBufferPool(1024, 3);
    expect(pool.allocated).toBe(0);

    for (let index = 0; index < 50; index += 1) pool.acquire();

    expect(pool.allocated).toBe(3);
    expect(pool.acquired).toBe(50);
  });

  it('cycles through its buffers in order', () => {
    const pool = new FrameBufferPool(8, 3);
    const first = [pool.acquire(), pool.acquire(), pool.acquire()];
    const second = [pool.acquire(), pool.acquire(), pool.acquire()];
    expect(second[0]).toBe(first[0]);
    expect(second[1]).toBe(first[1]);
    expect(second[2]).toBe(first[2]);
  });

  it('rejects a nonsensical size or capacity', () => {
    expect(() => new FrameBufferPool(0, 3)).toThrow(RangeError);
    expect(() => new FrameBufferPool(1024, 0)).toThrow(RangeError);
    expect(() => new FrameBufferPool(1024.5, 3)).toThrow(RangeError);
  });
});

describe('sensor memory', () => {
  it('does not grow with the number of frames produced', () => {
    const sensor = new VirtualCameraSensor({ config: config(), poolCapacity: 2 });
    const sampler = driftingSampler();

    for (let index = 0; index < 500; index += 1) sensor.captureFrame(sampler, index);

    expect(sensor.framesRasterized).toBe(500);
    expect(sensor.buffersAllocated).toBe(2);
  });

  it('recycles a buffer once the ring wraps, which is why copies exist', () => {
    // The sharp edge, asserted rather than left to be discovered: a retained
    // frame's pixels change underneath it. `copyFramePixels` is the escape.
    const sensor = new VirtualCameraSensor({ config: config(), poolCapacity: 2 });
    const sampler = driftingSampler();

    const first = sensor.captureFrame(sampler, 0);
    const owned = copyFramePixels(first.frame);
    const borrowed = first.frame.data as Uint8Array;

    sensor.captureFrame(sampler, 40);
    sensor.captureFrame(sampler, 80);

    expect(borrowed).not.toEqual(owned);
    expect(owned.length).toBe(64 * 48);
  });

  it('hands out an independent copy', () => {
    const sensor = new VirtualCameraSensor({ config: config() });
    const capture = sensor.captureFrame(driftingSampler(), 0);
    const copy = copyFramePixels(capture.frame);

    expect(copy).not.toBe(capture.frame.data);
    expect(copy).toEqual(capture.frame.data);
  });
});

describe('backpressure', () => {
  it('rasterizes only the newest frame for display, and says how many it skipped', () => {
    const sensor = new VirtualCameraSensor({ config: config() });
    const sampler = driftingSampler();

    // A 250 ms stall at 60 FPS schedules 15 frames; a viewer can look at one.
    const result = sensor.captureLatest(sampler, 0, 0.25);

    expect(result.capture?.frame.frameId).toBe(15);
    expect(result.supersededForDisplay).toBe(14);
    expect(sensor.framesScheduled).toBe(15);
    expect(sensor.framesRasterized).toBe(1);
  });

  it('counts superseded display frames separately from sensor dropouts', () => {
    // The sensor produced every frame it was asked for. Reporting these as
    // dropped camera frames would blame the instrument for a UI decision.
    const sensor = new VirtualCameraSensor({ config: config() });
    const result = sensor.captureLatest(driftingSampler(), 0, 0.25);

    expect(sensor.framesSupersededForDisplay).toBe(14);
    expect(result.capture?.frame.droppedSince).toBeNull();
  });

  it('returns nothing when no frame is due', () => {
    const sensor = new VirtualCameraSensor({ config: config() });
    const result = sensor.captureLatest(driftingSampler(), 0.001, 0.002);
    expect(result.capture).toBeNull();
    expect(result.supersededForDisplay).toBe(0);
  });

  it('keeps every frame when the caller asks for the range', () => {
    const sensor = new VirtualCameraSensor({ config: config() });
    const seen: number[] = [];
    sensor.captureRange(driftingSampler(), 0, 0.25, (c) => seen.push(c.frame.frameId));

    expect(seen).toEqual(Array.from({ length: 15 }, (_, index) => index + 1));
    expect(sensor.framesSupersededForDisplay).toBe(0);
  });
});

describe('ideal camera mount', () => {
  it('adopts a commanded pose immediately', () => {
    // No dynamics in Phase 2, stated by the class name and asserted here so
    // nobody mistakes it for the actuator model that replaces it later.
    const mount = new IdealCameraMount(0, 0);
    mount.commandTo(0.3, 0.2);
    expect(mount.azimuth).toBeCloseTo(0.3, 12);
    expect(mount.elevation).toBeCloseTo(0.2, 12);
  });

  it('wraps azimuth rather than accumulating it', () => {
    const mount = new IdealCameraMount(0, 0);
    mount.commandTo(Math.PI + 0.1, 0);
    expect(mount.azimuth).toBeCloseTo(-Math.PI + 0.1, 9);
  });

  it('nudges relative to the current pose', () => {
    const mount = new IdealCameraMount(0.1, 0.1);
    mount.nudge(0.05, -0.02);
    expect(mount.azimuth).toBeCloseTo(0.15, 12);
    expect(mount.elevation).toBeCloseTo(0.08, 12);
  });

  it('returns to its initial pose on reset', () => {
    const mount = new IdealCameraMount(0.25, -0.1);
    mount.commandTo(1, 0.5);
    mount.reset();
    expect(mount.azimuth).toBeCloseTo(0.25, 12);
    expect(mount.elevation).toBeCloseTo(-0.1, 12);
  });

  it('refuses a non-finite command', () => {
    const mount = new IdealCameraMount(0, 0);
    expect(() => mount.commandTo(Number.NaN, 0)).toThrow(RangeError);
    expect(() => mount.commandTo(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });

  it('is reset along with the sensor', () => {
    const sensor = new VirtualCameraSensor({ config: config({ initialAzimuth: 0.2 }) });
    sensor.mount.commandTo(1.1, 0.3);
    sensor.reset();

    expect(sensor.mount.azimuth).toBeCloseTo(0.2, 12);
    expect(sensor.framesRasterized).toBe(0);
  });
});

describe('shortest-path angular interpolation', () => {
  it('takes the short way across the branch cut', () => {
    // 3.1 to -3.1 is a 0.083 rad step, not a 6.2 rad sweep the other way.
    const midpoint = lerpAngleShortestPath(3.1, -3.1, 0.5);
    expect(Math.abs(midpoint)).toBeGreaterThan(3.1);
    expect(Math.abs(midpoint)).toBeLessThanOrEqual(Math.PI);
  });

  it('interpolates normally away from the cut', () => {
    expect(lerpAngleShortestPath(0.2, 0.6, 0.5)).toBeCloseTo(0.4, 12);
  });

  it('returns the endpoints', () => {
    expect(lerpAngleShortestPath(0.3, 1.2, 0)).toBeCloseTo(0.3, 12);
    expect(lerpAngleShortestPath(0.3, 1.2, 1)).toBeCloseTo(1.2, 12);
  });

  it('never takes a step longer than pi', () => {
    for (const [from, to] of [
      [0, Math.PI - 0.01],
      [-3.0, 3.0],
      [3.0, -3.0],
      [1.5, -1.5],
    ] as const) {
      const step = lerpAngleShortestPath(from, to, 1) - from;
      const wrapped = Math.atan2(Math.sin(step), Math.cos(step));
      expect(Math.abs(wrapped)).toBeLessThanOrEqual(Math.PI + 1e-12);
    }
  });
});
