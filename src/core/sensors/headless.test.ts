// @vitest-environment node
/**
 * The sensor runs without a browser.
 *
 * Plain Node: no `document`, no `window`, no canvas, no WebGL. If the camera
 * ever needed a GPU readback to produce a frame, this file would stop running —
 * which is the point, because a future benchmark runner has no display and a
 * result that only exists inside a canvas cannot be scored (ADR-0009).
 */

import { describe, expect, it } from 'vitest';

import { loadScenario } from '@/scenarios';
import { PlaybackScheduler } from '@/core/simulation/clock';
import { SimulationEngine } from '@/core/simulation/engine';

import { VirtualCameraSensor } from './virtual-camera';
import { ExactWorldSampler, InterpolatingWorldSampler } from './world-sampler';

describe('environment', () => {
  it('has no DOM, canvas or WebGL', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
    expect(typeof HTMLCanvasElement).toBe('undefined');
    expect(typeof WebGLRenderingContext).toBe('undefined');
  });
});

describe('generating frames headlessly', () => {
  it('produces real pixels from the world with no renderer present', () => {
    const engine = new SimulationEngine(loadScenario('camera-boresight'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const sampler = new ExactWorldSampler(engine);

    const captured: { frameId: number; sum: number }[] = [];
    let previousTime = -1;

    for (let block = 0; block < 20; block += 1) {
      engine.step(10);
      const now = engine.time;
      sensor.captureRange(sampler, previousTime, now, (capture) => {
        captured.push({
          frameId: capture.frame.frameId,
          sum: (capture.frame.data as Uint8Array).reduce((a, b) => a + b, 0),
        });
      });
      previousTime = now;
    }

    // 200 ticks at 200 Hz is 1 s; at 60 FPS that is frames 0..60.
    expect(captured).toHaveLength(61);
    expect(captured.map((c) => c.frameId)).toEqual(Array.from({ length: 61 }, (_, index) => index));
    // The boresight scenario points straight at its beacon, so every frame has light.
    expect(captured.every((c) => c.sum > 0)).toBe(true);
  });

  it('gives the same capture schedule under interactive scheduling', () => {
    // The interactive path differs only in when ticks are requested. If the
    // camera schedule noticed, sensor timestamps would be a property of the
    // machine that ran the experiment.
    const target = 400;

    const runHeadless = (): number[] => {
      const engine = new SimulationEngine(loadScenario('camera-boresight'));
      const sensor = new VirtualCameraSensor({ config: engine.config });
      const sampler = new ExactWorldSampler(engine);
      const ids: number[] = [];

      const before = engine.time;
      engine.step(target);
      sensor.captureRange(sampler, before - 1e-9, engine.time, (c) => ids.push(c.frame.frameId));
      return ids;
    };

    const runInteractive = (frameTimes: readonly number[]): number[] => {
      const engine = new SimulationEngine(loadScenario('camera-boresight'));
      const sensor = new VirtualCameraSensor({ config: engine.config });
      const sampler = new ExactWorldSampler(engine);
      const scheduler = new PlaybackScheduler({ tickRate: engine.config.tickRate });
      scheduler.start();

      const ids: number[] = [];
      let previousTime = -1e-9;
      let index = 0;
      while (engine.tick < target) {
        const budget = scheduler.advance(frameTimes[index % frameTimes.length]!);
        engine.step(Math.min(budget.ticks, target - engine.tick));
        const now = engine.time;
        sensor.captureRange(sampler, previousTime, now, (c) => ids.push(c.frame.frameId));
        previousTime = now;
        index += 1;
      }
      return ids;
    };

    const headless = runHeadless();
    // A 60 Hz display, a 144 Hz display, and a stuttering one.
    expect(runInteractive([1 / 60])).toEqual(headless);
    expect(runInteractive([1 / 144])).toEqual(headless);
    expect(runInteractive([1 / 59.4, 1 / 61.2, 1 / 30, 1 / 144])).toEqual(headless);
  });

  it('gives the same pixels for a frame however the run reached it', () => {
    const frameIndex = 37;

    const pixelsFor = (tickGroups: readonly number[]): Uint8Array => {
      const engine = new SimulationEngine(loadScenario('linear-pass'));
      const sensor = new VirtualCameraSensor({ config: engine.config });
      const sampler = new ExactWorldSampler(engine);

      let index = 0;
      while (engine.tick < 400) {
        engine.step(Math.min(tickGroups[index % tickGroups.length]!, 400 - engine.tick));
        index += 1;
      }
      const capture = sensor.captureFrame(sampler, frameIndex);
      try {
        return new Uint8Array(capture.frame.data as Uint8Array);
      } finally {
        capture.release();
      }
    };

    // Compared by scan rather than with `toEqual`: these are 307,200-element
    // buffers, and vitest's structural equality on typed arrays that size costs
    // seconds per comparison. The assertion is the same one, and a mismatch
    // reports the offending index instead of dumping both buffers.
    const firstDifference = (a: Uint8Array, b: Uint8Array): number => {
      if (a.length !== b.length) return 0;
      for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) return index;
      }
      return -1;
    };

    const reference = pixelsFor([400]);
    expect(firstDifference(pixelsFor([7, 3, 11]), reference)).toBe(-1);
    expect(firstDifference(pixelsFor([1]), reference)).toBe(-1);
  });
});

describe('sampling policies', () => {
  it('exact sampling needs no interpolation at all', () => {
    const engine = new SimulationEngine(loadScenario('linear-pass'));
    const sampler = new ExactWorldSampler(engine);
    expect(sampler.policy).toBe('exact');

    // 16.667 ms is between ticks 3 and 4 at 200 Hz.
    const sample = sampler.sampleAt(1 / 60);
    expect(sample.time).toBeCloseTo(1 / 60, 15);
    expect(sample.emitters).toHaveLength(1);
  });

  it('interpolation between ticks agrees with exact sampling to sub-millimetre', () => {
    // The bound that justifies the interpolating policy existing at all.
    const engine = new SimulationEngine(loadScenario('seeded-maneuver'));
    const exact = new ExactWorldSampler(engine);

    engine.step(100);
    const earlier = engine.snapshot();
    engine.step(1);
    const later = engine.snapshot();

    const interpolating = new InterpolatingWorldSampler(earlier, later, engine.gimbal);
    expect(interpolating.policy).toBe('linear-between-ticks');
    expect(interpolating.intervalSeconds).toBeCloseTo(1 / 200, 12);

    const midTime = (earlier.truth.time + later.truth.time) / 2;
    const a = exact.sampleAt(midTime).emitters[0]!.position;
    const b = interpolating.sampleAt(midTime).emitters[0]!.position;

    const error = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
    // a h^2 / 8 for a = 6 m/s^2 and h = 5 ms is under 19 micrometres.
    expect(error).toBeLessThan(1e-4);
  });

  it('interpolation refuses to extrapolate', () => {
    const engine = new SimulationEngine(loadScenario('linear-pass'));
    engine.step(10);
    const earlier = engine.snapshot();
    engine.step(1);
    const later = engine.snapshot();

    const sampler = new InterpolatingWorldSampler(earlier, later, engine.gimbal);
    expect(() => sampler.sampleAt(later.truth.time + 1)).toThrow(RangeError);
    expect(() => sampler.sampleAt(earlier.truth.time - 1)).toThrow(RangeError);
  });
});
