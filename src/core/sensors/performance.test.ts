// @vitest-environment node
/**
 * Measured sensor throughput.
 *
 * Numbers, not guesses. The purpose is to establish a clean-sensor baseline and
 * to fail loudly if frame generation ever becomes too slow to run in real time,
 * so that a later optimisation targets something measured rather than suspected.
 *
 * The thresholds are deliberately loose — several times the observed cost — so
 * this is a regression guard rather than a benchmark that fails whenever CI is
 * busy. The measured figures are recorded in docs/PHASE_STATUS.md.
 */

import { describe, expect, it } from 'vitest';

import { parseSimulationConfig, type SimulationConfig } from '@/core/contracts/simulation';
import { makeValidRawConfig } from '@/test/fixtures';

import type { EmitterId, OpticalEmitter } from './emitters';
import { VirtualCameraSensor } from './virtual-camera';
import type { SensorWorldSample, WorldSampler } from './world-sampler';

function config(width: number, height: number): SimulationConfig {
  const raw = makeValidRawConfig();
  raw['camera'] = {
    ...(raw['camera'] as Record<string, unknown>),
    width,
    height,
    horizontalFov: 0.6,
    principalPoint: null,
    nearRange: 1,
    farRange: 50_000,
    frameRate: 60,
    backgroundLevel: 0,
  };
  return parseSimulationConfig(raw);
}

const emitter = (index: number, offset: number): OpticalEmitter => ({
  id: `emitter-${String(index)}` as EmitterId,
  hostEntityId: `target-${String(index)}`,
  position: { x: offset, y: 1200, z: 0 },
  intensity: 0.9 as never,
  psfSigma: 2.5 as never,
  code: null,
});

/** Three emitters drifting across the frame: a representative live scene. */
const sceneSampler = (): WorldSampler => ({
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
    emitters: [emitter(0, time * 20 - 60), emitter(1, time * 20), emitter(2, time * 20 + 60)],
  }),
});

interface Timing {
  readonly mean: number;
  readonly p95: number;
  readonly max: number;
}

function measure(width: number, height: number, samples: number): Timing {
  const sensor = new VirtualCameraSensor({ config: config(width, height) });
  const sampler = sceneSampler();

  // Warm-up, so the first measurement is not paying for the pool's lazy
  // allocation and the JIT's first pass.
  for (let index = 0; index < 30; index += 1) sensor.captureFrame(sampler, index).release();

  const durations: number[] = [];
  for (let index = 0; index < samples; index += 1) {
    const started = performance.now();
    sensor.captureFrame(sampler, index).release();
    durations.push(performance.now() - started);
  }

  durations.sort((a, b) => a - b);
  const total = durations.reduce((sum, value) => sum + value, 0);
  return {
    mean: total / durations.length,
    p95: durations[Math.min(durations.length - 1, Math.floor(durations.length * 0.95))]!,
    max: durations[durations.length - 1]!,
  };
}

describe('frame generation cost', () => {
  it('320x240 is comfortably inside a 60 FPS budget', () => {
    const timing = measure(320, 240, 300);
    // 60 FPS allows 16.67 ms per frame. Three times that headroom is the guard.
    expect(timing.mean).toBeLessThan(5);
    expect(timing.p95).toBeLessThan(16.67);
  });

  it('640x480 is comfortably inside a 60 FPS budget', () => {
    const timing = measure(640, 480, 300);
    expect(timing.mean).toBeLessThan(5);
    expect(timing.p95).toBeLessThan(16.67);
  });

  it('scales with pixel count rather than worse', () => {
    // Cost is dominated by clearing the background, which is linear in area.
    // A superlinear result would mean something is scanning the image per
    // emitter, which is the shape of bug worth catching early.
    const small = measure(320, 240, 200);
    const large = measure(640, 480, 200);
    expect(large.mean).toBeLessThan(Math.max(small.mean * 12, 3));
  });

  it('does not allocate per frame beyond the pool', () => {
    const sensor = new VirtualCameraSensor({ config: config(640, 480), poolCapacity: 3 });
    const sampler = sceneSampler();
    for (let index = 0; index < 600; index += 1) sensor.captureFrame(sampler, index).release();

    expect(sensor.framesRasterized).toBe(600);
    expect(sensor.buffersAllocated).toBe(3);
  });
});
