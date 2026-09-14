/**
 * The bundled scenarios are real, loadable documents.
 *
 * Every one is parsed through the same validator an imported file goes through
 * and then actually run, so a scenario that would not execute cannot ship.
 */

import { describe, expect, it } from 'vitest';

import { SimulationEngine } from '@/core/simulation/engine';
import { safeParseSimulationConfig } from '@/core/contracts/simulation';
import { makeValidRawConfig } from '@/test/fixtures';

import { DEFAULT_SCENARIO_ID, SCENARIO_IDS, listScenarios, loadScenario } from './index';

describe('bundled scenarios', () => {
  it.each(SCENARIO_IDS)('%s parses against the schema', (id) => {
    const config = loadScenario(id);
    expect(config.schemaVersion).toBe(2);
    expect(config.name.length).toBeGreaterThan(0);
  });

  it('covers every trajectory family', () => {
    const kinds = SCENARIO_IDS.map((id) => loadScenario(id).targets[0]!.trajectory.kind);
    expect(new Set(kinds)).toEqual(
      new Set(['stationary', 'linear', 'circular', 'sinusoidal', 'waypoint', 'seeded-maneuver']),
    );
  });

  it.each(SCENARIO_IDS)('%s runs and stays finite', (id) => {
    const engine = new SimulationEngine(loadScenario(id));
    engine.step(2_000);

    const target = engine.snapshot().truth.targets[0]!;
    expect(Number.isFinite(target.pose.position.x)).toBe(true);
    expect(Number.isFinite(target.pose.position.y)).toBe(true);
    expect(Number.isFinite(target.pose.position.z)).toBe(true);
    expect(Number.isFinite(target.range)).toBe(true);
  });

  it.each(SCENARIO_IDS)('%s reproduces from its own config', (id) => {
    const first = new SimulationEngine(loadScenario(id));
    first.step(1_500);

    const second = new SimulationEngine(loadScenario(id));
    second.step(1_500);

    expect(second.stateHash()).toBe(first.stateHash());
  });

  it('lists every scenario with a display name', () => {
    const listed = listScenarios();
    expect(listed).toHaveLength(SCENARIO_IDS.length);
    expect(listed.every((entry) => entry.name.length > 0)).toBe(true);
  });

  it('opens on a scenario that exists', () => {
    expect(SCENARIO_IDS).toContain(DEFAULT_SCENARIO_ID);
  });

  it('caches the parsed result', () => {
    expect(loadScenario('circular')).toBe(loadScenario('circular'));
  });
});

describe('scenario round trip', () => {
  it.each(SCENARIO_IDS)('%s survives export and re-import', (id) => {
    // Saving and reloading must reproduce the run, or a stored experiment would
    // not be an experiment.
    const original = loadScenario(id);
    const exported = JSON.stringify(original);
    const reimported = safeParseSimulationConfig(JSON.parse(exported));

    expect(reimported.success).toBe(true);
    if (!reimported.success) return;

    const a = new SimulationEngine(original);
    const b = new SimulationEngine(reimported.data);
    a.step(1_200);
    b.step(1_200);

    expect(b.stateHash()).toBe(a.stateHash());
  });
});

describe('invalid scenarios are refused', () => {
  const withTrajectory = (trajectory: unknown): Record<string, unknown> => {
    const raw = makeValidRawConfig();
    (raw['targets'] as Record<string, unknown>[])[0]!['trajectory'] = trajectory;
    return raw;
  };

  it('rejects an unknown trajectory type', () => {
    expect(safeParseSimulationConfig(withTrajectory({ kind: 'teleport' })).success).toBe(false);
  });

  it('rejects a negative circular radius', () => {
    const result = safeParseSimulationConfig(
      withTrajectory({
        kind: 'circular',
        center: { x: 0, y: 0, z: 0 },
        radius: -100,
        angularRate: 0.1,
        planeNormal: { x: 0, y: 0, z: 1 },
        initialPhase: 0,
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a zero-length plane normal, which defines no plane', () => {
    const result = safeParseSimulationConfig(
      withTrajectory({
        kind: 'circular',
        center: { x: 0, y: 0, z: 0 },
        radius: 100,
        angularRate: 0.1,
        planeNormal: { x: 0, y: 0, z: 0 },
        initialPhase: 0,
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects non-finite numbers', () => {
    const result = safeParseSimulationConfig(
      withTrajectory({
        kind: 'linear',
        position: { x: Number.POSITIVE_INFINITY, y: 0, z: 0 },
        velocity: { x: 0, y: 0, z: 0 },
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects waypoints that do not advance in time', () => {
    const result = safeParseSimulationConfig(
      withTrajectory({
        kind: 'waypoint',
        loop: false,
        waypoints: [
          { position: { x: 0, y: 0, z: 0 }, arrivalTime: 4 },
          { position: { x: 1, y: 0, z: 0 }, arrivalTime: 4 },
        ],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a single waypoint', () => {
    const result = safeParseSimulationConfig(
      withTrajectory({
        kind: 'waypoint',
        loop: false,
        waypoints: [{ position: { x: 0, y: 0, z: 0 }, arrivalTime: 0 }],
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a manoeuvre whose minimum duration exceeds its maximum', () => {
    const result = safeParseSimulationConfig(
      withTrajectory({
        kind: 'seeded-maneuver',
        initialPosition: { x: 0, y: 0, z: 0 },
        initialVelocity: { x: 0, y: 0, z: 0 },
        maxAcceleration: 5,
        maxSpeed: 40,
        minSegmentDuration: 9,
        maxSegmentDuration: 2,
        boundsRadius: 1000,
      }),
    );
    expect(result.success).toBe(false);
  });

  it('rejects a non-positive tick rate', () => {
    const raw = makeValidRawConfig();
    raw['tickRate'] = 0;
    expect(safeParseSimulationConfig(raw).success).toBe(false);
  });

  it('rejects a superseded schema version rather than guessing a migration', () => {
    // A version 1 document declared a start position, not a trajectory.
    // Inventing one would be inventing the experiment.
    const raw = makeValidRawConfig();
    raw['schemaVersion'] = 1;
    expect(safeParseSimulationConfig(raw).success).toBe(false);
  });

  it('names the offending field in its error', () => {
    const result = safeParseSimulationConfig(withTrajectory({ kind: 'teleport' }));
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('trajectory'))).toBe(true);
    }
  });
});
