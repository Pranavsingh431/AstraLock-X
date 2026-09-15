// @vitest-environment node
/**
 * The same scenario, five different seeds.
 *
 * A stochastic scenario has no single outcome, and a conclusion drawn from one
 * seed is a conclusion about one realization. This is the smallest honest guard
 * against that: a fixed, declared set of seeds, run before the results are
 * looked at, reported as a spread rather than as a number.
 *
 * It is a **development validation harness**, not a benchmark engine. There is
 * no batch runner, no sweep, no report generation — those are AstraBench's job
 * and AstraBench is explicitly not part of this phase.
 *
 * The seeds are declared here, in the source, ahead of any result:
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ASTRALOCK_CONFIG, astraLockXPat } from '@/core/algorithms';
import { parseSimulationConfig } from '@/core/contracts/simulation';
import { buildRig, drive } from '@/core/experiments/rig.node';
import { MemoryStorage } from '@/core/experiments/storage';
import { loadScenario } from '@/scenarios';

vi.setConfig({ testTimeout: 1_800_000 });

/**
 * Five seeds, fixed before any of them was run.
 *
 * Not chosen, not filtered, not reordered. Picking seeds after seeing their
 * results is how a favourable number gets published, and declaring them in
 * source is the cheapest way to make that impossible to do accidentally.
 */
const SEEDS = [7101, 7102, 7103, 7104, 7105] as const;

interface SeedResult {
  readonly seed: number;
  readonly acquired: boolean;
  readonly retention: number | null;
  readonly rmsUrad: number | null;
  readonly falseLockEpisodes: number;
}

/** Runs one seed of a scenario with the robust algorithm. */
async function runSeed(
  scenario: 'dist-low-contrast' | 'dist-combined',
  seed: number,
): Promise<SeedResult> {
  // Only the seed differs. Everything else — geometry, optics, mount, the
  // disturbance parameters — is the scenario's own.
  const base = loadScenario(scenario);
  const config = parseSimulationConfig({ ...base, seed });

  const rig = buildRig({
    scenario: config,
    storage: new MemoryStorage(),
    runId: `${scenario}-${String(seed)}`,
    plugin: astraLockXPat,
    algorithmConfig: DEFAULT_ASTRALOCK_CONFIG,
  });
  await rig.recorder!.start({ autonomyActive: true });
  drive(rig, 45);
  const summary = await rig.recorder!.complete();

  return {
    seed,
    acquired: summary.acquisitionOutcome === 'acquired',
    retention: summary.lockRetentionRate.value,
    rmsUrad:
      summary.angularPointingError.postAcquisition.rms.value === null
        ? null
        : summary.angularPointingError.postAcquisition.rms.value * 1e6,
    falseLockEpisodes: summary.falseLockEpisodes,
  };
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1]! + sorted[middle]!) / 2 : sorted[middle]!;
};

/** One run of the set, shared by every assertion about it. */
const sets = new Map<string, Promise<readonly SeedResult[]>>();
function seedSet(scenario: 'dist-low-contrast' | 'dist-combined') {
  let set = sets.get(scenario);
  if (set === undefined) {
    set = (async () => {
      const results: SeedResult[] = [];
      for (const seed of SEEDS) results.push(await runSeed(scenario, seed));
      return results;
    })();
    sets.set(scenario, set);
  }
  return set;
}

describe('low contrast, across five declared seeds', () => {
  it('acquires on every one of them', async () => {
    const results = await seedSet('dist-low-contrast');
    const acquired = results.filter((result) => result.acquired);

    // Reported as a count, not asserted away: a scenario that acquired on four
    // seeds out of five would still pass a "usually works" test and would be a
    // materially different result.
    expect(acquired).toHaveLength(SEEDS.length);
  });

  it('holds lock on every seed, and the spread is narrow', async () => {
    const results = await seedSet('dist-low-contrast');
    const retentions = results.map((result) => result.retention ?? 0);

    expect(median(retentions)).toBeGreaterThan(0.9);
    expect(Math.min(...retentions)).toBeGreaterThan(0.75);
  });

  it('leaves no unrecovered failure on any seed', async () => {
    const results = await seedSet('dist-low-contrast');
    for (const result of results) {
      expect(result.retention, `seed ${String(result.seed)}`).not.toBeNull();
    }
  });

  // The point of the exercise: the conclusion has to survive the spread, not
  // just the median. A range this wide on a five-seed sample is worth knowing
  // about even when every seed passes.
  it('reports a spread rather than a single number', async () => {
    const results = await seedSet('dist-low-contrast');
    const errors = results
      .map((result) => result.rmsUrad)
      .filter((value): value is number => value !== null);

    expect(errors).toHaveLength(SEEDS.length);
    const spread = Math.max(...errors) / Math.min(...errors);
    // Seeds change the noise and the wander, not the geometry, so an order of
    // magnitude between the best and worst seed would mean the result was
    // dominated by luck.
    expect(spread).toBeLessThan(10);
  });
});

describe('combined stress, across the same five seeds', () => {
  it('acquires on every seed', async () => {
    const results = await seedSet('dist-combined');
    expect(results.filter((result) => result.acquired)).toHaveLength(SEEDS.length);
  });

  it('never locks a wrong source on any seed', async () => {
    const results = await seedSet('dist-combined');
    for (const result of results) {
      expect(result.falseLockEpisodes, `seed ${String(result.seed)}`).toBe(0);
    }
  });

  it('holds lock across the set', async () => {
    const results = await seedSet('dist-combined');
    const retentions = results.map((result) => result.retention ?? 0);
    expect(median(retentions)).toBeGreaterThan(0.8);
  });
});

describe('the harness itself', () => {
  it('changes only the seed between runs', () => {
    const base = loadScenario('dist-low-contrast');
    const first = parseSimulationConfig({ ...base, seed: SEEDS[0] });
    const second = parseSimulationConfig({ ...base, seed: SEEDS[1] });

    expect(second.seed).not.toBe(first.seed);
    expect(second.disturbances).toEqual(first.disturbances);
    expect(second.targets).toEqual(first.targets);
    expect(second.camera).toEqual(first.camera);
    expect(second.gimbal).toEqual(first.gimbal);
  });

  it('declares its seeds in source, ahead of any result', () => {
    expect(SEEDS).toEqual([7101, 7102, 7103, 7104, 7105]);
  });
});
