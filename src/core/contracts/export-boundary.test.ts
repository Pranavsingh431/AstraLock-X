/**
 * Guards the public contract surface.
 *
 * `contracts/index.ts` is what the rest of the application imports, so a single
 * added `export *` there would hand ground truth to every consumer at once and
 * quietly disarm the lint barrier, which only restricts the ground-truth module
 * by path. This test fails if that happens.
 */

import { describe, expect, it } from 'vitest';

import * as groundTruthModule from './ground-truth';
import * as contracts from './index';
import * as isolation from './isolation';

describe('contracts barrel', () => {
  it('re-exports nothing from the ground-truth module', () => {
    const exported = new Set(Object.keys(contracts));
    const privileged = Object.keys(groundTruthModule);

    // Sanity check: if the ground-truth module ever stops exporting runtime
    // values this test would pass vacuously, so assert it has some.
    expect(privileged.length).toBeGreaterThan(0);
    expect(privileged).toContain('brandAsGroundTruth');

    for (const name of privileged) {
      expect(exported.has(name)).toBe(false);
    }
  });

  it('still exports the isolation tooling, which is safe for anyone', () => {
    // The guards are not the data. Every layer may check for ground truth; only
    // the privileged side may construct it.
    for (const name of Object.keys(isolation)) {
      expect(Object.keys(contracts)).toContain(name);
    }
  });

  it('exports the contracts a tracking algorithm needs', () => {
    const exported = Object.keys(contracts);
    for (const name of ['defineAlgorithm', 'guardTrackingInput', 'parseSimulationConfig']) {
      expect(exported).toContain(name);
    }
  });

  it('exposes no export whose name suggests it constructs ground truth', () => {
    const constructors = Object.keys(contracts).filter(
      (name) => /^brand/i.test(name) || /GroundTruthState$/.test(name),
    );
    expect(constructors).toEqual([]);
  });
});
