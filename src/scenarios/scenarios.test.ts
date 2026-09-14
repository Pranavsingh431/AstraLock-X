/**
 * The bundled scenarios are real, loadable documents.
 *
 * Every one is parsed through the same validator an imported file goes through
 * and then actually run, so a scenario that would not execute cannot ship.
 */

import { describe, expect, it } from 'vitest';

import { SimulationEngine } from '@/core/simulation/engine';
import {
  SIMULATION_CONFIG_SCHEMA_VERSION,
  safeParseSimulationConfig,
} from '@/core/contracts/simulation';
import { makeValidRawConfig } from '@/test/fixtures';

import { DEFAULT_SCENARIO_ID, SCENARIO_IDS, listScenarios, loadScenario } from './index';

describe('bundled scenarios', () => {
  it.each(SCENARIO_IDS)('%s parses against the schema', (id) => {
    const config = loadScenario(id);
    expect(config.schemaVersion).toBe(SIMULATION_CONFIG_SCHEMA_VERSION);
    expect(config.name.length).toBeGreaterThan(0);
  });

  it('provides both gimbal profiles', () => {
    // A near-ideal mount to isolate servo behaviour, and a lab mount with play,
    // a coarse encoder and a real command delay.
    const ideal = loadScenario('gimbal-step-response').gimbal;
    const lab = loadScenario('camera-target-outside-fov').gimbal;

    expect(ideal.pan.backlash).toBe(0);
    expect(ideal.commandLatency).toBe(0);
    expect(lab.pan.backlash).toBeGreaterThan(0);
    expect(lab.commandLatency).toBeGreaterThan(0);
  });

  it('gives the latency scenario a delay that is not a multiple of the tick', () => {
    // 23 ms against a 5 ms tick, on purpose: a latency that divided evenly
    // would hide the whole sub-step question.
    const config = loadScenario('gimbal-latency');
    const tickSeconds = 1 / config.tickRate;
    const ticks = config.gimbal.commandLatency / tickSeconds;
    expect(Number.isInteger(ticks)).toBe(false);
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

  const withCamera = (patch: Record<string, unknown>): Record<string, unknown> => {
    const raw = makeValidRawConfig();
    raw['camera'] = { ...(raw['camera'] as Record<string, unknown>), ...patch };
    return raw;
  };

  it.each([
    ['a zero field of view', { horizontalFov: 0 }],
    ['a field of view of pi', { horizontalFov: Math.PI }],
    ['a negative field of view', { horizontalFov: -0.5 }],
    ['a zero width', { width: 0 }],
    ['a non-integer width', { width: 640.5 }],
    ['an absurd width', { width: 100_000 }],
    ['a non-positive frame rate', { frameRate: 0 }],
    ['a non-positive near range', { nearRange: 0 }],
    ['a near range beyond the far range', { nearRange: 9000, farRange: 100 }],
    // Pointing left the camera block in schema v4: the mount owns it now, and a
    // config still carrying it is stale rather than merely unusual.
    ['stale camera pointing fields', { initialAzimuth: 0, initialElevation: 0 }],
    ['a principal point outside the image', { principalPoint: { x: 5000, y: 10 } }],
    ['an unsupported pixel format', { format: 'rgba8' }],
    ['a background level above full scale', { backgroundLevel: 1.5 }],
  ])('rejects %s', (_label, patch) => {
    expect(safeParseSimulationConfig(withCamera(patch)).success).toBe(false);
  });

  it('accepts an explicit principal point inside the image', () => {
    expect(
      safeParseSimulationConfig(withCamera({ principalPoint: { x: 320, y: 240 } })).success,
    ).toBe(true);
  });

  it('rejects a beacon with a non-positive point spread', () => {
    const raw = makeValidRawConfig();
    (raw['targets'] as Record<string, unknown>[])[0]!['beacon'] = {
      transmitPower: 0.05,
      intensity: 0.9,
      psfSigma: 0,
    };
    expect(safeParseSimulationConfig(raw).success).toBe(false);
  });

  const withGimbal = (patch: Record<string, unknown>): Record<string, unknown> => {
    const raw = makeValidRawConfig();
    const gimbal = raw['gimbal'] as Record<string, unknown>;
    raw['gimbal'] = {
      ...gimbal,
      pan: { ...(gimbal['pan'] as Record<string, unknown>), ...patch },
    };
    return raw;
  };

  it.each([
    ['inverted travel limits', { minAngle: 1, maxAngle: -1 }],
    ['an initial angle outside travel', { initialAngle: 99 }],
    ['a non-positive rate limit', { maxRate: 0 }],
    ['a non-positive acceleration limit', { maxAcceleration: -5 }],
    ['a non-positive natural frequency', { naturalFrequency: 0 }],
    ['an undamped servo', { dampingRatio: 0 }],
    ['an absurdly overdamped servo', { dampingRatio: 50 }],
    ['a negative deadband', { deadband: -0.001 }],
    ['a negative backlash', { backlash: -0.01 }],
    ['backlash wider than the travel', { backlash: 99 }],
    ['a non-positive encoder step', { encoderResolution: 0 }],
    ['a non-finite angle', { initialAngle: Number.POSITIVE_INFINITY }],
  ])('rejects %s', (_label, patch) => {
    expect(safeParseSimulationConfig(withGimbal(patch)).success).toBe(false);
  });

  it('rejects a negative command latency', () => {
    const raw = makeValidRawConfig();
    (raw['gimbal'] as Record<string, unknown>)['commandLatency'] = -0.01;
    expect(safeParseSimulationConfig(raw).success).toBe(false);
  });

  it('rejects a servo too fast for the configured physics tick', () => {
    // Stability and accuracy of the integrator are a property of the pair, so
    // an unusable combination is refused rather than discovered as a wobble.
    expect(safeParseSimulationConfig(withGimbal({ naturalFrequency: 200 })).success).toBe(false);
  });

  it('accepts a servo comfortably inside the integrator bound', () => {
    expect(safeParseSimulationConfig(withGimbal({ naturalFrequency: 12 })).success).toBe(true);
  });

  it('rejects a non-positive tick rate', () => {
    const raw = makeValidRawConfig();
    raw['tickRate'] = 0;
    expect(safeParseSimulationConfig(raw).success).toBe(false);
  });

  it.each([1, 2, 3, 5])('rejects schema version %i rather than guessing a migration', (version) => {
    // Version 1 declared a start position rather than a trajectory; version 2 a
    // focal length rather than a field of view; version 3 a static boresight
    // rather than an actuator. Inventing the missing half would be inventing
    // the experiment or the instrument, and a future version cannot be
    // understood at all.
    const raw = makeValidRawConfig();
    raw['schemaVersion'] = version;
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
