/**
 * Running a benchmark suite, headlessly.
 *
 * No React, no DOM, no renderer. The runner constructs the same
 * `SimulationEngine`, `DynamicGimbal`, `VirtualCameraSensor`, disturbance
 * pipeline, `AlgorithmPlugin`, `ClosedLoopRuntime`, `ExperimentRecorder` and
 * metrics engine that Mission Control uses, because a benchmark whose numbers
 * came from a simplified benchmark simulator would be measuring the simplified
 * simulator.
 *
 * ## Isolation
 *
 * Every run gets its own everything: engine, mount, sensor, sampler, algorithm
 * instance, recorder, and RNG streams derived from the scenario seed. Nothing is
 * reused between runs and nothing is reset in place, so the order runs happen in
 * cannot change what any of them produces. `benchmark-order.test.ts` holds that
 * to the line by running the same suite forwards and backwards.
 *
 * ## Fairness
 *
 * The physics of a run comes from the case; only the algorithm and its
 * configuration come from the arm. The seed comes from the case's declared list
 * and is applied identically to every arm, so a case's arms are flown against
 * the same realization of every exogenous process — vibration, scintillation,
 * wander, sensor noise, dropouts, decoy motion. The arms diverge only where
 * their own commands move the mount, which is the thing being measured.
 *
 * ## Sequential, on purpose
 *
 * One run at a time. Wall-clock cost is real — a full suite is minutes — but
 * correctness came first and no measurement yet justifies the complexity of
 * workers. Throughput numbers live in docs/ASTRABENCH.md.
 */

import type { AlgorithmPlugin } from '@/core/contracts/algorithm-plugin';
import { parseSimulationConfig, type SimulationConfig } from '@/core/contracts/simulation';
import { fingerprint } from '@/core/experiments/fingerprint';
import { ExperimentRecorder } from '@/core/experiments/recorder';
import type { ExperimentStorage } from '@/core/experiments/storage';
import { ClosedLoopRuntime } from '@/core/runtime/closed-loop';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';
import { SimulationEngine } from '@/core/simulation/engine';
import { loadScenario } from '@/scenarios';

import type { BenchmarkAggregate } from './aggregate';
import { metricFingerprint, physicalFingerprint } from './fairness';
import { writeBenchmarkAggregate } from './recompute';
import { renderBenchmarkReport } from './report';
import {
  BENCHMARK_FILES,
  BENCHMARK_SCHEMA_VERSION,
  totalRuns,
  type BenchmarkArm,
  type BenchmarkCase,
  type BenchmarkManifest,
  type BenchmarkRunRecord,
  type BenchmarkSuite,
} from './schema';

/** Everything the runner needs that is not the suite itself. */
export interface BenchmarkRunnerOptions {
  readonly suite: BenchmarkSuite;
  /** Where the individual experiments go. They are ordinary runs. */
  readonly runStorage: ExperimentStorage;
  /** Where the benchmark's own documents go. A separate namespace. */
  readonly benchmarkStorage: ExperimentStorage;
  /** Resolves an algorithm id to a plugin. Injected so tests can register their own. */
  readonly resolvePlugin: (id: string) => AlgorithmPlugin<unknown, unknown> | undefined;
  readonly benchmarkId: string;
  readonly applicationVersion: string;
  readonly sourceCommit: string | null;
  readonly platform: string;
  /** Called after every state change, for the interface. */
  readonly onProgress?: (progress: BenchmarkProgress) => void;
  /** Stops the suite at the next run boundary. */
  readonly signal?: AbortSignal;
  /** Injected so a test can pin the timestamps. */
  readonly now?: () => Date;
  /** Wall clock, injected for the same reason. */
  readonly clock?: () => number;
}

/** What the interface shows while a suite is executing. Every number is real. */
export interface BenchmarkProgress {
  readonly benchmarkId: string;
  readonly total: number;
  readonly completed: number;
  readonly failed: number;
  readonly cancelled: number;
  /** Not yet attempted. */
  readonly remaining: number;
  /** What is executing right now, or `null` between runs. */
  readonly current: {
    readonly caseId: string;
    readonly seed: number;
    readonly armId: string;
    readonly algorithmId: string;
  } | null;
  /** Host milliseconds since the suite started. Never an engineering quantity. */
  readonly elapsedMs: number;
}

export interface BenchmarkExecution {
  readonly manifest: BenchmarkManifest;
  /** Computed from the artifacts after the last run, and stored beside them. */
  readonly aggregate: BenchmarkAggregate;
}

/** A benchmark run identifier: stable, sortable, and legal on every platform. */
export function benchmarkRunId(
  benchmarkId: string,
  benchmarkCase: BenchmarkCase,
  seed: number,
  arm: BenchmarkArm,
): string {
  const safe = (text: string): string => text.replace(/[^A-Za-z0-9_-]/g, '-');
  // The host allows 128 characters of `[A-Za-z0-9_-]`, so each part is bounded
  // rather than trusted to be short.
  return [
    'bench',
    safe(benchmarkId).slice(0, 32),
    safe(benchmarkCase.caseId).slice(0, 28),
    `s${String(seed)}`.slice(0, 16),
    safe(arm.armId).slice(0, 36),
  ].join('-');
}

/**
 * The scenario a case flies at a seed.
 *
 * The bundled scenario with its seed replaced and nothing else touched, so the
 * seed is the only thing that differs between the runs of one case. Re-parsed
 * rather than spread, because a configuration that has not been through the
 * schema is not a configuration.
 */
export function caseScenario(benchmarkCase: BenchmarkCase, seed: number): SimulationConfig {
  const base = loadScenario(benchmarkCase.scenarioId);
  return parseSimulationConfig({ ...base, seed });
}

/** Thrown when a suite names an algorithm the registry does not have. */
export class UnknownAlgorithmError extends Error {
  constructor(algorithmId: string) {
    super(`No algorithm registered with id "${algorithmId}"`);
    this.name = 'UnknownAlgorithmError';
  }
}

/**
 * Executes a suite, writing a real experiment per run and a manifest as it goes.
 *
 * The manifest is rewritten after **every** run rather than once at the end. A
 * process that dies mid-suite therefore leaves a directory that says exactly
 * how far it got, and the runs it completed stay valid results — which is the
 * same rule Phase 5 applies to an interrupted experiment.
 */
export async function runBenchmark(options: BenchmarkRunnerOptions): Promise<BenchmarkExecution> {
  const { suite, signal } = options;
  const now = options.now ?? (() => new Date());
  const clock = options.clock ?? (() => Date.now());

  const startedAt = now();
  const startedAtMs = clock();
  const planned = totalRuns(suite);
  const records: BenchmarkRunRecord[] = [];
  const metric = metricFingerprint(suite.metricsConfig);

  let completed = 0;
  let failed = 0;
  let cancelled = 0;

  const manifestOf = (status: BenchmarkManifest['status']): BenchmarkManifest => ({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    benchmarkId: options.benchmarkId,
    suiteId: suite.suiteId,
    suiteName: suite.name,
    suiteFingerprint: suiteFingerprint(suite),
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: status === 'running' ? null : now().toISOString(),
    plannedRuns: planned,
    runs: [...records],
    applicationVersion: options.applicationVersion,
    sourceCommit: options.sourceCommit,
    platform: options.platform,
  });

  const writeManifest = async (status: BenchmarkManifest['status']): Promise<void> => {
    await options.benchmarkStorage.writeAtomic(
      options.benchmarkId,
      BENCHMARK_FILES.manifest,
      `${JSON.stringify(manifestOf(status), null, 2)}\n`,
    );
  };

  const report = (current: BenchmarkProgress['current']): void => {
    options.onProgress?.({
      benchmarkId: options.benchmarkId,
      total: planned,
      completed,
      failed,
      cancelled,
      remaining: planned - completed - failed - cancelled,
      current,
      elapsedMs: clock() - startedAtMs,
    });
  };

  await options.benchmarkStorage.createRun(options.benchmarkId);
  await options.benchmarkStorage.writeAtomic(
    options.benchmarkId,
    BENCHMARK_FILES.suite,
    `${JSON.stringify(suite, null, 2)}\n`,
  );
  await writeManifest('running');
  report(null);

  let stopped = false;

  for (const benchmarkCase of suite.cases) {
    for (const seed of benchmarkCase.seeds) {
      for (const arm of benchmarkCase.arms) {
        const runId = benchmarkRunId(options.benchmarkId, benchmarkCase, seed, arm);
        const scenario = caseScenario(benchmarkCase, seed);
        const physical = physicalFingerprint(scenario);

        if (stopped || signal?.aborted === true) {
          // Cancelled before it started. Recorded rather than omitted: a suite
          // that silently shrank would report the success rate of the part that
          // was allowed to run.
          stopped = true;
          cancelled += 1;
          records.push({
            caseId: benchmarkCase.caseId,
            seed,
            armId: arm.armId,
            algorithmId: arm.algorithmId,
            algorithmVersion: options.resolvePlugin(arm.algorithmId)?.manifest.version ?? 'unknown',
            runId,
            status: 'cancelled',
            error: null,
            physicalFingerprint: physical,
            metricFingerprint: metric,
            hostDurationMs: 0,
          });
          report(null);
          continue;
        }

        report({
          caseId: benchmarkCase.caseId,
          seed,
          armId: arm.armId,
          algorithmId: arm.algorithmId,
        });

        const runStartedMs = clock();
        const outcome = await executeRun({
          options,
          suite,
          benchmarkCase,
          seed,
          arm,
          runId,
          scenario,
          now,
        });
        const hostDurationMs = clock() - runStartedMs;

        if (outcome.status === 'completed') completed += 1;
        else if (outcome.status === 'cancelled') {
          cancelled += 1;
          stopped = true;
        } else failed += 1;

        records.push({
          caseId: benchmarkCase.caseId,
          seed,
          armId: arm.armId,
          algorithmId: arm.algorithmId,
          algorithmVersion: outcome.algorithmVersion,
          runId,
          status: outcome.status,
          error: outcome.error,
          physicalFingerprint: physical,
          metricFingerprint: metric,
          hostDurationMs,
        });

        await writeManifest('running');
        report(null);
      }
    }
  }

  const status: BenchmarkManifest['status'] = stopped
    ? 'cancelled'
    : completed === 0 && planned > 0
      ? 'failed'
      : 'completed';
  await writeManifest(status);

  // The aggregate and the report are written from the artifacts, not from
  // anything held in memory during the run. That is what makes
  // `recomputeBenchmark` able to check them later: it does the same read, and
  // if the two disagree the stored document is wrong.
  const aggregate = await writeBenchmarkAggregate(
    options.benchmarkStorage,
    options.runStorage,
    options.benchmarkId,
  );
  await options.benchmarkStorage.writeAtomic(
    options.benchmarkId,
    BENCHMARK_FILES.report,
    renderBenchmarkReport(aggregate, manifestOf(status)),
  );

  report(null);
  return { manifest: manifestOf(status), aggregate };
}

interface RunOutcome {
  readonly status: BenchmarkRunRecord['status'];
  readonly error: string | null;
  readonly algorithmVersion: string;
}

/**
 * One run: build everything fresh, fly it, record it, finalise it.
 *
 * A failure here is caught and returned rather than thrown, so one bad run in a
 * hundred does not destroy the other ninety-nine. The recorder is told about the
 * failure too, so the run directory says what happened rather than looking
 * merely unfinished.
 */
async function executeRun(context: {
  options: BenchmarkRunnerOptions;
  suite: BenchmarkSuite;
  benchmarkCase: BenchmarkCase;
  seed: number;
  arm: BenchmarkArm;
  runId: string;
  scenario: SimulationConfig;
  now: () => Date;
}): Promise<RunOutcome> {
  const { options, suite, benchmarkCase, arm, runId, scenario } = context;
  const plugin = options.resolvePlugin(arm.algorithmId);
  if (plugin === undefined) {
    return {
      status: 'failed',
      error: new UnknownAlgorithmError(arm.algorithmId).message,
      algorithmVersion: 'unknown',
    };
  }

  // Validated against the plugin's own schema, so a suite cannot smuggle a
  // configuration the algorithm never agreed to accept.
  let algorithmConfig: unknown;
  try {
    algorithmConfig = plugin.manifest.configSchema.parse(arm.config);
  } catch (error) {
    return {
      status: 'failed',
      error: `Invalid configuration for ${arm.algorithmId}: ${describe(error)}`,
      algorithmVersion: plugin.manifest.version,
    };
  }

  const engine = new SimulationEngine(scenario);
  const sensor = new VirtualCameraSensor({ config: engine.config });
  const sampler = new ExactWorldSampler(engine);
  const recorder = new ExperimentRecorder({
    storage: options.runStorage,
    engine,
    config: engine.config,
    scenarioId: benchmarkCase.scenarioId,
    algorithmId: plugin.manifest.id,
    algorithmVersion: plugin.manifest.version,
    algorithmConfig,
    metricsConfig: suite.metricsConfig,
    sampler,
    applicationVersion: options.applicationVersion,
    sourceCommit: options.sourceCommit,
    platform: options.platform,
    runId,
    now: context.now,
  });

  const runtime = new ClosedLoopRuntime({
    engine,
    sensor,
    sampler,
    plugin,
    config: algorithmConfig,
    // Bounded: a benchmark keeps no frame history, and a hundred runs holding
    // their own would be a hundred times whatever the default is.
    historyLimit: 1,
    observer: recorder,
  });

  try {
    await recorder.start({ autonomyActive: true });

    const ticks = Math.round(benchmarkCase.durationSeconds * (engine.config.tickRate as number));
    // Cancellation is checked between chunks rather than every tick: a tick is
    // microseconds and a signal check per tick would cost more than it saves,
    // while a chunk is a few milliseconds and bounds how long a cancel waits.
    const chunk = Math.max(1, Math.round(engine.config.tickRate));
    for (let tick = 0; tick < ticks; tick += chunk) {
      if (options.signal?.aborted === true) {
        await recorder.abort('operator-aborted');
        return { status: 'cancelled', error: null, algorithmVersion: plugin.manifest.version };
      }
      const step = Math.min(chunk, ticks - tick);
      for (let i = 0; i < step; i += 1) runtime.step(1);
      if (recorder.backpressured) await recorder.drain();
    }

    await recorder.complete('scenario-duration-reached');
    return { status: 'completed', error: null, algorithmVersion: plugin.manifest.version };
  } catch (error) {
    const message = describe(error);
    await recorder.fail(message).catch(() => undefined);
    return { status: 'failed', error: message, algorithmVersion: plugin.manifest.version };
  } finally {
    runtime.dispose();
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Identity of a suite document, so a rerun can be matched to the original. */
export function suiteFingerprint(suite: BenchmarkSuite): string {
  return `suite:${fingerprint(suite)}`;
}
