/**
 * Recomputing a benchmark from what is on disk.
 *
 * The same rule Phase 5 applies to an experiment, one level up: the stored
 * aggregate is a *cache* of what the artifacts say, never the source of it.
 * `recomputeBenchmark` reads the manifest, reads each run's summary, rebuilds
 * the aggregate from scratch and compares it with the stored document. Zero
 * differences is the passing condition, and it is checked by test rather than
 * asserted in prose.
 *
 * Nothing here reruns a simulation. If a number could not be recovered from the
 * artifacts then the artifacts are missing something, and that is a defect in
 * what gets recorded rather than a reason to rerun.
 *
 * Tampering is caught twice over. Editing a run's `summary.json` changes the
 * recomputed aggregate and shows up here; editing the raw telemetry beneath it
 * is caught by the experiment's own `recomputeSummary`, which this does not
 * duplicate.
 */

import { readStoredSummary } from '@/core/experiments/recompute';
import type { ExperimentSummary } from '@/core/experiments/schema';
import type { ExperimentStorage } from '@/core/experiments/storage';

import { aggregateBenchmark, benchmarkAggregateSchema, type BenchmarkAggregate } from './aggregate';
import {
  BENCHMARK_FILES,
  benchmarkManifestSchema,
  benchmarkSuiteSchema,
  type BenchmarkManifest,
  type BenchmarkSuite,
} from './schema';

export interface StoredBenchmark {
  readonly manifest: BenchmarkManifest;
  readonly suite: BenchmarkSuite;
}

export async function readBenchmark(
  benchmarkStorage: ExperimentStorage,
  benchmarkId: string,
): Promise<StoredBenchmark> {
  const manifest = benchmarkManifestSchema.parse(
    JSON.parse(await benchmarkStorage.readFile(benchmarkId, BENCHMARK_FILES.manifest)),
  );
  const suite = benchmarkSuiteSchema.parse(
    JSON.parse(await benchmarkStorage.readFile(benchmarkId, BENCHMARK_FILES.suite)),
  );
  return { manifest, suite };
}

/**
 * The summaries of every completed run a manifest names.
 *
 * A completed run whose summary cannot be read is a corrupt directory, and the
 * error is allowed to escape: a benchmark computed over the runs that happened
 * to be readable would be a different benchmark from the one that was run.
 */
export async function readRunSummaries(
  runStorage: ExperimentStorage,
  manifest: BenchmarkManifest,
): Promise<Map<string, ExperimentSummary>> {
  const summaries = new Map<string, ExperimentSummary>();
  for (const record of manifest.runs) {
    if (record.status !== 'completed') continue;
    summaries.set(record.runId, await readStoredSummary(runStorage, record.runId));
  }
  return summaries;
}

/** Builds the aggregate for a stored benchmark, from its artifacts alone. */
export async function computeBenchmarkAggregate(
  benchmarkStorage: ExperimentStorage,
  runStorage: ExperimentStorage,
  benchmarkId: string,
): Promise<BenchmarkAggregate> {
  const { manifest, suite } = await readBenchmark(benchmarkStorage, benchmarkId);
  const summaries = await readRunSummaries(runStorage, manifest);
  return aggregateBenchmark({
    suite,
    benchmarkId: manifest.benchmarkId,
    suiteFingerprint: manifest.suiteFingerprint,
    status: manifest.status,
    plannedRuns: manifest.plannedRuns,
    records: manifest.runs,
    summaries,
  });
}

/** Writes the aggregate a benchmark's artifacts imply. */
export async function writeBenchmarkAggregate(
  benchmarkStorage: ExperimentStorage,
  runStorage: ExperimentStorage,
  benchmarkId: string,
): Promise<BenchmarkAggregate> {
  const aggregate = await computeBenchmarkAggregate(benchmarkStorage, runStorage, benchmarkId);
  await benchmarkStorage.writeAtomic(
    benchmarkId,
    BENCHMARK_FILES.aggregate,
    `${JSON.stringify(aggregate, null, 2)}\n`,
  );
  return aggregate;
}

/** One disagreement between the stored aggregate and the recomputed one. */
export interface AggregateDifference {
  readonly path: string;
  readonly stored: unknown;
  readonly recomputed: unknown;
}

export interface BenchmarkRecomputation {
  readonly stored: BenchmarkAggregate;
  readonly recomputed: BenchmarkAggregate;
  readonly differences: readonly AggregateDifference[];
}

/**
 * Recomputes and compares.
 *
 * The tolerance is relative, one part in 10^12. In practice the comparison is
 * exact — the same builder consumes the same summaries in the same order — but
 * a verification that failed over the last bit of a sum on some future platform
 * would be reporting noise rather than a discrepancy.
 */
export async function recomputeBenchmark(
  benchmarkStorage: ExperimentStorage,
  runStorage: ExperimentStorage,
  benchmarkId: string,
): Promise<BenchmarkRecomputation> {
  const stored = benchmarkAggregateSchema.parse(
    JSON.parse(await benchmarkStorage.readFile(benchmarkId, BENCHMARK_FILES.aggregate)),
  );
  const recomputed = await computeBenchmarkAggregate(benchmarkStorage, runStorage, benchmarkId);
  return { stored, recomputed, differences: compare(stored, recomputed) };
}

const RELATIVE_TOLERANCE = 1e-12;

function compare(stored: unknown, recomputed: unknown, path = ''): AggregateDifference[] {
  if (typeof stored === 'number' && typeof recomputed === 'number') {
    const scale = Math.max(Math.abs(stored), Math.abs(recomputed), 1);
    if (Math.abs(stored - recomputed) <= RELATIVE_TOLERANCE * scale) return [];
    return [{ path, stored, recomputed }];
  }

  if (Array.isArray(stored) && Array.isArray(recomputed)) {
    if (stored.length !== recomputed.length) {
      return [{ path: `${path}.length`, stored: stored.length, recomputed: recomputed.length }];
    }
    return stored.flatMap((entry, index) =>
      compare(entry, recomputed[index], `${path}[${String(index)}]`),
    );
  }

  if (
    stored !== null &&
    recomputed !== null &&
    typeof stored === 'object' &&
    typeof recomputed === 'object'
  ) {
    const a = stored as Record<string, unknown>;
    const b = recomputed as Record<string, unknown>;
    const keys = [...new Set([...Object.keys(a), ...Object.keys(b)])].sort();
    return keys.flatMap((key) => compare(a[key], b[key], path === '' ? key : `${path}.${key}`));
  }

  return Object.is(stored, recomputed) ? [] : [{ path, stored, recomputed }];
}
