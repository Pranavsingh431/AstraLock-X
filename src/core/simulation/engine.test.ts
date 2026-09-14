import { describe, expect, it } from 'vitest';

import { isGroundTruthTainted } from '@/core/contracts/isolation';
import { parseSimulationConfig, type SimulationConfig } from '@/core/contracts/simulation';
import { loadScenario } from '@/scenarios';
import { makeValidRawConfig } from '@/test/fixtures';

import { PlaybackScheduler } from './clock';
import { SimulationEngine } from './engine';

const fixtureConfig = (): SimulationConfig => parseSimulationConfig(makeValidRawConfig());

describe('determinism', () => {
  it('reproduces the same state from the same config', () => {
    const a = new SimulationEngine(fixtureConfig());
    const b = new SimulationEngine(fixtureConfig());

    a.step(500);
    b.step(500);

    expect(b.stateHash()).toBe(a.stateHash());
  });

  it('reproduces a seeded manoeuvre exactly', () => {
    // The stochastic family is the one that could drift; the analytic ones are
    // deterministic almost by construction.
    const a = new SimulationEngine(loadScenario('seeded-maneuver'));
    const b = new SimulationEngine(loadScenario('seeded-maneuver'));

    a.step(4000);
    b.step(4000);

    expect(b.stateHash()).toBe(a.stateHash());
  });

  it('diverges when the seed changes', () => {
    const base = loadScenario('seeded-maneuver');
    const a = new SimulationEngine(base);
    const b = new SimulationEngine({ ...base, seed: (base.seed + 1) as typeof base.seed });

    a.step(2000);
    b.step(2000);

    expect(b.stateHash()).not.toBe(a.stateHash());
  });
});

describe('stepping', () => {
  it('gives the same state however the ticks were grouped', () => {
    // The central claim of a fixed-step engine. If this failed, an interactive
    // run and a headless run of the same scenario would disagree.
    const stepped = new SimulationEngine(loadScenario('seeded-maneuver'));
    for (let index = 0; index < 1000; index += 1) stepped.step(1);

    const jumped = new SimulationEngine(loadScenario('seeded-maneuver'));
    jumped.step(1000);

    expect(stepped.tick).toBe(1000);
    expect(jumped.stateHash()).toBe(stepped.stateHash());
  });

  it('advances exactly one tick per single step', () => {
    const engine = new SimulationEngine(fixtureConfig());
    engine.step(1);
    expect(engine.tick).toBe(1);
    expect(engine.time).toBeCloseTo(1 / engine.config.tickRate, 15);
  });

  it('leaves the world untouched when not stepped', () => {
    // Standing in for "pause changes nothing": the engine only moves when told.
    const engine = new SimulationEngine(loadScenario('circular'));
    engine.step(250);
    const before = engine.stateHash();

    expect(engine.stateHash()).toBe(before);
    expect(engine.tick).toBe(250);
  });

  it('refuses a fractional step', () => {
    const engine = new SimulationEngine(fixtureConfig());
    expect(() => engine.step(2.5)).toThrow(RangeError);
  });
});

describe('reset', () => {
  it('returns exactly to the tick-zero state', () => {
    const engine = new SimulationEngine(loadScenario('seeded-maneuver'));
    const initial = engine.stateHash();

    engine.step(3000);
    engine.reset();

    expect(engine.tick).toBe(0);
    expect(engine.time).toBe(0);
    expect(engine.stateHash()).toBe(initial);
  });

  it('replays identically after a reset', () => {
    const engine = new SimulationEngine(loadScenario('seeded-maneuver'));
    engine.step(1500);
    const first = engine.stateHash();

    engine.reset();
    engine.step(1500);

    expect(engine.stateHash()).toBe(first);
  });

  it('rewinds the random streams', () => {
    const engine = new SimulationEngine(loadScenario('seeded-maneuver'));
    const cursors = engine.randomStreamCursors();

    engine.step(1000);
    engine.reset();

    expect(engine.randomStreamCursors()).toEqual(cursors);
  });
});

describe('entity identity', () => {
  it('assigns stable ids across runs', () => {
    const a = new SimulationEngine(fixtureConfig());
    const b = new SimulationEngine(fixtureConfig());
    b.step(700);

    expect(a.snapshot().truth.targets.map((t) => t.id)).toEqual(
      b.snapshot().truth.targets.map((t) => t.id),
    );
  });

  it('derives ids from position in the config, not a counter', () => {
    const engine = new SimulationEngine(fixtureConfig());
    expect(engine.snapshot().truth.targets[0]!.id).toBe('target-0');
  });
});

describe('snapshots', () => {
  it('are branded as ground truth', () => {
    const engine = new SimulationEngine(fixtureConfig());
    expect(isGroundTruthTainted(engine.snapshot())).toBe(true);
    expect(isGroundTruthTainted(engine.snapshot().truth)).toBe(true);
  });

  it('cannot be mutated by a consumer', () => {
    // A component that could write through a rendered prop would corrupt the
    // world invisibly, and the run would simply stop reproducing.
    const engine = new SimulationEngine(fixtureConfig());
    const snapshot = engine.snapshot();

    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.truth)).toBe(true);
    expect(Object.isFrozen(snapshot.truth.targets[0]!.pose.position)).toBe(true);

    expect(() => {
      (snapshot.truth.targets[0]!.pose.position as { x: number }).x = 999;
    }).toThrow(TypeError);
  });

  it('survives a mutation attempt without changing the world', () => {
    const engine = new SimulationEngine(fixtureConfig());
    engine.step(10);
    const before = engine.stateHash();

    try {
      (engine.snapshot().truth as { tick: number }).tick = 4242;
    } catch {
      // Expected: the snapshot is frozen.
    }

    expect(engine.stateHash()).toBe(before);
    expect(engine.tick).toBe(10);
  });

  it('is memoised per tick and rebuilt after stepping', () => {
    const engine = new SimulationEngine(fixtureConfig());
    expect(engine.snapshot()).toBe(engine.snapshot());

    engine.step(1);
    expect(engine.snapshot().truth.tick).toBe(1);
  });
});

describe('sampleAtTick', () => {
  it('matches the state the engine would reach by stepping there', () => {
    // Purity in action: the renderer can ask for any tick without moving the
    // engine, and get exactly what stepping would have produced.
    const engine = new SimulationEngine(loadScenario('sinusoidal'));
    const sampled = engine.sampleAtTick(640);

    engine.step(640);
    const stepped = engine.snapshot().truth;

    expect(sampled.targets[0]!.pose.position).toEqual(stepped.targets[0]!.pose.position);
    expect(sampled.time).toBe(stepped.time);
  });
});

describe('playback speed independence', () => {
  it('produces identical state at a tick regardless of playback multiplier', () => {
    // Playback speed decides how fast wall-clock time is consumed. It must not
    // touch what the world does at a given simulated time.
    const run = (speed: 0.25 | 1 | 4): string => {
      const engine = new SimulationEngine(loadScenario('seeded-maneuver'));
      const scheduler = new PlaybackScheduler({ tickRate: engine.config.tickRate });
      scheduler.start();
      scheduler.setSpeed(speed);

      while (engine.tick < 2000) {
        const budget = scheduler.advance(1 / 60);
        engine.step(Math.min(budget.ticks, 2000 - engine.tick));
      }
      return engine.stateHash();
    };

    const atOneX = run(1);
    expect(run(0.25)).toBe(atOneX);
    expect(run(4)).toBe(atOneX);
  });
});

describe('ground truth content', () => {
  it('computes bearing, range and rates from the geometry', () => {
    const engine = new SimulationEngine(loadScenario('stationary'));
    const target = engine.snapshot().truth.targets[0]!;

    // Terminal at (0, 1200, 60), observer at (0, 0, 12): due North, slightly up.
    expect(target.bearingFromGimbal.azimuth).toBeCloseTo(0, 9);
    expect(target.bearingFromGimbal.elevation).toBeCloseTo(Math.atan2(48, 1200), 9);
    expect(target.range).toBeCloseTo(Math.hypot(1200, 48), 6);
    expect(target.bearingRateFromGimbal.azimuth).toBeCloseTo(0, 12);
  });

  it('reports pointing error against the designated target', () => {
    const engine = new SimulationEngine(loadScenario('stationary'));
    const truth = engine.snapshot().truth;
    expect(truth.pointingError).not.toBeNull();
    expect(truth.pointingError!).toBeGreaterThanOrEqual(0);
    expect(truth.pointingError!).toBeLessThan(Math.PI);
  });

  it('reports no received beacon power, which Phase 1 does not model', () => {
    // Reporting the configured transmit power here would be a different
    // quantity wearing this field's name.
    const engine = new SimulationEngine(loadScenario('stationary'));
    expect(engine.snapshot().truth.targets[0]!.beaconPower).toBeNull();
  });

  it('marks a target inside the field of view when the mount points at it', () => {
    const engine = new SimulationEngine(loadScenario('stationary'));
    expect(engine.snapshot().truth.targets[0]!.inFieldOfView).toBe(true);
  });
});
