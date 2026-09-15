// @vitest-environment node
/**
 * What AstraBench costs, and what it holds on to.
 *
 * Two questions, neither rhetorical. A benchmark runner that leaked a
 * simulation per run would fall over somewhere between fifty and a hundred, and
 * one whose orchestration cost was comparable to the simulation would be
 * measuring itself. Both are measured rather than assumed.
 *
 * **Throughput is not frame rate.** These runs execute much faster than real
 * time, and the right name for that is simulation throughput — simulated
 * seconds per wall-clock second. Nothing about it is a camera FPS, and no
 * simulation timestamp is altered to achieve it: the engine advances at its
 * configured tick rate and simply is not asked to wait.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_BASELINE_PAT_CONFIG, algorithmById } from '@/core/algorithms';
import { buildRig, drive, trace } from '@/core/experiments/rig.node';
import { DEFAULT_METRICS_CONFIG } from '@/core/experiments/schema';
import { MemoryStorage } from '@/core/experiments/storage';

import { runBenchmark } from './runner';
import { BENCHMARK_SCHEMA_VERSION, benchmarkSuiteSchema, type BenchmarkSuite } from './schema';

vi.setConfig({ testTimeout: 1_800_000 });

/** A suite of `runs` short runs of one scenario. */
function suiteOf(runs: number, seconds: number): BenchmarkSuite {
  return benchmarkSuiteSchema.parse({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    suiteId: 'load',
    name: 'Load suite',
    description: '',
    metricsConfig: DEFAULT_METRICS_CONFIG,
    defaultSuccess: { kind: 'acquired' },
    cases: [
      {
        caseId: 'moving',
        label: 'Smooth crossing target',
        description: '',
        scenarioId: 'astralock-moving',
        durationSeconds: seconds,
        seeds: Array.from({ length: runs }, (_, index) => 5000 + index),
        arms: [
          {
            armId: 'baseline',
            label: 'Baseline KF + PID',
            algorithmId: 'baseline-kf-pid',
            config: DEFAULT_BASELINE_PAT_CONFIG,
          },
        ],
        success: null,
      },
    ],
  });
}

const heapBytes = (): number | null => {
  const usage = (globalThis as { process?: { memoryUsage?: () => { heapUsed: number } } }).process;
  return usage?.memoryUsage === undefined ? null : usage.memoryUsage().heapUsed;
};

describe('a fifty-run suite', () => {
  it('stays bounded in memory and keeps nothing from finished runs', async () => {
    // Fifty runs of a real 640x480 sensor. If the runner retained an engine, a
    // sensor or a telemetry buffer per run, this is where it would show.
    const runs = 50;
    const suite = suiteOf(runs, 4);

    (globalThis as { gc?: () => void }).gc?.();
    const before = heapBytes();

    const started = performance.now();
    const execution = await runBenchmark({
      suite,
      runStorage: new MemoryStorage(),
      benchmarkStorage: new MemoryStorage(),
      resolvePlugin: algorithmById,
      benchmarkId: 'bench-load',
      applicationVersion: '0.0.0-test',
      sourceCommit: null,
      platform: 'test',
    });
    const elapsedMs = performance.now() - started;

    (globalThis as { gc?: () => void }).gc?.();
    const after = heapBytes();

    expect(execution.manifest.runs).toHaveLength(runs);
    expect(execution.manifest.runs.every((run) => run.status === 'completed')).toBe(true);

    const simulatedSeconds = runs * 4;
    // eslint-disable-next-line no-console -- the measured figures are the point
    console.log(
      `${String(runs)} runs of 4 simulated seconds in ${(elapsedMs / 1000).toFixed(1)} s wall clock\n` +
        `  simulation throughput: ${(simulatedSeconds / (elapsedMs / 1000)).toFixed(1)}x real time\n` +
        `  per run: ${(elapsedMs / runs).toFixed(0)} ms\n` +
        (before === null || after === null
          ? '  heap: not measurable in this runtime'
          : `  heap: ${(before / 1e6).toFixed(1)} MB -> ${(after / 1e6).toFixed(1)} MB`),
    );

    if (before !== null && after !== null) {
      // Generous, because a JavaScript heap is not a tidy thing and the storage
      // deliberately holds fifty runs' artifacts in memory in this test. What
      // would fail here is retention proportional to runs x frames.
      expect(after - before).toBeLessThan(400e6);
    }
  });

  it('spends its time in the simulation rather than in the orchestration', async () => {
    // The overhead question: what does wrapping a run in a benchmark add over
    // driving the same run directly? Measured as the difference between the two
    // and reported, because "negligible" is a claim and a number is a fact.
    const seconds = 4;
    const runs = 6;

    const directStarted = performance.now();
    for (let index = 0; index < runs; index += 1) {
      const rig = buildRig({
        scenario: 'astralock-moving',
        plugin: algorithmById('baseline-kf-pid')!,
        algorithmConfig: DEFAULT_BASELINE_PAT_CONFIG,
        storage: null,
      });
      drive(rig, seconds);
    }
    const directMs = performance.now() - directStarted;

    const benchStarted = performance.now();
    await runBenchmark({
      suite: suiteOf(runs, seconds),
      runStorage: new MemoryStorage(),
      benchmarkStorage: new MemoryStorage(),
      resolvePlugin: algorithmById,
      benchmarkId: 'bench-overhead',
      applicationVersion: '0.0.0-test',
      sourceCommit: null,
      platform: 'test',
    });
    const benchMs = performance.now() - benchStarted;

    // eslint-disable-next-line no-console -- the measured figures are the point
    console.log(
      `${String(runs)} runs of ${String(seconds)} simulated seconds:\n` +
        `  driven directly, no recorder:  ${(directMs / 1000).toFixed(2)} s\n` +
        `  through AstraBench, recorded:  ${(benchMs / 1000).toFixed(2)} s\n` +
        `  ratio: ${(benchMs / directMs).toFixed(2)}x (recording and evaluation included)`,
    );

    // The benchmark does strictly more work — it records every frame and
    // evaluates it — so it is expected to be slower. What would be wrong is
    // orchestration dominating: a large multiple would mean the harness, not
    // the simulation, was the cost.
    expect(benchMs).toBeLessThan(directMs * 12);
  });
});

describe('recording a run and driving it directly', () => {
  it('produce the same engineering result', async () => {
    // The Phase 5 guarantee, restated for the benchmark path: observing a run
    // does not change it. The recorder is an observer, so a benchmark's numbers
    // describe the same run that would have happened without one.
    const recorded = buildRig({
      scenario: 'astralock-moving',
      storage: new MemoryStorage(),
      runId: 'obs-on',
      plugin: algorithmById('baseline-kf-pid')!,
      algorithmConfig: DEFAULT_BASELINE_PAT_CONFIG,
    });
    await recorded.recorder!.start({ autonomyActive: true });
    drive(recorded, 10);
    await recorded.recorder!.complete();

    const bare = buildRig({
      scenario: 'astralock-moving',
      storage: null,
      plugin: algorithmById('baseline-kf-pid')!,
      algorithmConfig: DEFAULT_BASELINE_PAT_CONFIG,
    });
    drive(bare, 10);

    const a = trace(recorded);
    const b = trace(bare);
    expect(b.modes).toEqual(a.modes);
    expect(b.commands).toEqual(a.commands);
    expect(b.stateHash).toBe(a.stateHash);
  });
});
