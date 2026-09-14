// @vitest-environment node
/**
 * Runs recorded by an earlier build still load, recompute and verify.
 *
 * `__fixtures__/phase5/run-phase5-fixture` was recorded by the Phase 5 build at
 * commit 2baa5b5: schema version 1, metrics definition version 1, 7 s of
 * `pat-loss` with an acquisition, a lock and a loss. It is kept byte for byte
 * (Prettier ignores it). Phase 6 changed the telemetry layout and the metric
 * semantics, and bumped both versions; this is the proof that doing so did not
 * reinterpret history.
 */

import { cp, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { NodeFileStorage } from './node-storage.node';
import {
  completedResults,
  listRuns,
  readStoredSummary,
  recomputeSummary,
  summariseStoredRun,
} from './recompute';
import { renderStoredReport } from './report';
import { DEFAULT_METRICS_CONFIG, METRICS_DEFINITION_VERSION } from './schema';

const RUN = 'run-phase5-fixture';
let root: string;
let storage: NodeFileStorage;

beforeAll(async () => {
  // A copy, so no test can alter the fixture itself.
  root = await mkdtemp(join(tmpdir(), 'astralock-compat-'));
  await cp(join(import.meta.dirname, '__fixtures__', 'phase5', RUN), join(root, RUN), {
    recursive: true,
  });
  storage = new NodeFileStorage(root);
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('a Phase 5 run (schema 1, metrics definition 1)', () => {
  it('lists as a completed result with its original summary', async () => {
    const [listing] = await listRuns(storage);
    expect(listing!.error).toBeNull();
    expect(listing!.manifest!.schemaVersion).toBe(1);
    expect(listing!.summary!.metricsDefinitionVersion).toBe(1);
    expect(listing!.summary!.handoff).toBeUndefined();
    expect(completedResults([listing!])).toHaveLength(1);
  });

  it('recomputes under its own definition to exactly the summary it stored', async () => {
    const { stored, recomputed, differences } = await recomputeSummary(storage, RUN);
    expect(differences).toEqual([]);
    expect(recomputed.schemaVersion).toBe(1);
    expect(recomputed.metricsConfig.definitionVersion).toBe(1);
    // Spot-check the substance, not only the equality.
    expect(stored.coarseLockTime.value).toBeCloseTo(3.5333, 3);
    expect(stored.lossOfLockEpisodes).toBe(1);
    expect(recomputed.trackingModes).toBeUndefined();
  });

  it('still renders a report from its schema-1 telemetry', async () => {
    const summary = await readStoredSummary(storage, RUN);
    const html = await renderStoredReport(storage, RUN, summary);
    expect(html).toContain(RUN);
    expect(html).toContain('Angular pointing error vs simulation time');
  });

  it('can be rescored under the current definition as a new, separately identified result', async () => {
    const stored = await readStoredSummary(storage, RUN);
    const rescored = await summariseStoredRun(storage, RUN, {
      metricsConfig: DEFAULT_METRICS_CONFIG,
    });
    expect(rescored.metricsDefinitionVersion).toBe(METRICS_DEFINITION_VERSION);
    expect(rescored.metricsFingerprint).not.toBe(stored.metricsFingerprint);
    // The baseline never reports HANDOFF, so the new tracking-mode rule changes
    // nothing about its lock figures.
    expect(rescored.coarseLockTime).toEqual(stored.coarseLockTime);
    expect(rescored.lockRetentionRate).toEqual(stored.lockRetentionRate);
    expect(rescored.handoff?.episodes).toBe(0);
    expect(rescored.estimator?.framesWithModelProbabilities).toBe(0);
    // And the stored file is untouched.
    expect(await readStoredSummary(storage, RUN)).toEqual(stored);
  });
});
