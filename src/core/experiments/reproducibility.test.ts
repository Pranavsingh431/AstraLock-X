// @vitest-environment node
/**
 * Getting a run again from what was saved, and recording a long one.
 *
 * The question a reader of a report actually has is "could I get this again?".
 * The first test answers it by taking only the files a completed run left on
 * disk — scenario.json, algorithm.json, the manifest — rerunning the experiment
 * from them, and checking the rerun against the *recorded* event log, telemetry
 * and end-state hash rather than against anything still in memory.
 *
 * Host wall-clock timings are deliberately excluded. They measure the machine,
 * not the experiment, and requiring them to match would be requiring two
 * computers to be the same computer.
 */

import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { parseBaselinePatConfig } from '@/core/algorithms/baseline/config';
import { parseSimulationConfig } from '@/core/contracts/simulation';

import { NodeFileStorage } from './node-storage.node';
import { readManifest, recomputeSummary } from './recompute';
import { BACKPRESSURE_BYTES, BATCH_ROWS } from './recorder';
import { buildRig, drive, driveRespectingBackpressure } from './rig.node';
import {
  evaluationParser,
  parseEventLog,
  parseTelemetryCsv,
  telemetryParser,
} from './serialisation';
import { RUN_FILES } from './storage';

vi.setConfig({ testTimeout: 600_000 });

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});
async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'astralock-repro-'));
  roots.push(root);
  return root;
}

describe('reproducing a completed run from its saved configuration', () => {
  it('reproduces the recorded transitions, commands, final encoder reading and end-state hash', async () => {
    const root = await temporaryRoot();
    {
      const rig = buildRig({
        scenario: 'pat-stationary-outside-fov',
        storage: new NodeFileStorage(root),
        runId: 'run-repro',
      });
      await rig.recorder!.start({ autonomyActive: true });
      drive(rig, 30);
      await rig.recorder!.complete();
    }
    // Everything from the original run is out of scope. Only the directory remains.

    const storage = new NodeFileStorage(root);
    const manifest = await readManifest(storage, 'run-repro');
    const scenario = parseSimulationConfig(
      JSON.parse(await storage.readFile('run-repro', RUN_FILES.scenario)),
    );
    const algorithm = parseBaselinePatConfig(
      JSON.parse(await storage.readFile('run-repro', RUN_FILES.algorithm)),
    );
    expect(scenario.seed).toBe(manifest.scenarioSeed);

    const replay = buildRig({ scenario, algorithmConfig: algorithm });
    const rerun = drive(replay, manifest.endSimulationTime! - manifest.startSimulationTime);

    // Commands, against the recorded event log.
    const recordedCommands = parseEventLog(await storage.readFile('run-repro', RUN_FILES.events))
      .filter((event) => event.type === 'command-issued')
      .map((event) => {
        const d = event.detail as {
          commandId: number;
          issuedAt: number;
          azimuthRad: number;
          elevationRad: number;
        };
        return `${String(d.commandId)}@${d.issuedAt.toExponential(17)}:${d.azimuthRad.toExponential(17)},${d.elevationRad.toExponential(17)}`;
      });
    expect(rerun.commands).toEqual(recordedCommands);
    expect(recordedCommands.length).toBeGreaterThan(1000);

    // Transitions, against the recorded telemetry.
    const telemetry = parseTelemetryCsv(await storage.readFile('run-repro', RUN_FILES.telemetry));
    const recordedModes: string[] = [];
    for (const row of telemetry) {
      if (recordedModes.at(-1)?.split('@')[0] !== row.pat_state) {
        recordedModes.push(`${row.pat_state}@${row.command_issue_time_s.toExponential(17)}`);
      }
    }
    expect(rerun.modes).toEqual(recordedModes);
    expect(recordedModes.some((mode) => mode.startsWith('track@'))).toBe(true);

    // The encoder reading at the last recorded frame, and the physical end state.
    const last = telemetry.at(-1)!;
    const reading = replay.engine.gimbal.measuredPointingAt(last.command_issue_time_s);
    expect(reading.panAngle).toBe(last.measured_pan_rad);
    expect(reading.tiltAngle).toBe(last.measured_tilt_rad);
    expect(rerun.stateHash).toBe(manifest.endStateHash);
  });
});

describe('a long recorded run', () => {
  it('stays bounded, loses nothing, keeps order, grows linearly and still recomputes', async () => {
    const root = await temporaryRoot();
    const storage = new NodeFileStorage(root);
    const rig = buildRig({ scenario: 'pat-moving-target', storage, runId: 'run-long' });
    const recorder = rig.recorder!;
    await recorder.start({ autonomyActive: true });

    const sizes = async () => {
      await recorder.drain();
      let total = 0;
      for (const file of [RUN_FILES.events, RUN_FILES.telemetry, RUN_FILES.evaluation]) {
        total += await storage.fileSize('run-long', file);
      }
      return total;
    };

    // Two minutes of simulated time: 7,200 camera frames.
    const start = await sizes();
    const first = await driveRespectingBackpressure(rig, 60);
    const half = await sizes();
    const second = await driveRespectingBackpressure(rig, 60);
    const full = await sizes();

    // Memory: the write queue never exceeded its mark by more than one batch,
    // and the recorder holds no per-sample collection of any kind.
    const batchBound = BATCH_ROWS * 4 * 1024;
    expect(Math.max(first.maxPendingBytes, second.maxPendingBytes)).toBeLessThan(
      BACKPRESSURE_BYTES + batchBound,
    );
    for (const [key, value] of Object.entries(recorder)) {
      if (Array.isArray(value)) expect(value.length, key).toBeLessThanOrEqual(BATCH_ROWS);
      if (value instanceof Map || value instanceof Set) expect(value.size, key).toBeLessThan(16);
    }
    // No frame lease leaked: the sensor pool never grew past its capacity.
    expect(rig.sensor.buffersAllocated).toBeLessThanOrEqual(3);

    // Storage grows linearly with simulated time: the second minute costs about
    // what the first did.
    const firstMinute = half - start;
    const secondMinute = full - half;
    expect(secondMinute / firstMinute).toBeGreaterThan(0.8);
    expect(secondMinute / firstMinute).toBeLessThan(1.25);

    const summary = await recorder.complete();
    const frames = second.trace.framesProcessed;
    expect(frames).toBe(120 * 60 + 1);

    // Every processed frame has exactly one row in each sample file, in order.
    let telemetryRows = 0;
    let previousFrame = -1;
    const telemetry = telemetryParser();
    await storage.readLines('run-long', RUN_FILES.telemetry, (line) => {
      const row = telemetry.line(line);
      if (row === null) return;
      expect(row.frame_id).toBe(previousFrame + 1);
      previousFrame = row.frame_id;
      telemetryRows += 1;
    });
    let evaluationRows = 0;
    let previousTime = Number.NEGATIVE_INFINITY;
    const evaluation = evaluationParser();
    await storage.readLines('run-long', RUN_FILES.evaluation, (line) => {
      const row = evaluation.line(line);
      if (row === null) return;
      expect(row.capture_time_s).toBeGreaterThan(previousTime);
      previousTime = row.capture_time_s;
      evaluationRows += 1;
    });
    expect(telemetryRows).toBe(frames);
    expect(evaluationRows).toBe(frames);
    // Half-open window: the frame captured exactly at 120 s belongs to the next interval.
    expect(summary.algorithmFramesProcessed).toBe(120 * 60);
    expect(summary.sensorFramesGenerated).toBe(120 * 60);

    // The finished record recomputes, and the report stayed small.
    const { differences } = await recomputeSummary(new NodeFileStorage(root), 'run-long');
    expect(differences).toEqual([]);
    expect(await storage.fileSize('run-long', RUN_FILES.report)).toBeLessThan(400_000);
    expect((await readdir(join(root, 'run-long'))).sort()).toEqual(Object.values(RUN_FILES).sort());

    // eslint-disable-next-line no-console -- the measured figures are reported in the phase write-up
    console.log(
      `long run: ${String(frames)} frames, ${(full / 1e6).toFixed(2)} MB raw ` +
        `(${(full / frames).toFixed(0)} B/frame), peak queue ${String(Math.max(first.maxPendingBytes, second.maxPendingBytes))} B`,
    );
  });
});
