// @vitest-environment node
/**
 * Recording an AstraLock-X run.
 *
 * Phase 5's recorder must handle the robust algorithm without any special case,
 * and must keep doing everything it promised: the summary recomputes from the
 * files, recording changes no engineering result, and a Phase 5 run recorded
 * under the old metric definitions still reads correctly.
 *
 * The new part is that the richer state machine has to survive the round trip —
 * ACQUIRE, RECOVER and HANDOFF are states the Phase 5 schema did not know about
 * when it was written.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ASTRALOCK_CONFIG,
  DEFAULT_BASELINE_PAT_CONFIG,
  astraLockXPat,
  baselineKfPidPat,
} from '@/core/algorithms';

import { NodeFileStorage } from './node-storage.node';
import { compareSummaries, recomputeSummary } from './recompute';
import { buildRig, drive, type RigOptions } from './rig.node';
import { RUN_FILES, MemoryStorage } from './storage';

vi.setConfig({ testTimeout: 900_000 });

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'astralock-phase6-'));
  roots.push(root);
  return root;
}

/** A rig running the robust algorithm, through the same harness as the baseline. */
const robustRig = (options: Omit<RigOptions, 'plugin' | 'algorithmConfig'>) =>
  buildRig({ ...options, plugin: astraLockXPat, algorithmConfig: DEFAULT_ASTRALOCK_CONFIG });

const baselineRig = (options: Omit<RigOptions, 'plugin' | 'algorithmConfig'>) =>
  buildRig({ ...options, plugin: baselineKfPidPat, algorithmConfig: DEFAULT_BASELINE_PAT_CONFIG });

const eventTypes = async (storage: MemoryStorage, runId: string): Promise<string[]> =>
  (await storage.readFile(runId, RUN_FILES.events))
    .split('\n')
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);

describe('the recorder handles the robust algorithm', () => {
  it('records a run through every new state', async () => {
    const storage = new MemoryStorage();
    const rig = robustRig({
      scenario: 'astralock-short-loss',
      storage,
      runId: 'run-robust-states',
    });
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 60);
    const summary = await rig.recorder!.complete();

    const events = await eventTypes(storage, 'run-robust-states');

    // The states Phase 5's vocabulary did not have when it was written.
    expect(events).toContain('acquire-entered');
    expect(events).toContain('recover-entered');
    expect(events).toContain('reacquired');
    expect(summary.algorithmFramesProcessed).toBeGreaterThan(1000);
  });

  it('records handoff readiness as events', async () => {
    const storage = new MemoryStorage();
    const rig = robustRig({ scenario: 'astralock-handoff', storage, runId: 'run-robust-handoff' });
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 45);
    await rig.recorder!.complete();

    const events = await eventTypes(storage, 'run-robust-handoff');

    expect(events).toContain('handoff-ready');
  });

  it('identifies which algorithm produced the run', async () => {
    const storage = new MemoryStorage();
    const robust = robustRig({ scenario: 'astralock-stationary', storage, runId: 'run-id-robust' });
    const baseline = baselineRig({
      scenario: 'astralock-stationary',
      storage,
      runId: 'run-id-baseline',
    });

    await robust.recorder!.start({ autonomyActive: true });
    await baseline.recorder!.start({ autonomyActive: true });
    await robust.recorder!.abort();
    await baseline.recorder!.abort();

    const read = async (id: string) =>
      JSON.parse(await storage.readFile(id, RUN_FILES.manifest)) as {
        algorithmId: string;
        algorithmFingerprint: string;
        scenarioFingerprint: string;
      };

    const a = await read('run-id-robust');
    const b = await read('run-id-baseline');

    expect(a.algorithmId).toBe('astralock-x');
    expect(b.algorithmId).toBe('baseline-kf-pid');
    // Same physics, different tracker: the scenario fingerprint matches and the
    // algorithm fingerprint does not. That is what makes the pair comparable.
    expect(a.scenarioFingerprint).toBe(b.scenarioFingerprint);
    expect(a.algorithmFingerprint).not.toBe(b.algorithmFingerprint);
  });

  it('does not flood the log with per-frame state events', async () => {
    // Commands are deliberately recorded one issued and one applied per
    // command — that is Phase 5's contract and the latency metrics depend on
    // it. Everything else marks a *change*, and a richer state machine must not
    // turn that into a per-frame stream.
    const storage = new MemoryStorage();
    const rig = robustRig({ scenario: 'astralock-moving', storage, runId: 'run-robust-events' });
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 40);
    const summary = await rig.recorder!.complete();

    const events = await eventTypes(storage, 'run-robust-events');
    const stateEvents = events.filter((type) => !type.startsWith('command-'));

    expect(stateEvents.length).toBeLessThan(50);
    expect(summary.algorithmFramesProcessed).toBeGreaterThan(1000);
  });
});

describe('the Phase 5 guarantees still hold', () => {
  it('recording changes no engineering result', async () => {
    const withoutRecorder = robustRig({ scenario: 'astralock-maneuver' });
    const storage = new MemoryStorage();
    const withRecorder = robustRig({
      scenario: 'astralock-maneuver',
      storage,
      runId: 'run-robust-equivalence',
    });

    await withRecorder.recorder!.start({ autonomyActive: true });
    const off = drive(withoutRecorder, 40);
    const on = drive(withRecorder, 40);
    await withRecorder.recorder!.complete();

    expect(on.modes).toEqual(off.modes);
    expect(on.commands).toEqual(off.commands);
    expect(on.finalMeasuredPan).toBe(off.finalMeasuredPan);
    expect(on.stateHash).toBe(off.stateHash);
  });

  it('the summary recomputes from the files alone', async () => {
    const root = await temporaryRoot();
    const storage = new NodeFileStorage(root);
    const rig = robustRig({
      scenario: 'astralock-short-loss',
      storage,
      runId: 'run-robust-recompute',
    });

    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 55);
    const stored = await rig.recorder!.complete();

    const { recomputed, differences } = await recomputeSummary(
      new NodeFileStorage(root),
      'run-robust-recompute',
    );
    expect(differences).toEqual([]);
    expect(compareSummaries(stored, recomputed)).toEqual([]);
  });

  it('reports the robust-specific metrics from stored data', async () => {
    const root = await temporaryRoot();
    const storage = new NodeFileStorage(root);
    const rig = robustRig({ scenario: 'astralock-handoff', storage, runId: 'run-robust-metrics' });

    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 45);
    const stored = await rig.recorder!.complete();

    // Present in the live summary...
    expect(stored.handoff).toBeDefined();
    expect(stored.handoff!.episodes).toBeGreaterThan(0);
    expect(stored.handoff!.timeToHandoffReady.value).not.toBeNull();
    // ...and the evaluator's verdict on the claim is there too.
    expect(stored.handoff!.validityRate.value).not.toBeNull();

    // ...and all of it is reproduced from the raw record, which is the point.
    const { recomputed, differences } = await recomputeSummary(
      new NodeFileStorage(root),
      'run-robust-metrics',
    );
    expect(differences).toEqual([]);
    expect(recomputed.handoff!.episodes).toBe(stored.handoff!.episodes);
    expect(recomputed.handoff!.timeToHandoffReady.value).toBeCloseTo(
      stored.handoff!.timeToHandoffReady.value!,
      9,
    );
  });

  it('the generated report covers the robust sections', async () => {
    const storage = new MemoryStorage();
    const rig = robustRig({ scenario: 'astralock-handoff', storage, runId: 'run-robust-report' });
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 45);
    await rig.recorder!.complete();

    const report = await storage.readFile('run-robust-report', RUN_FILES.report);
    expect(report).toContain('astralock-x');
    expect(report).toContain('Handoff');
    // Still entirely offline.
    for (const forbidden of ['http://', 'https://', '<script']) {
      expect(report).not.toContain(forbidden);
    }
  });

  it('a baseline report does not sprout empty robust sections', async () => {
    // Conditional presentation: a baseline run cannot reach handoff, and a
    // table of N/A rows about states it does not have would be noise.
    const storage = new MemoryStorage();
    const rig = baselineRig({
      scenario: 'astralock-stationary',
      storage,
      runId: 'run-baseline-report',
    });
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 30);
    await rig.recorder!.complete();

    const report = await storage.readFile('run-baseline-report', RUN_FILES.report);
    expect(report).toContain('baseline-kf-pid');
    expect(report).not.toContain('Handoff readiness');
  });
});
