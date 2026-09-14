// @vitest-environment node
/**
 * The recorder, against real closed-loop runs.
 *
 * Three properties are load-bearing for the whole phase:
 *
 *   - recording changes nothing about the engineering result;
 *   - the summary can be rebuilt from the files on disk, and that rebuild
 *     notices when the files have been tampered with;
 *   - an interrupted run cannot masquerade as a completed one.
 *
 * The rest check that the recorded numbers correspond to what actually
 * happened, using assertions computed independently of the recorder.
 */

import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { parseSimulationConfig } from '@/core/contracts/simulation';
import type { LoopObservation, LoopObserver } from '@/core/runtime/closed-loop';
import { cameraBasis } from '@/core/sensors/pinhole';

import { fingerprint } from './fingerprint';
import { NodeFileStorage } from './node-storage.node';
import {
  completedResults,
  displayStatus,
  listRuns,
  readManifest,
  recomputeSummary,
  summariseStoredRun,
} from './recompute';
import type { ExperimentRecorder } from './recorder';
import { BATCH_ROWS } from './recorder';
import { buildRig, drive, driveRespectingBackpressure, firstModeTime } from './rig.node';
import { DEFAULT_METRICS_CONFIG, experimentSummarySchema } from './schema';
import { parseEventLog, parseTelemetryCsv } from './serialisation';
import { MemoryStorage, RUN_FILES } from './storage';

vi.setConfig({ testTimeout: 300_000 });

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function temporaryStorage(): Promise<{ root: string; storage: NodeFileStorage }> {
  const root = await mkdtemp(join(tmpdir(), 'astralock-runs-'));
  roots.push(root);
  return { root, storage: new NodeFileStorage(root) };
}

// --- Mandatory: recording must not change the result -----------------------

describe('recording is an observer, not a participant', () => {
  it.each([
    ['pat-stationary-outside-fov', 25],
    ['pat-loss', 15],
  ] as const)(
    '%s: identical transitions, commands, pose and hash with the recorder on and off',
    async (scenario, seconds) => {
      const off = buildRig({ scenario });
      const on = buildRig({ scenario, storage: new MemoryStorage(), runId: 'run-equivalence' });
      await on.recorder!.start({ autonomyActive: true });

      const a = drive(off, seconds);
      const b = drive(on, seconds);
      await on.recorder!.complete();

      expect(b.modes).toEqual(a.modes);
      expect(b.modes.length).toBeGreaterThan(1);
      expect(b.commands).toEqual(a.commands);
      expect(b.commands.length).toBeGreaterThan(seconds * 50);
      expect(b.finalMeasuredPan).toBe(a.finalMeasuredPan);
      expect(b.finalMeasuredTilt).toBe(a.finalMeasuredTilt);
      expect(b.stateHash).toBe(a.stateHash);
      expect(b.framesProcessed).toBe(a.framesProcessed);
    },
  );

  it('is unchanged by a storage so slow that backpressure holds the simulation back', async () => {
    // Every append waits a macrotask. With a small high-water mark the driver
    // repeatedly stops advancing to let the queue drain — which must cost wall
    // time and nothing else.
    const slow = new MemoryStorage();
    const append = slow.append.bind(slow);
    slow.append = async (...args) => {
      await new Promise((resolve) => setTimeout(resolve, 0));
      return append(...args);
    };

    const off = buildRig({ scenario: 'pat-stationary-outside-fov' });
    const on = buildRig({
      scenario: 'pat-stationary-outside-fov',
      storage: slow,
      runId: 'run-backpressure',
      backpressureBytes: 16 * 1024,
    });
    await on.recorder!.start({ autonomyActive: true });

    const a = drive(off, 20);
    const { trace: b, maxPendingBytes } = await driveRespectingBackpressure(on, 20);
    const summary = await on.recorder!.complete();

    expect(b).toEqual(a);
    // Bounded: never more than the mark plus one flushed batch. A batch is
    // BATCH_ROWS frames of telemetry, evaluation and events, about 1.3 KB each.
    expect(maxPendingBytes).toBeGreaterThan(16 * 1024);
    expect(maxPendingBytes).toBeLessThan(16 * 1024 + BATCH_ROWS * 2 * 1024);
    // And nothing was dropped to keep up.
    expect(summary.algorithmFramesProcessed).toBe(20 * 60);
  });

  it('keeps the loop running untouched when the writer fails, and says so', async () => {
    const off = buildRig({ scenario: 'pat-stationary-outside-fov' });
    const storage = new MemoryStorage();
    const on = buildRig({
      scenario: 'pat-stationary-outside-fov',
      storage,
      runId: 'run-disk-fail',
    });
    await on.recorder!.start({ autonomyActive: true });

    drive(on, 1);
    vi.spyOn(storage, 'append').mockRejectedValue(new Error('disk on fire'));
    // Long enough for the next batch to be flushed, and fail.
    drive(on, (BATCH_ROWS / 60) * 1.5);
    await on.recorder!.drain();

    // The recorder stopped at once, rather than carrying on into a log with a hole.
    expect(on.recorder!.status.state).toBe('failed');
    expect(on.recorder!.status.writerError).toBe('disk on fire');

    const b = drive(on, 15);
    const a = drive(off, 16 + (BATCH_ROWS / 60) * 1.5);
    expect(b.modes).toEqual(a.modes);
    expect(b.commands).toEqual(a.commands);
    expect(b.stateHash).toBe(a.stateHash);

    await expect(on.recorder!.complete()).rejects.toThrow(/failed to persist: disk on fire/);
    const manifest = await readManifest(storage, 'run-disk-fail');
    expect(manifest.status).toBe('failed');
    expect(manifest.terminationReason).toBe('writer-error');
    await expect(storage.readFile('run-disk-fail', RUN_FILES.summary)).rejects.toThrow();
  });
});

// --- Mandatory: offline recomputation ---------------------------------------

/** Watches alongside the recorder, computing pointing error its own way. */
function oracle(recorder: ExperimentRecorder | null, rig: () => ReturnType<typeof buildRig>) {
  const errors: number[] = [];
  const observer: LoopObserver = {
    onSensorFrame: (id, time) => {
      recorder?.onSensorFrame(id, time);
    },
    onCommandApplied: (applied) => {
      recorder?.onCommandApplied(applied);
    },
    onFrameProcessed: (observation: LoopObservation) => {
      recorder?.onFrameProcessed(observation);
      // Deliberately a different formula from the evaluator: the textbook
      // acos of the dot product, from the raw engine state at capture time.
      const { engine } = rig();
      const t = observation.frame.captureTime;
      const pose = engine.gimbalPoseAt(t);
      const axis = cameraBasis(pose.azimuth, pose.elevation).forward;
      const truth = engine.sampleAtTime(t);
      const p = truth.platform.pose.position;
      const q = truth.targets[0]!.pose.position;
      const d = [q.x - p.x, q.y - p.y, q.z - p.z];
      const n = Math.hypot(d[0]!, d[1]!, d[2]!);
      const dot = (axis.x * d[0]! + axis.y * d[1]! + axis.z * d[2]!) / n;
      errors.push(Math.acos(Math.min(1, Math.max(-1, dot))));
    },
  };
  return { errors, observer };
}

describe('a summary rebuilt from the files alone', () => {
  it('matches the stored summary after every in-memory object is discarded', async () => {
    const { root, storage } = await temporaryStorage();
    let rigRef: ReturnType<typeof buildRig> | null = null;
    let independent: number[] = [];
    const rig = buildRig({
      scenario: 'pat-stationary-outside-fov',
      storage,
      runId: 'run-recompute',
      observe: (recorder) => {
        const tap = oracle(recorder, () => rigRef!);
        independent = tap.errors;
        return tap.observer;
      },
    });
    rigRef = rig;
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 30);
    await rig.recorder!.complete();

    // Nothing from the run survives past this point except the directory.
    const cold = new NodeFileStorage(root);
    const { stored, recomputed, differences } = await recomputeSummary(cold, 'run-recompute');
    expect(differences).toEqual([]);
    expect(experimentSummarySchema.safeParse(stored).success).toBe(true);

    // And the pipeline as a whole agrees with a pointing error computed by
    // different code from the engine directly.
    const whole = recomputed.angularPointingError.wholeRun;
    expect(whole.count).toBe(independent.length);
    const mean = independent.reduce((a, b) => a + b, 0) / independent.length;
    expect(Math.abs(whole.mean.value! - mean) / mean).toBeLessThan(1e-9);
    expect(Math.abs(whole.max.value! - Math.max(...independent))).toBeLessThan(1e-9);
  });

  it('notices a hand-edited summary', async () => {
    const storage = new MemoryStorage();
    const rig = buildRig({ scenario: 'pat-stationary-outside-fov', storage, runId: 'run-edit' });
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 25);
    await rig.recorder!.complete();

    const summary = JSON.parse(await storage.readFile('run-edit', RUN_FILES.summary));
    summary.lockRetentionRate.value = 0.5;
    summary.angularPointingError.postAcquisition.mean.value = 1e-7;
    await storage.writeAtomic('run-edit', RUN_FILES.summary, JSON.stringify(summary));

    const { differences } = await recomputeSummary(storage, 'run-edit');
    expect(differences.map((d) => d.path)).toEqual(
      expect.arrayContaining([
        'lockRetentionRate.value',
        'angularPointingError.postAcquisition.mean.value',
      ]),
    );
  });

  it('notices an altered sample, a replaced snapshot and a reordered log', async () => {
    const storage = new MemoryStorage();
    const rig = buildRig({ scenario: 'pat-stationary-outside-fov', storage, runId: 'run-tamper' });
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 25);
    await rig.recorder!.complete();

    // One evaluation row, late in the run, now claims a large pointing error.
    const evaluation = (await storage.readFile('run-tamper', RUN_FILES.evaluation)).split('\n');
    const header = evaluation[0]!.split(',');
    const column = header.indexOf('truth_angular_pointing_error_rad');
    const row = evaluation[evaluation.length - 10]!.split(',');
    row[column] = '5.0000000000000000e-1';
    evaluation[evaluation.length - 10] = row.join(',');
    await storage.writeAtomic('run-tamper', RUN_FILES.evaluation, evaluation.join('\n'));
    const altered = await recomputeSummary(storage, 'run-tamper');
    expect(altered.differences.length).toBeGreaterThan(0);

    const scenario = JSON.parse(await storage.readFile('run-tamper', RUN_FILES.scenario));
    scenario.seed += 1;
    await storage.writeAtomic('run-tamper', RUN_FILES.scenario, JSON.stringify(scenario));
    await expect(recomputeSummary(storage, 'run-tamper')).rejects.toThrow(
      /scenario.json does not match/,
    );
    scenario.seed -= 1;
    await storage.writeAtomic('run-tamper', RUN_FILES.scenario, JSON.stringify(scenario));

    const events = (await storage.readFile('run-tamper', RUN_FILES.events)).split('\n');
    [events[3], events[4]] = [events[4]!, events[3]!];
    await storage.writeAtomic('run-tamper', RUN_FILES.events, events.join('\n'));
    await expect(recomputeSummary(storage, 'run-tamper')).rejects.toThrow(/out of order/);
  });

  it('can rescore a run under another, explicitly identified definition without rewriting it', async () => {
    const storage = new MemoryStorage();
    const rig = buildRig({ scenario: 'pat-stationary-outside-fov', storage, runId: 'run-rescore' });
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 30);
    const stored = await rig.recorder!.complete();
    const before = await storage.readFile('run-rescore', RUN_FILES.summary);

    const strict = { ...DEFAULT_METRICS_CONFIG, lockErrorThresholdRad: 1e-4 };
    const rescored = await summariseStoredRun(storage, 'run-rescore', { metricsConfig: strict });

    expect(rescored.metricsFingerprint).toBe(fingerprint(strict));
    expect(rescored.metricsFingerprint).not.toBe(stored.metricsFingerprint);
    // A 100 µrad lock is far tighter than this platform's jitter allows.
    expect(rescored.lockRetentionRate.value).not.toBe(stored.lockRetentionRate.value);
    // The record on disk is untouched.
    expect(await storage.readFile('run-rescore', RUN_FILES.summary)).toBe(before);
  });
});

// --- Mandatory: interrupted runs --------------------------------------------

describe('an interrupted run', () => {
  it('stays marked incomplete, is never a result, and is inspectable and deletable', async () => {
    const { root, storage } = await temporaryStorage();
    const rig = buildRig({
      scenario: 'pat-stationary-outside-fov',
      storage,
      runId: 'run-interrupted',
    });
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 6);
    await rig.recorder!.drain();
    // No complete(), no abort(): the process simply stops existing.

    const cold = new NodeFileStorage(root);
    const listing = (await listRuns(cold)).find((entry) => entry.runId === 'run-interrupted')!;
    expect(listing.error).toBeNull();
    expect(listing.manifest!.status).toBe('running');
    expect(displayStatus(listing.manifest!.status)).toBe('incomplete');
    expect(listing.summary).toBeNull();
    expect(completedResults([listing])).toEqual([]);

    await expect(recomputeSummary(cold, 'run-interrupted')).rejects.toThrow(/incomplete/);
    await expect(summariseStoredRun(cold, 'run-interrupted')).rejects.toThrow(/never ended/);
    expect(await cold.fileSize('run-interrupted', RUN_FILES.summary)).toBe(0);
    expect(await cold.fileSize('run-interrupted', RUN_FILES.report)).toBe(0);

    // The raw record is there to inspect.
    const telemetry = parseTelemetryCsv(
      await cold.readFile('run-interrupted', RUN_FILES.telemetry),
    );
    expect(telemetry.length).toBeGreaterThan(300);

    await cold.deleteRun('run-interrupted');
    expect(await cold.listRuns()).not.toContain('run-interrupted');
  });

  it('is not trusted even when it died after writing a summary', async () => {
    // Emulates the process dying mid-finalisation: every write after the
    // summary silently never lands, so the manifest never reaches `completed`.
    const storage = new MemoryStorage();
    let dead = false;
    const write = storage.writeAtomic.bind(storage);
    storage.writeAtomic = async (runId, file, contents) => {
      if (dead) return;
      await write(runId, file, contents);
      if (file === RUN_FILES.summary) dead = true;
    };
    const rig = buildRig({ scenario: 'pat-stationary-outside-fov', storage, runId: 'run-died' });
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 20);
    await rig.recorder!.complete();

    expect(await storage.fileSize('run-died', RUN_FILES.summary)).toBeGreaterThan(0);
    const listing = (await listRuns(storage))[0]!;
    expect(listing.manifest!.status).toBe('running');
    expect(listing.summary).toBeNull();
    expect(completedResults([listing])).toEqual([]);
  });

  it('an aborted run is marked aborted and carries no summary or report', async () => {
    const storage = new MemoryStorage();
    const rig = buildRig({ scenario: 'pat-stationary-outside-fov', storage, runId: 'run-aborted' });
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 5);
    await rig.recorder!.abort();

    const listing = (await listRuns(storage))[0]!;
    expect(listing.manifest!.status).toBe('aborted');
    expect(listing.manifest!.terminationReason).toBe('operator-aborted');
    expect(listing.summary).toBeNull();
    expect(completedResults([listing])).toEqual([]);
    await expect(storage.readFile('run-aborted', RUN_FILES.summary)).rejects.toThrow();
    await expect(storage.readFile('run-aborted', RUN_FILES.report)).rejects.toThrow();
    const events = parseEventLog(await storage.readFile('run-aborted', RUN_FILES.events));
    expect(events.at(-1)!.type).toBe('experiment-aborted');
  });

  it('a runtime failure marks the run failed, with the reason', async () => {
    const storage = new MemoryStorage();
    const rig = buildRig({ scenario: 'pat-stationary-outside-fov', storage, runId: 'run-crash' });
    await rig.recorder!.start({ autonomyActive: true });
    drive(rig, 3);
    await rig.recorder!.fail('detector exploded');

    const manifest = await readManifest(storage, 'run-crash');
    expect(manifest.status).toBe('failed');
    expect(manifest.terminationReason).toBe('runtime-error');
    const events = parseEventLog(await storage.readFile('run-crash', RUN_FILES.events));
    expect(events.at(-1)).toMatchObject({
      type: 'experiment-failed',
      detail: { message: 'detector exploded' },
    });
  });
});

// --- The event log ----------------------------------------------------------

describe('the event log', () => {
  it('records changes in deterministic order, without per-frame noise or ground truth', async () => {
    const storage = new MemoryStorage();
    const rig = buildRig({ scenario: 'pat-loss', storage, runId: 'run-events' });
    await rig.recorder!.start({ autonomyActive: true });
    const run = drive(rig, 30);
    await rig.recorder!.complete();

    const events = parseEventLog(await storage.readFile('run-events', RUN_FILES.events));
    events.forEach((event, index) => {
      expect(event.sequence).toBe(index);
      if (index > 0) {
        expect(event.simulationTime).toBeGreaterThanOrEqual(events[index - 1]!.simulationTime);
      }
      // Nothing privileged in any payload.
      for (const key of Object.keys(event.detail)) {
        expect(key).not.toMatch(/truth|target|range|lineOfSight|pointingError/i);
      }
    });

    const types = events.map((event) => event.type);
    expect(types[0]).toBe('experiment-started');
    expect(types.at(-1)).toBe('experiment-completed');
    for (const expected of [
      'autonomy-enabled',
      'search-started',
      'candidate-detected',
      'track-entered',
      'lock-lost',
      'lost-entered',
      'search-reentered',
      'command-issued',
      'command-applied',
    ] as const) {
      expect(types).toContain(expected);
    }

    // Changes, not samples: 1,800 frames, but only a handful of state events.
    const stateEvents = types.filter((t) => t !== 'command-issued' && t !== 'command-applied');
    expect(stateEvents.length).toBeLessThan(40);
    expect(types.filter((t) => t === 'track-entered').length).toBe(
      run.modes.filter((m) => m.startsWith('track@')).length,
    );

    // One issue event per command the runtime issued, and every applied one
    // applied exactly the mount's latency later.
    const telemetry = parseTelemetryCsv(await storage.readFile('run-events', RUN_FILES.telemetry));
    const issued = events.filter((e) => e.type === 'command-issued');
    expect(issued.length).toBe(telemetry.filter((row) => row.command_id !== null).length);
    const latency = rig.engine.config.gimbal.commandLatency;
    for (const applied of events.filter((e) => e.type === 'command-applied')) {
      const d = applied.detail as { appliedAt: number; issuedAt: number };
      expect(d.appliedAt - d.issuedAt).toBeCloseTo(latency, 12);
    }
  });
});

// --- Artifacts and provenance -----------------------------------------------

describe('a completed run directory', () => {
  it('contains every artifact, classified, with provenance that does not drift', async () => {
    const { root, storage } = await temporaryStorage();
    const rig = buildRig({ scenario: 'pat-moving-target', storage, runId: 'run-artifacts' });
    await rig.recorder!.start({ autonomyActive: true });
    const startManifest = await readManifest(storage, 'run-artifacts');
    drive(rig, 15);
    const summary = await rig.recorder!.complete();

    for (const file of Object.values(RUN_FILES)) {
      expect(await storage.fileSize('run-artifacts', file), file).toBeGreaterThan(0);
    }
    const manifest = await readManifest(storage, 'run-artifacts');
    expect(manifest.status).toBe('completed');
    expect(manifest.artifacts[RUN_FILES.evaluation]).toBe('privileged-evaluation');
    expect(manifest.artifacts[RUN_FILES.telemetry]).toBe('safe-telemetry');
    // Created once; ended once.
    expect(manifest.host.createdAt).toBe(startManifest.host.createdAt);
    expect(startManifest.host.endedAt).toBeNull();
    expect(manifest.host.endedAt).not.toBeNull();
    // A null commit is reported as null, not invented.
    expect(manifest.host.sourceCommit).toBeNull();
    expect(manifest.host.sourceTreeModified).toBeNull();
    // Node's timer is far finer than a millisecond; the resolution is recorded either way.
    expect(manifest.host.timerResolutionMs).toBeGreaterThan(0);
    expect(manifest.host.timerResolutionMs).toBeLessThan(1);
    expect(manifest.sensorFramesGenerated).toBe(summary.sensorFramesGenerated);
    expect(manifest.endStateHash).toBe(rig.engine.stateHash());

    // The snapshot is the configuration, and loads through the real parser.
    const snapshot = parseSimulationConfig(
      JSON.parse(await readFile(join(root, 'run-artifacts', RUN_FILES.scenario), 'utf8')),
    );
    expect(fingerprint(snapshot)).toBe(fingerprint(rig.engine.config));

    // No stray temporary files from atomic writes.
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(join(root, 'run-artifacts'));
    expect(files.filter((name) => name.endsWith('.tmp'))).toEqual([]);
    expect(files.sort()).toEqual(Object.values(RUN_FILES).sort());
  });

  it('gives two recordings of the same experiment the same fingerprints, and different ones different', async () => {
    const storage = new MemoryStorage();
    const a = buildRig({ scenario: 'pat-stationary-outside-fov', storage, runId: 'run-fp-a' });
    const b = buildRig({ scenario: 'pat-stationary-outside-fov', storage, runId: 'run-fp-b' });
    const c = buildRig({ scenario: 'pat-moving-target', storage, runId: 'run-fp-c' });
    for (const rig of [a, b, c]) await rig.recorder!.start({ autonomyActive: true });
    for (const rig of [a, b, c]) await rig.recorder!.abort();

    const [ma, mb, mc] = await Promise.all(
      ['run-fp-a', 'run-fp-b', 'run-fp-c'].map((id) => readManifest(storage, id)),
    );
    expect(mb!.scenarioFingerprint).toBe(ma!.scenarioFingerprint);
    expect(mb!.algorithmFingerprint).toBe(ma!.algorithmFingerprint);
    expect(mb!.metricsFingerprint).toBe(ma!.metricsFingerprint);
    expect(mc!.scenarioFingerprint).not.toBe(ma!.scenarioFingerprint);
  });

  it('refuses to overwrite a run by preparing it twice', async () => {
    const storage = new MemoryStorage();
    const rig = buildRig({ scenario: 'pat-stationary-outside-fov', storage, runId: 'run-twice' });
    await rig.recorder!.start({ autonomyActive: true });
    await expect(rig.recorder!.prepare()).rejects.toThrow();
  });
});

// --- Validation experiments -------------------------------------------------

describe('summaries of the Phase 4 scenarios, checked against what happened', () => {
  it('stationary beacon outside the field of view: searched, acquired, held', async () => {
    const storage = new MemoryStorage();
    const rig = buildRig({
      scenario: 'pat-stationary-outside-fov',
      storage,
      runId: 'run-stationary',
    });
    await rig.recorder!.start({ autonomyActive: true });
    const run = drive(rig, 40);
    const s = await rig.recorder!.complete();

    // Milestones agree with the transitions observed directly from the loop.
    expect(s.searchStartTime.value).toBe(firstModeTime(run, 'scan'));
    expect(s.trackEntryTime.value).toBe(firstModeTime(run, 'track'));
    expect(s.acquisitionOutcome).toBe('acquired');
    // The baseline wants two consecutive detections, so TRACK follows the first
    // detection by one frame, give or take a tick of availability.
    const frame = 1 / 60;
    expect(s.firstDetectionTime.value!).toBeLessThanOrEqual(s.trackEntryTime.value!);
    expect(s.trackEntryTime.value! - s.firstDetectionTime.value!).toBeLessThan(
      frame + 0.005 + 1e-9,
    );
    expect(s.coarseLockTime.value!).toBeGreaterThanOrEqual(
      s.trackEntryTime.value! + DEFAULT_METRICS_CONFIG.lockDwellSeconds - 1e-9,
    );
    expect(s.coarseAcquisitionTime.value!).toBeGreaterThan(5);
    expect(s.coarseAcquisitionTime.value!).toBeLessThan(30);

    // Settled accuracy consistent with the Phase 4 validation (~0.5 px median).
    expect(s.imagePointingError.postAcquisition.median.value!).toBeLessThan(1);
    expect(s.angularPointingError.postAcquisition.max.value!).toBeLessThan(
      DEFAULT_METRICS_CONFIG.lockErrorThresholdRad,
    );
    expect(s.lockRetentionRate.value!).toBeGreaterThan(0.95);
    expect(s.lossOfLockEpisodes).toBe(0);
    expect(s.detectorCentroidError.median.value!).toBeLessThan(0.1);
    expect(s.falseLockExercised).toBe(false);

    // Frames and timing.
    expect(s.algorithmFramesProcessed).toBe(40 * 60);
    expect(s.effectiveSensorFps.value).toBe(60);
    expect(s.algorithmProcessedFps.value).toBe(60);
    expect(s.hostProcessingTime.algorithmTotal.count).toBe(run.framesProcessed);
    expect(s.controlLatency.captureToIssue.max.value!).toBeLessThan(1 / 200 + 1e-12);
    expect(s.controlLatency.issueToApplication.mean.value!).toBeCloseTo(0.023, 12);
    expect(s.controlLatency.scheduledToActualApplication.max.value).toBe(0);
  });

  it('moving target: acquired and followed without loss', async () => {
    const storage = new MemoryStorage();
    const rig = buildRig({ scenario: 'pat-moving-target', storage, runId: 'run-moving' });
    await rig.recorder!.start({ autonomyActive: true });
    const run = drive(rig, 55);
    const s = await rig.recorder!.complete();

    expect(s.trackEntryTime.value).toBe(firstModeTime(run, 'track'));
    expect(s.acquisitionOutcome).toBe('acquired');
    expect(s.lossOfLockEpisodes).toBe(0);
    expect(s.lockRetentionRate.value!).toBeGreaterThan(0.95);
    // Consistent with the Phase 4 moving-target validation (~0.2 px median).
    expect(s.imagePointingError.postAcquisition.median.value!).toBeLessThan(0.5);
  });

  it('loss scenario: acquired, lost when the target outran the mount, never recovered', async () => {
    const storage = new MemoryStorage();
    const rig = buildRig({ scenario: 'pat-loss', storage, runId: 'run-loss' });
    await rig.recorder!.start({ autonomyActive: true });
    const run = drive(rig, 40);
    const s = await rig.recorder!.complete();

    expect(run.modes.some((m) => m.startsWith('lost@'))).toBe(true);
    expect(s.acquisitionOutcome).toBe('acquired');
    expect(s.lossOfLockEpisodes).toBeGreaterThanOrEqual(1);
    // The beacon starts to move at 6 s.
    expect(s.episodes[0]!.lost_at_s).toBeGreaterThanOrEqual(6);
    expect(s.episodes[0]!.lost_at_s).toBeLessThan(9);
    expect(s.unrecoveredLosses).toBeGreaterThanOrEqual(1);
    expect(s.episodes.filter((e) => e.unrecovered).length).toBe(s.unrecoveredLosses);
    expect(s.reacquisitionCount).toBe(0);
    expect(s.reacquisitionTime.median.status).toBe('not-measured');
    expect(s.lockRetentionRate.value!).toBeLessThan(0.5);
    // The failure is in the post-acquisition statistics, not cropped out.
    expect(s.angularPointingError.postAcquisition.max.value!).toBeGreaterThan(0.1);
  });
});
