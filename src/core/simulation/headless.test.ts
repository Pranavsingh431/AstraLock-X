// @vitest-environment node
/**
 * Headless execution.
 *
 * This file runs in the plain Node environment rather than jsdom, so there is
 * no `document`, no `window`, no canvas and no WebGL. If the simulation core
 * ever acquired a dependency on any of them, this file would fail to run —
 * which is the point. A future AstraBench runner executes exactly this way.
 */

import { describe, expect, it } from 'vitest';

import { loadScenario } from '@/scenarios';

import { PlaybackScheduler } from './clock';
import { SimulationEngine } from './engine';

describe('environment', () => {
  it('has no DOM', () => {
    expect(typeof document).toBe('undefined');
    expect(typeof window).toBe('undefined');
  });
});

describe('headless stepping', () => {
  it('runs a scenario with no renderer present', () => {
    const engine = new SimulationEngine(loadScenario('circular'));
    engine.step(10_000);

    expect(engine.tick).toBe(10_000);
    expect(Number.isFinite(engine.snapshot().truth.targets[0]!.range)).toBe(true);
  });

  it('reaches the same state as interactive scheduling', () => {
    // The equivalence AstraBench will depend on: the interactive path differs
    // only in *when* ticks are requested, never in what a tick does.
    const target = 5_000;

    const headless = new SimulationEngine(loadScenario('seeded-maneuver'));
    headless.step(target);

    const interactive = new SimulationEngine(loadScenario('seeded-maneuver'));
    const scheduler = new PlaybackScheduler({ tickRate: interactive.config.tickRate });
    scheduler.start();

    // Irregular frame times, as a real display produces.
    const frameTimes = [1 / 60, 1 / 59.4, 1 / 61.2, 1 / 30, 1 / 144];
    let frame = 0;
    while (interactive.tick < target) {
      const budget = scheduler.advance(frameTimes[frame % frameTimes.length]!);
      interactive.step(Math.min(budget.ticks, target - interactive.tick));
      frame += 1;
    }

    expect(interactive.tick).toBe(target);
    expect(interactive.stateHash()).toBe(headless.stateHash());
  });

  it('is unaffected by pauses in the driving loop', () => {
    // A UI that freezes for half a second must not inject that time into the
    // physics.
    const target = 2_000;

    const uninterrupted = new SimulationEngine(loadScenario('sinusoidal'));
    uninterrupted.step(target);

    const interrupted = new SimulationEngine(loadScenario('sinusoidal'));
    const scheduler = new PlaybackScheduler({ tickRate: interrupted.config.tickRate });
    scheduler.start();

    while (interrupted.tick < target) {
      if (interrupted.tick === 500) {
        scheduler.pause();
        scheduler.advance(30);
        scheduler.resume();
      }
      const budget = scheduler.advance(1 / 60);
      interrupted.step(Math.min(budget.ticks, target - interrupted.tick));
    }

    expect(interrupted.stateHash()).toBe(uninterrupted.stateHash());
  });

  it('is unaffected by how often snapshots are taken', () => {
    // Snapshotting is observation. Observing more often must not change the run.
    const quiet = new SimulationEngine(loadScenario('waypoints'));
    quiet.step(3_000);

    const observed = new SimulationEngine(loadScenario('waypoints'));
    for (let index = 0; index < 3_000; index += 1) {
      observed.step(1);
      observed.snapshot();
    }

    expect(observed.stateHash()).toBe(quiet.stateHash());
  });
});
