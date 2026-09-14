import { describe, expect, it } from 'vitest';

import { hertz } from '@/core/contracts/units';

import { PLAYBACK_SPEEDS, PlaybackScheduler, SimulationClock } from './clock';

describe('SimulationClock', () => {
  it('derives time from the tick counter rather than accumulating', () => {
    const clock = new SimulationClock(hertz(200));
    clock.advance(1000);

    // 1000 ticks at 200 Hz is exactly 5 s. An accumulated `t += 0.005` would
    // land a few ulps away and drift further with every tick.
    expect(clock.tick).toBe(1000);
    expect(clock.time).toBe(5);
  });

  it('reports the same time however the ticks were grouped', () => {
    const stepped = new SimulationClock(hertz(60));
    for (let index = 0; index < 1000; index += 1) stepped.advance(1);

    const jumped = new SimulationClock(hertz(60));
    jumped.advance(1000);

    expect(stepped.tick).toBe(jumped.tick);
    expect(stepped.time).toBe(jumped.time);
  });

  it('exposes the fixed timestep', () => {
    expect(new SimulationClock(hertz(200)).fixedTimestep).toBeCloseTo(0.005, 15);
  });

  it('returns to tick zero on reset', () => {
    const clock = new SimulationClock(hertz(100));
    clock.advance(4321);
    clock.reset();
    expect(clock.tick).toBe(0);
    expect(clock.time).toBe(0);
  });

  it('refuses a fractional or negative tick count', () => {
    const clock = new SimulationClock(hertz(100));
    expect(() => clock.advance(1.5)).toThrow(RangeError);
    expect(() => clock.advance(-1)).toThrow(RangeError);
  });

  it('refuses a non-positive tick rate', () => {
    expect(() => new SimulationClock(hertz(0))).toThrow(RangeError);
    expect(() => new SimulationClock(hertz(-50))).toThrow(RangeError);
  });
});

describe('PlaybackScheduler', () => {
  const scheduler = (): PlaybackScheduler => new PlaybackScheduler({ tickRate: hertz(100) });

  it('starts idle and emits no ticks until started', () => {
    const playback = scheduler();
    expect(playback.status).toBe('idle');
    expect(playback.advance(1).ticks).toBe(0);
  });

  it('converts wall-clock seconds into whole ticks at 1x', () => {
    const playback = scheduler();
    playback.start();
    expect(playback.advance(1).ticks).toBe(100);
  });

  it('carries the sub-tick remainder rather than dropping it', () => {
    // Four frames shorter than one tick must still produce ticks. Flooring
    // without carrying the remainder would emit none of them, and simulated
    // time would stand still at high frame rates.
    const playback = scheduler();
    playback.start();

    let total = 0;
    for (let frame = 0; frame < 4; frame += 1) total += playback.advance(0.005).ticks;
    expect(total).toBe(2);
  });

  it('does not drift over many frames', () => {
    // Sixty frames of 1/60 s sum to fractionally under a second in binary
    // floating point, so the count may land one short on any given second; what
    // must not happen is that the shortfall accumulates.
    const playback = scheduler();
    playback.start();

    let total = 0;
    for (let frame = 0; frame < 600; frame += 1) total += playback.advance(1 / 60).ticks;

    // Ten wall-clock seconds at 100 Hz, to within a single tick.
    expect(total).toBeGreaterThanOrEqual(999);
    expect(total).toBeLessThanOrEqual(1000);
  });

  it('emits no ticks while paused', () => {
    const playback = scheduler();
    playback.start();
    playback.advance(0.5);
    playback.pause();

    expect(playback.advance(10).ticks).toBe(0);
    expect(playback.status).toBe('paused');
  });

  it('does not replay the pause as a backlog on resume', () => {
    // A tool left paused over lunch must not try to catch up on resume.
    const playback = scheduler();
    playback.start();
    playback.pause();
    playback.advance(600);
    playback.resume();

    expect(playback.advance(1 / 60).ticks).toBeLessThanOrEqual(2);
  });

  it('scales throughput with the playback multiplier', () => {
    // Driven at a realistic frame cadence. A single one-second `advance` would
    // exceed the catch-up ceiling at 4x, which is the ceiling working, not the
    // multiplier failing.
    for (const speed of PLAYBACK_SPEEDS) {
      const playback = scheduler();
      playback.start();
      playback.setSpeed(speed);

      let total = 0;
      for (let frame = 0; frame < 60; frame += 1) total += playback.advance(1 / 60).ticks;

      const expected = 100 * speed;
      expect(total).toBeGreaterThanOrEqual(expected - 1);
      expect(total).toBeLessThanOrEqual(expected);
    }
  });

  it('clamps a long stall instead of emitting every missed tick', () => {
    // A backgrounded tab reports an enormous delta on its next frame.
    const playback = new PlaybackScheduler({ tickRate: hertz(100), maxTicksPerAdvance: 240 });
    playback.start();

    const budget = playback.advance(60);
    expect(budget.ticks).toBe(240);
    expect(budget.clamped).toBe(true);
  });

  it('does not accumulate an unpayable debt after clamping', () => {
    const playback = new PlaybackScheduler({ tickRate: hertz(100), maxTicksPerAdvance: 240 });
    playback.start();
    playback.advance(60);

    const next = playback.advance(1 / 60);
    expect(next.clamped).toBe(false);
    expect(next.ticks).toBeLessThanOrEqual(2);
  });

  it('reports alpha inside one tick', () => {
    const playback = scheduler();
    playback.start();
    const budget = playback.advance(0.015);

    expect(budget.ticks).toBe(1);
    expect(budget.alpha).toBeGreaterThanOrEqual(0);
    expect(budget.alpha).toBeLessThan(1);
  });

  it('rejects a negative or non-finite elapsed time', () => {
    const playback = scheduler();
    playback.start();
    expect(() => playback.advance(-1)).toThrow(RangeError);
    expect(() => playback.advance(Number.NaN)).toThrow(RangeError);
  });

  it('returns to idle on reset', () => {
    const playback = scheduler();
    playback.start();
    playback.advance(1);
    playback.reset();
    expect(playback.status).toBe('idle');
  });
});
