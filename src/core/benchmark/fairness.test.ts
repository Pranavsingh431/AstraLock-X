// @vitest-environment node
/**
 * The checks that decide whether a comparison is allowed to be made.
 *
 * These are cheap tests of an expensive property. A benchmark's whole claim is
 * "same world, different algorithm", and the ways that claim breaks are quiet:
 * a scenario edited between arms, a seed that differed, a threshold changed
 * halfway. None of them makes a run fail. So the fingerprints are the only
 * thing standing between a broken suite and a confident wrong answer.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_ASTRALOCK_CONFIG, DEFAULT_BASELINE_PAT_CONFIG } from '@/core/algorithms';
import { parseSimulationConfig } from '@/core/contracts/simulation';
import { DEFAULT_METRICS_CONFIG } from '@/core/experiments/schema';
import { loadScenario } from '@/scenarios';

import { metricFingerprint, physicalFingerprint, validateComparison } from './fairness';

const scenario = () => loadScenario('astralock-moving');

describe('the physical fingerprint', () => {
  it('is the same for the same world', () => {
    expect(physicalFingerprint(scenario())).toBe(physicalFingerprint(scenario()));
  });

  it('ignores the algorithm entirely, which is what lets arms share it', () => {
    // Not a property of the function's inputs — it takes no algorithm — but of
    // the design: if configuration could reach it, two arms of a case could
    // never produce the same fingerprint and every comparison would be invalid.
    const one = physicalFingerprint(scenario());
    void DEFAULT_BASELINE_PAT_CONFIG;
    void DEFAULT_ASTRALOCK_CONFIG;
    expect(physicalFingerprint(scenario())).toBe(one);
  });

  it('changes when the seed changes', () => {
    const base = scenario();
    const reseeded = parseSimulationConfig({ ...base, seed: base.seed + 1 });
    expect(physicalFingerprint(reseeded)).not.toBe(physicalFingerprint(base));
  });

  it('changes when a target moves', () => {
    const base = scenario();
    const moved = parseSimulationConfig({
      ...base,
      targets: base.targets.map((target, index) =>
        index === 0
          ? {
              ...target,
              trajectory: { ...target.trajectory, position: { x: 1, y: 1500, z: 95 } },
            }
          : target,
      ),
    });
    expect(physicalFingerprint(moved)).not.toBe(physicalFingerprint(base));
  });

  it('changes when the disturbances change', () => {
    const base = loadScenario('dist-vibration');
    const calmer = parseSimulationConfig({
      ...base,
      disturbances: { ...base.disturbances, preset: 'CLEAN' },
    });
    expect(physicalFingerprint(calmer)).not.toBe(physicalFingerprint(base));
  });

  it('changes when the camera changes', () => {
    const base = scenario();
    const wider = parseSimulationConfig({
      ...base,
      camera: { ...base.camera, horizontalFov: (base.camera.horizontalFov as number) * 1.1 },
    });
    expect(physicalFingerprint(wider)).not.toBe(physicalFingerprint(base));
  });

  it('ignores the display name, which is not physics', () => {
    const base = scenario();
    const renamed = parseSimulationConfig({ ...base, name: 'Something else entirely' });
    expect(physicalFingerprint(renamed)).toBe(physicalFingerprint(base));
  });
});

describe('the metric fingerprint', () => {
  it('changes when a threshold changes', () => {
    const tighter = { ...DEFAULT_METRICS_CONFIG, lockErrorThresholdRad: 1e-3 };
    expect(metricFingerprint(tighter)).not.toBe(metricFingerprint(DEFAULT_METRICS_CONFIG));
  });
});

describe('validating a comparison', () => {
  const run = (physical: string, metric: string) => ({
    physicalFingerprint: physical,
    metricFingerprint: metric,
  });

  it('accepts arms that agree', () => {
    const result = validateComparison([
      run('physical:a', 'metric:m'),
      run('physical:a', 'metric:m'),
    ]);
    expect(result.valid).toBe(true);
    expect(result.reason).toBeNull();
  });

  it('refuses arms flown against different physics', () => {
    const result = validateComparison([
      run('physical:a', 'metric:m'),
      run('physical:b', 'metric:m'),
    ]);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('INVALID_PHYSICAL_MISMATCH');
    expect(result.detail).toContain('different physical configurations');
  });

  it('refuses arms scored under different definitions', () => {
    const result = validateComparison([
      run('physical:a', 'metric:m'),
      run('physical:a', 'metric:n'),
    ]);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('INVALID_METRIC_MISMATCH');
  });

  it('refuses to call an empty comparison valid', () => {
    // A table cell built from nothing should say so rather than read as a
    // vacuous pass.
    const result = validateComparison([]);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe('INVALID_NO_RUNS');
  });

  it('reports physics before metrics when both disagree', () => {
    // Order matters for the message, not the verdict: the physical mismatch is
    // the more fundamental problem and is the one worth showing first.
    const result = validateComparison([
      run('physical:a', 'metric:m'),
      run('physical:b', 'metric:n'),
    ]);
    expect(result.reason).toBe('INVALID_PHYSICAL_MISMATCH');
  });
});
