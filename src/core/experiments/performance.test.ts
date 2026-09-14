// @vitest-environment node
/**
 * What recording costs, in wall-clock time.
 *
 * Runs in the isolated performance group (vite.config.ts), because these are
 * measurements of the machine. Recording may make the wall clock longer. It must
 * not make the simulation different — the equivalence tests prove that — and
 * none of these figures is a simulated quantity.
 *
 * The ceilings are generous on purpose: the point is to catch something
 * accidentally quadratic in the recorder, not to benchmark a shared runner.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, describe, expect, it, vi } from 'vitest';

import { NodeFileStorage } from './node-storage.node';
import { BATCH_ROWS } from './recorder';
import { buildRig, drive, driveRespectingBackpressure } from './rig.node';
import { RUN_FILES } from './storage';

vi.setConfig({ testTimeout: 600_000 });

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

const SIMULATED_SECONDS = 30;

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

describe('recorder overhead', () => {
  it('is measured separately: loop throughput off and on, writer throughput, finalisation', async () => {
    // Warm the JIT on a throwaway run so the first measurement is not paying for it.
    drive(buildRig({ scenario: 'pat-moving-target' }), 10);

    const offMs: number[] = [];
    const onMs: number[] = [];
    const bytes: number[] = [];
    const finaliseMs: number[] = [];
    let offHash: string;
    let lastRoot = '';

    // Interleaved and repeated, reporting medians: a single off-then-on pair is
    // dominated by whichever run the JIT and the file cache happened to favour.
    for (let repeat = 0; repeat < 3; repeat += 1) {
      const offRig = buildRig({ scenario: 'pat-moving-target' });
      const offStarted = performance.now();
      offHash = drive(offRig, SIMULATED_SECONDS).stateHash;
      offMs.push(performance.now() - offStarted);

      const root = await mkdtemp(join(tmpdir(), 'astralock-cost-'));
      roots.push(root);
      lastRoot = root;
      const storage = new NodeFileStorage(root);

      const onRig = buildRig({ scenario: 'pat-moving-target', storage, runId: 'run-cost' });
      await onRig.recorder!.start({ autonomyActive: true });
      const onStarted = performance.now();
      const { trace: on } = await driveRespectingBackpressure(onRig, SIMULATED_SECONDS);
      await onRig.recorder!.drain();
      onMs.push(performance.now() - onStarted);
      bytes.push(onRig.recorder!.status.bytesWritten);

      const finaliseStarted = performance.now();
      await onRig.recorder!.complete();
      finaliseMs.push(performance.now() - finaliseStarted);

      // Same simulation either way.
      expect(on.stateHash).toBe(offHash);
    }

    const off = median(offMs);
    const on = median(onMs);
    const written = median(bytes);

    // The writer on its own: the recorded telemetry re-appended in recorder-sized
    // batches with nothing else running. Timing appends during a run would
    // include the time the synchronous loop held the event loop, which is the
    // loop's cost, not the writer's.
    const source = new NodeFileStorage(lastRoot);
    const lines: string[] = [];
    await source.readLines('run-cost', RUN_FILES.telemetry, (line) => lines.push(line));
    const batches: string[] = [];
    for (let i = 0; i < lines.length; i += BATCH_ROWS) {
      batches.push(`${lines.slice(i, i + BATCH_ROWS).join('\n')}\n`);
    }
    await source.createRun('run-writer');
    const writerStarted = performance.now();
    let writerBytes = 0;
    for (const batch of batches) {
      await source.append('run-writer', RUN_FILES.telemetry, batch);
      writerBytes += batch.length;
    }
    const writerMs = performance.now() - writerStarted;
    // eslint-disable-next-line no-console -- the measured figures are the point of this test
    console.log(
      `recorder overhead, median of 3 interleaved runs over ${String(SIMULATED_SECONDS)} simulated s: ` +
        `off ${off.toFixed(0)} ms (${((SIMULATED_SECONDS * 1000) / off).toFixed(1)}x real time), ` +
        `on ${on.toFixed(0)} ms (${((SIMULATED_SECONDS * 1000) / on).toFixed(1)}x real time), ` +
        `overhead ${(((on - off) / off) * 100).toFixed(1)}%; ` +
        `${(written / 1e6).toFixed(2)} MB recorded; ` +
        `writer alone ${(writerBytes / 1e6 / (writerMs / 1000)).toFixed(1)} MB/s ` +
        `(${String(batches.length)} batch appends); ` +
        `finalisation (summary + report streamed from disk) ${median(finaliseMs).toFixed(0)} ms`,
    );

    expect(on).toBeLessThan(off * 5 + 5000);
    expect(median(finaliseMs)).toBeLessThan(15_000);
  });
});
