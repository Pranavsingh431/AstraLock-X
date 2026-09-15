// @vitest-environment node
/**
 * The properties a benchmark runner has to have to be worth anything.
 *
 * Isolation, order independence, honest failure accounting, real cancellation
 * and exact recomputation. Each is a way a benchmark can be quietly wrong while
 * still producing a full table of plausible numbers, which is why they are
 * tested rather than argued.
 *
 * The suites here are deliberately tiny — short runs, few seeds — because these
 * are tests of the harness and not of the trackers. The bundled suites, and the
 * numbers worth quoting, live in `suites.ts` and `astrabench.test.ts`.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_BASELINE_PAT_CONFIG, algorithmById } from '@/core/algorithms';
import { DEFAULT_METRICS_CONFIG } from '@/core/experiments/schema';
import { MemoryStorage } from '@/core/experiments/storage';

import { aggregateBenchmark } from './aggregate';
import { recomputeBenchmark, readRunSummaries } from './recompute';
import { runBenchmark, type BenchmarkProgress } from './runner';
import {
  BENCHMARK_FILES,
  BENCHMARK_SCHEMA_VERSION,
  benchmarkSuiteSchema,
  totalRuns,
  type BenchmarkSuite,
} from './schema';

vi.setConfig({ testTimeout: 900_000 });

/** A suite small enough to run several times in a test. */
function tinySuite(patch: Partial<BenchmarkSuite> = {}): BenchmarkSuite {
  return benchmarkSuiteSchema.parse({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    suiteId: 'tiny',
    name: 'Tiny harness suite',
    description: 'Two seeds, two arms, short runs. Exercises the harness, not the trackers.',
    metricsConfig: DEFAULT_METRICS_CONFIG,
    defaultSuccess: { kind: 'acquired' },
    cases: [
      {
        caseId: 'moving',
        label: 'Smooth crossing target',
        description: '',
        scenarioId: 'astralock-moving',
        durationSeconds: 8,
        seeds: [4001, 4002],
        arms: [
          {
            armId: 'baseline',
            label: 'Baseline KF + PID',
            algorithmId: 'baseline-kf-pid',
            config: DEFAULT_BASELINE_PAT_CONFIG,
          },
          {
            armId: 'astralock',
            label: 'AstraLock-X',
            algorithmId: 'astralock-x',
            config: undefined,
          },
        ],
        success: null,
      },
    ],
    ...patch,
  });
}

/** The default config of whichever algorithm an arm names. */
function withDefaults(suite: BenchmarkSuite): BenchmarkSuite {
  return benchmarkSuiteSchema.parse({
    ...suite,
    cases: suite.cases.map((benchmarkCase) => ({
      ...benchmarkCase,
      arms: benchmarkCase.arms.map((arm) => ({
        ...arm,
        config: arm.config ?? algorithmById(arm.algorithmId)!.manifest.defaultConfig,
      })),
    })),
  });
}

interface Harness {
  readonly runStorage: MemoryStorage;
  readonly benchmarkStorage: MemoryStorage;
}

const harness = (): Harness => ({
  runStorage: new MemoryStorage(),
  benchmarkStorage: new MemoryStorage(),
});

async function execute(
  suite: BenchmarkSuite,
  benchmarkId: string,
  options: {
    storage?: Harness;
    signal?: AbortSignal;
    onProgress?: (progress: BenchmarkProgress) => void;
    resolvePlugin?: (id: string) => ReturnType<typeof algorithmById>;
  } = {},
) {
  const storage = options.storage ?? harness();
  const execution = await runBenchmark({
    suite: withDefaults(suite),
    runStorage: storage.runStorage,
    benchmarkStorage: storage.benchmarkStorage,
    resolvePlugin: options.resolvePlugin ?? algorithmById,
    benchmarkId,
    applicationVersion: '0.0.0-test',
    sourceCommit: null,
    platform: 'test',
    now: () => new Date('2026-01-01T00:00:00.000Z'),
    // Fixed, so a manifest is byte-identical across reruns and host timing can
    // never make two engineering results differ.
    clock: () => 0,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
  });
  return { execution, storage };
}

/** What a run produced, reduced to the fields a comparison cares about. */
async function engineeringResults(storage: Harness, benchmarkId: string) {
  const manifest = JSON.parse(
    await storage.benchmarkStorage.readFile(benchmarkId, BENCHMARK_FILES.manifest),
  ) as { runs: { runId: string; caseId: string; seed: number; armId: string; status: string }[] };
  const summaries = await readRunSummaries(storage.runStorage, manifest as never);
  return manifest.runs
    .filter((run) => run.status === 'completed')
    .map((run) => {
      const summary = summaries.get(run.runId)!;
      return {
        key: `${run.caseId}|${String(run.seed)}|${run.armId}`,
        outcome: summary.acquisitionOutcome,
        retention: summary.lockRetentionRate.value,
        rms: summary.angularPointingError.postAcquisition.rms.value,
        falseLockEpisodes: summary.falseLockEpisodes,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
}

describe('executing a suite', () => {
  it('runs every case, seed and arm exactly once', async () => {
    const suite = tinySuite();
    const { execution } = await execute(suite, 'bench-basic');

    expect(execution.manifest.plannedRuns).toBe(totalRuns(withDefaults(suite)));
    expect(execution.manifest.runs).toHaveLength(4);
    expect(execution.manifest.status).toBe('completed');
    expect(new Set(execution.manifest.runs.map((run) => run.runId)).size).toBe(4);
  });

  it('records each run as a real experiment, recomputable on its own', async () => {
    // The benchmark layer adds nothing inside a run. Each one is an ordinary
    // Phase 5 experiment with the same artifacts, which is what keeps a
    // benchmark result auditable down to the raw telemetry.
    const { execution, storage } = await execute(tinySuite(), 'bench-artifacts');
    for (const run of execution.manifest.runs) {
      const manifest = JSON.parse(
        await storage.runStorage.readFile(run.runId, 'manifest.json'),
      ) as { status: string };
      expect(manifest.status).toBe('completed');
      await storage.runStorage.readFile(run.runId, 'summary.json');
      await storage.runStorage.readFile(run.runId, 'telemetry.csv');
      await storage.runStorage.readFile(run.runId, 'evaluation.csv');
    }
  });

  it('writes the suite, the manifest, the aggregate and the report', async () => {
    const { storage } = await execute(tinySuite(), 'bench-documents');
    for (const file of Object.values(BENCHMARK_FILES)) {
      const contents = await storage.benchmarkStorage.readFile('bench-documents', file);
      expect(contents.length).toBeGreaterThan(0);
    }
  });

  it('gives every arm of a case the same physical fingerprint', async () => {
    // The fairness claim, checked on real runs rather than on constructed
    // fingerprints: two algorithms, one world.
    const { execution } = await execute(tinySuite(), 'bench-fair');
    const bySeed = new Map<number, Set<string>>();
    for (const run of execution.manifest.runs) {
      const set = bySeed.get(run.seed) ?? new Set<string>();
      set.add(run.physicalFingerprint);
      bySeed.set(run.seed, set);
    }
    for (const [seed, fingerprints] of bySeed) {
      expect(fingerprints.size, `seed ${String(seed)}`).toBe(1);
    }
    // And different seeds are genuinely different worlds.
    expect(new Set(execution.manifest.runs.map((r) => r.physicalFingerprint)).size).toBe(2);
  });
});

describe('run isolation', () => {
  it('produces the same result whichever order the runs happen in', async () => {
    // The strongest statement about isolation available: reverse the schedule
    // and every individual engineering result must be untouched. A run that
    // leaked state — a reused engine, a shared RNG, an algorithm instance not
    // rebuilt — would show up here and nowhere else.
    const forwards = tinySuite();
    const backwards = benchmarkSuiteSchema.parse({
      ...forwards,
      cases: forwards.cases.map((benchmarkCase) => ({
        ...benchmarkCase,
        seeds: [...benchmarkCase.seeds].reverse(),
        arms: [...benchmarkCase.arms].reverse(),
      })),
    });

    const a = await execute(forwards, 'bench-order-a');
    const b = await execute(backwards, 'bench-order-b');

    expect(await engineeringResults(b.storage, 'bench-order-b')).toEqual(
      await engineeringResults(a.storage, 'bench-order-a'),
    );
  });

  it('produces the same result when the suite is run twice', async () => {
    const a = await execute(tinySuite(), 'bench-repeat-a');
    const b = await execute(tinySuite(), 'bench-repeat-b');

    expect(await engineeringResults(b.storage, 'bench-repeat-b')).toEqual(
      await engineeringResults(a.storage, 'bench-repeat-a'),
    );
    // Host timing is excluded from engineering identity on purpose: two
    // machines are not the same machine.
    expect(b.execution.manifest.suiteFingerprint).toBe(a.execution.manifest.suiteFingerprint);
  });
});

describe('failures', () => {
  it('records an unknown algorithm as a failed run and keeps going', async () => {
    const suite = benchmarkSuiteSchema.parse({
      ...tinySuite(),
      cases: [
        {
          ...tinySuite().cases[0]!,
          arms: [
            {
              armId: 'ghost',
              label: 'Not registered',
              algorithmId: 'no-such-algorithm',
              config: {},
            },
            {
              armId: 'baseline',
              label: 'Baseline KF + PID',
              algorithmId: 'baseline-kf-pid',
              config: DEFAULT_BASELINE_PAT_CONFIG,
            },
          ],
        },
      ],
    });

    const { execution } = await execute(suite, 'bench-unknown');
    const failed = execution.manifest.runs.filter((run) => run.status === 'failed');
    const completed = execution.manifest.runs.filter((run) => run.status === 'completed');

    expect(failed).toHaveLength(2);
    expect(failed[0]!.error).toContain('no-such-algorithm');
    // The other arm still ran: one bad arm does not destroy the suite.
    expect(completed).toHaveLength(2);
    expect(execution.manifest.status).toBe('completed');
  });

  it('records a configuration the algorithm refuses, rather than crashing', async () => {
    const base = tinySuite();
    const suite = benchmarkSuiteSchema.parse({
      ...base,
      cases: [
        {
          ...base.cases[0]!,
          seeds: [4001],
          arms: [
            {
              armId: 'nonsense',
              label: 'Impossible configuration',
              algorithmId: 'baseline-kf-pid',
              config: { detector: { threshold: 'not a number' } },
            },
          ],
        },
      ],
    });

    const { execution } = await execute(suite, 'bench-badconfig');
    expect(execution.manifest.runs[0]!.status).toBe('failed');
    expect(execution.manifest.runs[0]!.error).toContain('Invalid configuration');
  });

  it('counts failures in the aggregate instead of dropping them', async () => {
    const base = tinySuite();
    const suite = benchmarkSuiteSchema.parse({
      ...base,
      cases: [
        {
          ...base.cases[0]!,
          arms: [
            {
              armId: 'baseline',
              label: 'Baseline KF + PID',
              algorithmId: 'baseline-kf-pid',
              config: DEFAULT_BASELINE_PAT_CONFIG,
            },
            { armId: 'ghost', label: 'Missing', algorithmId: 'no-such-algorithm', config: {} },
          ],
        },
      ],
    });

    const { execution } = await execute(suite, 'bench-failcount');
    const ghost = execution.aggregate.cases[0]!.arms.find((arm) => arm.armId === 'ghost')!;

    expect(ghost.attempted).toBe(2);
    expect(ghost.completed).toBe(0);
    expect(ghost.failed).toBe(2);
    // A success rate over zero completed runs is not 100%; it is not a number.
    expect(ghost.successRate).toBeNull();
    expect(execution.aggregate.failed).toBe(2);
  });
});

describe('cancellation', () => {
  it('stops at the next boundary, keeps what completed, and says it is partial', async () => {
    const controller = new AbortController();
    let seen = 0;
    const { execution, storage } = await execute(tinySuite(), 'bench-cancel', {
      signal: controller.signal,
      onProgress: (progress) => {
        // Abort once the first run has finished, so there is both a completed
        // run to preserve and unstarted runs to leave alone.
        if (progress.completed >= 1) {
          seen = progress.completed;
          controller.abort();
        }
      },
    });

    expect(seen).toBeGreaterThanOrEqual(1);
    expect(execution.manifest.status).toBe('cancelled');

    const completed = execution.manifest.runs.filter((run) => run.status === 'completed');
    const cancelled = execution.manifest.runs.filter((run) => run.status === 'cancelled');
    expect(completed.length).toBeGreaterThanOrEqual(1);
    expect(cancelled.length).toBeGreaterThanOrEqual(1);
    // Every planned run is accounted for: nothing silently vanished.
    expect(execution.manifest.runs).toHaveLength(execution.manifest.plannedRuns);

    // The completed runs are still valid experiments.
    for (const run of completed) {
      const manifest = JSON.parse(
        await storage.runStorage.readFile(run.runId, 'manifest.json'),
      ) as { status: string };
      expect(manifest.status).toBe('completed');
    }

    // And the aggregate is honest about its sample size.
    expect(execution.aggregate.status).toBe('cancelled');
    expect(execution.aggregate.completed).toBe(completed.length);
    expect(execution.aggregate.cancelled).toBe(cancelled.length);
  });

  it('starts nothing at all when cancelled before the first run', async () => {
    const controller = new AbortController();
    controller.abort();
    const { execution, storage } = await execute(tinySuite(), 'bench-cancel-early', {
      signal: controller.signal,
    });

    expect(execution.manifest.status).toBe('cancelled');
    expect(execution.manifest.runs.every((run) => run.status === 'cancelled')).toBe(true);
    expect(await storage.runStorage.listRuns()).toHaveLength(0);
  });
});

describe('progress', () => {
  it('reports real counts that only ever move forwards', async () => {
    const updates: BenchmarkProgress[] = [];
    await execute(tinySuite(), 'bench-progress', {
      onProgress: (progress) => updates.push(progress),
    });

    expect(updates.length).toBeGreaterThan(0);
    const last = updates[updates.length - 1]!;
    expect(last.total).toBe(4);
    expect(last.completed).toBe(4);
    expect(last.remaining).toBe(0);

    let previous = 0;
    for (const update of updates) {
      expect(update.completed).toBeGreaterThanOrEqual(previous);
      previous = update.completed;
      // Every run is in exactly one bucket at every instant.
      expect(update.completed + update.failed + update.cancelled + update.remaining).toBe(
        update.total,
      );
    }
  });

  it('names what is executing while it executes', async () => {
    const current: string[] = [];
    await execute(tinySuite(), 'bench-progress-current', {
      onProgress: (progress) => {
        if (progress.current !== null) {
          current.push(
            `${progress.current.caseId}|${String(progress.current.seed)}|${progress.current.armId}`,
          );
        }
      },
    });
    expect(current).toEqual([
      'moving|4001|baseline',
      'moving|4001|astralock',
      'moving|4002|baseline',
      'moving|4002|astralock',
    ]);
  });
});

describe('recomputation', () => {
  it('rebuilds the stored aggregate from the artifacts with zero differences', async () => {
    const { storage } = await execute(tinySuite(), 'bench-recompute');
    const result = await recomputeBenchmark(
      storage.benchmarkStorage,
      storage.runStorage,
      'bench-recompute',
    );
    expect(result.differences).toEqual([]);
  });

  it('notices a tampered run summary', async () => {
    // The aggregate is a cache of what the runs say. Editing a run's summary
    // and leaving the aggregate alone must not go unnoticed.
    const { execution, storage } = await execute(tinySuite(), 'bench-tamper');
    const victim = execution.manifest.runs.find((run) => run.status === 'completed')!;
    const summary = JSON.parse(
      await storage.runStorage.readFile(victim.runId, 'summary.json'),
    ) as Record<string, unknown>;
    summary['lockRetentionRate'] = { value: 1, status: 'derived', unit: '1' };
    await storage.runStorage.writeAtomic(
      victim.runId,
      'summary.json',
      `${JSON.stringify(summary, null, 2)}\n`,
    );

    const result = await recomputeBenchmark(
      storage.benchmarkStorage,
      storage.runStorage,
      'bench-tamper',
    );
    expect(result.differences.length).toBeGreaterThan(0);
  });

  it('is a pure function of the records and the summaries', async () => {
    // Which is what makes the recomputation above meaningful: the same inputs
    // give the same document, so a difference is a difference in the data.
    const { execution, storage } = await execute(tinySuite(), 'bench-pure');
    const summaries = await readRunSummaries(storage.runStorage, execution.manifest);
    const inputs = {
      suite: withDefaults(tinySuite()),
      benchmarkId: execution.manifest.benchmarkId,
      suiteFingerprint: execution.manifest.suiteFingerprint,
      status: execution.manifest.status,
      plannedRuns: execution.manifest.plannedRuns,
      records: execution.manifest.runs,
      summaries,
    };
    expect(aggregateBenchmark(inputs)).toEqual(aggregateBenchmark(inputs));
  });
});
