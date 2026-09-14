// @vitest-environment node
import { describe, expect, it } from 'vitest';

import { hertz } from '@/core/contracts/units';

import { CameraClock } from './camera-clock';

const RATES = [30, 50, 60, 90, 120] as const;

describe('capture times', () => {
  it('places frame 0 at t = 0', () => {
    expect(new CameraClock(hertz(60)).captureTime(0)).toBe(0);
  });

  it.each(RATES)('%i FPS derives each capture time from the frame index', (rate) => {
    const clock = new CameraClock(hertz(rate));
    for (const index of [1, 7, 100, 9_999]) {
      expect(clock.captureTime(index)).toBe(index / rate);
    }
  });

  it('does not drift over a long schedule', () => {
    // Ten minutes at 60 FPS. An implementation that accumulated `t += 1/60`
    // would be visibly off by here; deriving from the index cannot drift at all.
    const clock = new CameraClock(hertz(60));
    const lastIndex = 36_000;
    expect(clock.captureTime(lastIndex)).toBe(600);
    expect(clock.captureTime(lastIndex) - clock.captureTime(lastIndex - 1)).toBeCloseTo(1 / 60, 12);
  });

  it('rejects a non-positive rate and a bad index', () => {
    expect(() => new CameraClock(hertz(0))).toThrow(RangeError);
    expect(() => new CameraClock(hertz(-30))).toThrow(RangeError);
    expect(() => new CameraClock(hertz(60)).captureTime(-1)).toThrow(RangeError);
    expect(() => new CameraClock(hertz(60)).captureTime(1.5)).toThrow(RangeError);
  });
});

describe('frames due in an interval', () => {
  it('is half-open, so stepping never repeats or skips a frame', () => {
    const clock = new CameraClock(hertz(60));

    // Exactly on a capture boundary: it belongs to the interval that ends there.
    const upTo = clock.framesBetween(-1, 1 / 60);
    expect(upTo.first).toBe(0);
    expect(upTo.last).toBe(1);

    const after = clock.framesBetween(1 / 60, 2 / 60);
    expect(after.first).toBe(2);
    expect(after.last).toBe(2);
  });

  it('reports an empty range when no frame is due', () => {
    const clock = new CameraClock(hertz(30));
    expect(clock.framesBetween(0.001, 0.002).count).toBe(0);
  });

  it('rejects a backwards or non-finite interval', () => {
    const clock = new CameraClock(hertz(60));
    expect(() => clock.framesBetween(1, 0.5)).toThrow(RangeError);
    expect(() => clock.framesBetween(0, Number.NaN)).toThrow(RangeError);
  });
});

describe('frame rates that do not divide the physics tick', () => {
  // 200 Hz physics is 5 ms per tick. 60 FPS is 16.667 ms per frame, which is
  // 3.33 ticks: the rates do not divide. An implementation that captured every
  // `round(200 / 60) = 3` ticks would run at 66.7 FPS — an 11% timing error.
  const PHYSICS_HZ = 200;

  it.each(RATES)('%i FPS produces the right count over 10 s of 200 Hz physics', (rate) => {
    const clock = new CameraClock(hertz(rate));
    const totalTicks = PHYSICS_HZ * 10;

    let produced = 0;
    let previousTime = -1;
    for (let tick = 0; tick <= totalTicks; tick += 1) {
      const now = tick / PHYSICS_HZ;
      produced += clock.framesBetween(previousTime, now).count;
      previousTime = now;
    }

    // Frames at t = 0 .. 10 inclusive.
    expect(produced).toBe(rate * 10 + 1);
  });

  it('60 FPS over 200 Hz keeps exact capture times, not tick-aligned ones', () => {
    const clock = new CameraClock(hertz(60));
    // The third frame is at 50 ms, which is tick 10 exactly; the first is at
    // 16.667 ms, which is not a tick boundary at all.
    expect(clock.captureTime(1)).toBeCloseTo(0.0166666666666, 12);
    expect(clock.captureTime(3)).toBeCloseTo(0.05, 12);
    expect(clock.captureTime(1) * PHYSICS_HZ).not.toBe(
      Math.round(clock.captureTime(1) * PHYSICS_HZ),
    );
  });

  it('produces every frame exactly once when stepped one tick at a time', () => {
    const clock = new CameraClock(hertz(90));
    const seen: number[] = [];

    let previousTime = -1;
    for (let tick = 0; tick <= PHYSICS_HZ * 5; tick += 1) {
      const now = tick / PHYSICS_HZ;
      const range = clock.framesBetween(previousTime, now);
      for (let index = range.first; index <= range.last; index += 1) seen.push(index);
      previousTime = now;
    }

    expect(seen).toEqual(Array.from({ length: seen.length }, (_, i) => i));
    expect(new Set(seen).size).toBe(seen.length);
  });

  it('gives the same schedule however the ticks are grouped', () => {
    // The interactive path advances irregular numbers of ticks per frame; the
    // headless path jumps. The capture schedule must not notice.
    const clock = new CameraClock(hertz(60));
    const totalTicks = PHYSICS_HZ * 4;

    const collect = (groups: readonly number[]): number[] => {
      const seen: number[] = [];
      let previousTime = -1;
      let tick = 0;
      let groupIndex = 0;
      while (tick < totalTicks) {
        const size = Math.min(groups[groupIndex % groups.length]!, totalTicks - tick);
        tick += size;
        const now = tick / PHYSICS_HZ;
        const range = clock.framesBetween(previousTime, now);
        for (let i = range.first; i <= range.last; i += 1) seen.push(i);
        previousTime = now;
        groupIndex += 1;
      }
      return seen;
    };

    const oneAtATime = collect([1]);
    expect(collect([3, 4, 3, 3, 4])).toEqual(oneAtATime);
    expect(collect([17, 1, 40, 2])).toEqual(oneAtATime);
    expect(collect([totalTicks])).toEqual(oneAtATime);
  });
});

describe('frameCountFor', () => {
  it.each(RATES)('%i FPS over 60 s', (rate) => {
    expect(new CameraClock(hertz(rate)).frameCountFor(60)).toBe(rate * 60 + 1);
  });

  it('is zero for a negative duration', () => {
    expect(new CameraClock(hertz(60)).frameCountFor(-1)).toBe(0);
  });
});
