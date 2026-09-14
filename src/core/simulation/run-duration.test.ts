// @vitest-environment node
/**
 * A run is finite.
 *
 * A scenario declares a duration, and the run ends there. Before this was
 * enforced, an interactive session left running would keep producing ticks past
 * the end of the experiment: still "playing", but no longer the experiment
 * anyone configured, and for a seeded manoeuvre already past the end of its
 * generated schedule.
 */

import { describe, expect, it } from 'vitest';

import { seconds } from '@/core/contracts/units';
import { loadScenario } from '@/scenarios';

import { SimulationEngine } from './engine';

const stationary = (): SimulationEngine => new SimulationEngine(loadScenario('stationary'));

describe('run bounds', () => {
  it('derives the final tick from duration and tick rate', () => {
    const engine = stationary();
    // 30 s at 200 Hz.
    expect(engine.finalTick).toBe(6_000);
  });

  it('is not complete before the final tick', () => {
    const engine = stationary();
    expect(engine.isComplete).toBe(false);
    engine.step(5_999);
    expect(engine.isComplete).toBe(false);
  });

  it('is complete at the final tick', () => {
    const engine = stationary();
    engine.step(6_000);
    expect(engine.tick).toBe(6_000);
    expect(engine.isComplete).toBe(true);
  });
});

describe('stepping past the end', () => {
  it('stops at the final tick rather than running on', () => {
    const engine = stationary();
    engine.step(1_000_000);
    expect(engine.tick).toBe(engine.finalTick);
  });

  it('reports how many ticks were actually taken', () => {
    const engine = stationary();
    expect(engine.step(100)).toBe(100);

    const remaining = engine.finalTick - engine.tick;
    expect(engine.step(remaining + 500)).toBe(remaining);
    expect(engine.step(10)).toBe(0);
  });

  it('a repeatedly driven scheduler cannot overshoot', () => {
    // The interactive path: many small advances, which is how an unattended
    // session used to walk past the end one frame at a time.
    const engine = stationary();
    for (let frame = 0; frame < 1_000; frame += 1) engine.step(20);

    expect(engine.tick).toBe(engine.finalTick);
    expect(engine.time).toBeCloseTo(engine.duration, 12);
  });

  it('runs beyond the duration only when explicitly asked', () => {
    const engine = stationary();
    engine.step(6_000);
    expect(engine.step(500, { beyondDuration: true })).toBe(500);
    expect(engine.tick).toBe(6_500);
  });

  it('leaves seeded-manoeuvre mathematics untouched', () => {
    // Bounding the run must not change what the trajectory does at a given
    // time; only how far the run is allowed to get.
    const config = loadScenario('seeded-maneuver');
    const bounded = new SimulationEngine(config);
    const extended = new SimulationEngine({ ...config, duration: seconds(600) });

    bounded.step(4_000);
    extended.step(4_000);

    expect(extended.stateHash()).toBe(bounded.stateHash());
  });

  it('still refuses a fractional step', () => {
    expect(() => stationary().step(1.5)).toThrow(RangeError);
  });
});

describe('reset', () => {
  it('makes a completed run runnable again', () => {
    const engine = stationary();
    engine.step(engine.finalTick);
    expect(engine.isComplete).toBe(true);

    engine.reset();
    expect(engine.isComplete).toBe(false);
    expect(engine.step(10)).toBe(10);
  });
});
