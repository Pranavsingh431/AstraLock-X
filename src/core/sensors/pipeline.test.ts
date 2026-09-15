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
import { FrameBufferPool, FrameLeaseError } from './frame-pool';
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
  code: null,
});

/** A sampler whose emitter drifts with time, so frames genuinely differ. */
const driftingSampler = (): WorldSampler => ({
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
    emitters: [movingEmitter(time * 40)],
  }),
});

describe('frame buffer pool', () => {
  it('allocates lazily and never beyond its capacity', () => {
    const pool = new FrameBufferPool(1024, 3);
    expect(pool.allocated).toBe(0);

    for (let index = 0; index < 50; index += 1) pool.acquire().release();

    expect(pool.allocated).toBe(3);
    expect(pool.acquired).toBe(50);
  });

  it('cycles through its buffers in order', () => {
    const pool = new FrameBufferPool(8, 3);
    const first = [pool.acquire(), pool.acquire(), pool.acquire()];
    const firstPixels = first.map((lease) => lease.pixels);
    for (const lease of first) lease.release();

    const second = [pool.acquire(), pool.acquire(), pool.acquire()];
    expect(second[0]!.pixels).toBe(firstPixels[0]);
    expect(second[1]!.pixels).toBe(firstPixels[1]);
    expect(second[2]!.pixels).toBe(firstPixels[2]);
  });

  it('rejects a nonsensical size or capacity', () => {
    expect(() => new FrameBufferPool(0, 3)).toThrow(RangeError);
    expect(() => new FrameBufferPool(1024, 0)).toThrow(RangeError);
    expect(() => new FrameBufferPool(1024.5, 3)).toThrow(RangeError);
  });
});

// --- Frame ownership --------------------------------------------------------

/**
 * The lease model, asserted directly.
 *
 * Phase 2's pool recycled buffers silently. That was defensible while every
 * consumer drew the frame and dropped it inside the same synchronous call, but
 * a mount that answers over time means captures are now taken and held, and a
 * buffer changing underneath a held frame is a bug that shows up as impossible
 * pixels rather than as an error. Exhaustion is therefore loud, and use after
 * release throws.
 */
describe('frame ownership', () => {
  it('refuses to hand out more frames than it owns', () => {
    const pool = new FrameBufferPool(64, 2);
    pool.acquire();
    pool.acquire();

    expect(() => pool.acquire()).toThrow(FrameLeaseError);
  });

  it('names the fix in the error, because the fix is not obvious', () => {
    const pool = new FrameBufferPool(64, 1);
    pool.acquire();
    expect(() => pool.acquire()).toThrow(/toOwned/);
  });

  it('throws on use after release instead of returning stale pixels', () => {
    const pool = new FrameBufferPool(64, 1);
    const lease = pool.acquire();
    expect(lease.pixels.length).toBe(64);

    lease.release();

    expect(lease.isReleased).toBe(true);
    expect(() => lease.pixels).toThrow(FrameLeaseError);
  });

  it('treats a second release as a no-op rather than freeing twice', () => {
    // Double release on a ring is worse than a leak: it returns a buffer that
    // someone else now holds.
    const pool = new FrameBufferPool(64, 2);
    const lease = pool.acquire();

    lease.release();
    lease.release();

    expect(pool.leased).toBe(0);
    expect(pool.available).toBe(2);
  });

  it('recovers every buffer when the sensor is reset', () => {
    const sensor = new VirtualCameraSensor({ config: config(), poolCapacity: 2 });
    const sampler = driftingSampler();
    sensor.captureFrame(sampler, 0);
    sensor.captureFrame(sampler, 1);

    sensor.reset();

    // Two more captures would throw if reset had not reclaimed the leases.
    expect(() => {
      sensor.captureFrame(sampler, 2);
      sensor.captureFrame(sampler, 3);
    }).not.toThrow();
  });

  it('lends a frame to a range callback and takes it straight back', () => {
    // captureRange over a long interval would exhaust a two-buffer pool on its
    // third frame if the borrow were not returned.
    const sensor = new VirtualCameraSensor({ config: config(), poolCapacity: 2 });
    const seen: number[] = [];

    sensor.captureRange(driftingSampler(), 0, 0.25, (capture) => {
      seen.push(capture.frame.frameId);
    });

    expect(seen).toHaveLength(15);
  });

  it('releases the borrow even when the callback throws', () => {
    const sensor = new VirtualCameraSensor({ config: config(), poolCapacity: 1 });
    const sampler = driftingSampler();

    expect(() => {
      sensor.captureRange(sampler, 0, 0.05, () => {
        throw new Error('consumer blew up');
      });
    }).toThrow('consumer blew up');

    // The pool is intact: a leaked lease would make this throw FrameLeaseError.
    expect(() => sensor.captureFrame(sampler, 99).release()).not.toThrow();
  });

  it('gives an owned copy that outlives the lease', () => {
    const sensor = new VirtualCameraSensor({ config: config(), poolCapacity: 1 });
    const sampler = driftingSampler();

    const capture = sensor.captureFrame(sampler, 0);
    const owned = capture.toOwned();
    capture.release();

    expect(owned.data.length).toBe(64 * 48);
    expect(() => capture.frame).toThrow(FrameLeaseError);

    // And the pool is free again, so the next capture succeeds.
    const next = sensor.captureFrame(sampler, 40);
    expect(next.frame.data).not.toEqual(owned.data);
  });
});

describe('sensor memory', () => {
  it('does not grow with the number of frames produced', () => {
    const sensor = new VirtualCameraSensor({ config: config(), poolCapacity: 2 });
    const sampler = driftingSampler();

    for (let index = 0; index < 500; index += 1) sensor.captureFrame(sampler, index).release();

    expect(sensor.framesRasterized).toBe(500);
    expect(sensor.buffersAllocated).toBe(2);
  });

  it('recycles a buffer once a lease is returned, which is why copies exist', () => {
    // The sharp edge, asserted rather than left to be discovered: once released,
    // a frame's pixels belong to the pool again. `toOwned` is the escape.
    const sensor = new VirtualCameraSensor({ config: config(), poolCapacity: 1 });
    const sampler = driftingSampler();

    const first = sensor.captureFrame(sampler, 0);
    const owned = copyFramePixels(first.frame);
    const borrowed = first.frame.data as Uint8Array;
    first.release();

    sensor.captureFrame(sampler, 40).release();

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
    result.capture?.release();
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

// The mount that used to be exercised here was Phase 2's ideal one, which
// teleported to whatever it was told. Phase 3 replaced it with DynamicGimbal and
// deleted it; the mechanism is covered by src/core/gimbal/*.test.ts.

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
