import { describe, expect, it } from 'vitest';

import { makeValidRawConfig } from '@/test/fixtures';

import {
  MAX_SIMULATION_SEED,
  parseSimulationConfig,
  safeParseSimulationConfig,
  simulationSeed,
} from './simulation';

describe('simulationSeed', () => {
  it('accepts integers across the full 32-bit range', () => {
    expect(simulationSeed(0)).toBe(0);
    expect(simulationSeed(12345)).toBe(12345);
    expect(simulationSeed(MAX_SIMULATION_SEED)).toBe(MAX_SIMULATION_SEED);
  });

  it('rejects values that cannot address a 32-bit stream', () => {
    expect(() => simulationSeed(-1)).toThrow(RangeError);
    expect(() => simulationSeed(1.5)).toThrow(RangeError);
    expect(() => simulationSeed(MAX_SIMULATION_SEED + 1)).toThrow(RangeError);
    expect(() => simulationSeed(Number.NaN)).toThrow(RangeError);
  });
});

describe('parseSimulationConfig', () => {
  it('accepts a well-formed config', () => {
    const config = parseSimulationConfig(makeValidRawConfig());
    expect(config.id).toBe('fixture-001');
    expect(config.targets).toHaveLength(1);
    expect(config.camera.width).toBe(640);
  });

  it('rejects an unknown key rather than silently dropping it', () => {
    const raw = { ...makeValidRawConfig(), unexpectedKey: true };
    expect(() => parseSimulationConfig(raw)).toThrow();
  });

  it('rejects a missing section', () => {
    const raw = makeValidRawConfig();
    delete raw['atmosphere'];
    expect(() => parseSimulationConfig(raw)).toThrow();
  });

  it('rejects non-finite numbers', () => {
    const raw = makeValidRawConfig();
    raw['duration'] = Number.POSITIVE_INFINITY;
    expect(() => parseSimulationConfig(raw)).toThrow();
  });

  it('requires at least one target', () => {
    const raw = makeValidRawConfig();
    raw['targets'] = [];
    expect(() => parseSimulationConfig(raw)).toThrow();
  });
});

describe('cross-field validation', () => {
  it('rejects an exposure longer than the frame period', () => {
    const raw = makeValidRawConfig();
    // 100 Hz gives a 10 ms period; 20 ms of exposure cannot fit.
    (raw['camera'] as Record<string, unknown>)['exposure'] = 0.02;

    const result = safeParseSimulationConfig(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.some((issue) => issue.path.includes('exposure'))).toBe(true);
    }
  });

  it('rejects inverted gimbal travel limits', () => {
    const raw = makeValidRawConfig();
    (raw['gimbal'] as Record<string, unknown>)['azimuthLimits'] = {
      minAngle: 1,
      maxAngle: -1,
      maxRate: 2,
      maxAcceleration: 10,
    };
    expect(safeParseSimulationConfig(raw).success).toBe(false);
  });

  it('rejects a physics tick rate below the camera frame rate', () => {
    const raw = makeValidRawConfig();
    raw['tickRate'] = 50;
    expect(safeParseSimulationConfig(raw).success).toBe(false);
  });

  it('reports every violated rule at once, not just the first', () => {
    const raw = makeValidRawConfig();
    raw['id'] = '';
    raw['name'] = '';

    const result = safeParseSimulationConfig(raw);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThanOrEqual(2);
    }
  });
});
