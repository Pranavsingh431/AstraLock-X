/**
 * Turning completed runs into numbers, without losing the runs that failed.
 *
 * The temptation in a benchmark aggregator is to compute a mean over whatever
 * succeeded and print it. That produces a report in which every algorithm
 * acquires 100% of the time, because a run that never acquired contributed no
 * acquisition time to average. So the shape here is deliberate:
 *
 * - **Counts come first.** Attempted, completed, failed, cancelled, acquired.
 *   A rate is meaningless without the denominator beside it.
 * - **Distributions are kept, not just summarised.** Every per-run value that
 *   fed a median is stored, so a reader can see that a "median" came from three
 *   samples, or that one seed is carrying the result.
 * - **Absence is a value.** A run that did not acquire has no acquisition time,
 *   and that is recorded as a non-sample rather than as a zero. The count of
 *   non-samples travels with the statistic.
 * - **Pairs are compared as pairs.** Every arm of a case flies the same seeds
 *   against the same physics, so the honest comparison is per-seed differences,
 *   not the difference of two unrelated averages.
 *
 * There is no composite score and no winner badge. Metric-specific results, and
 * a count of how many seeds each arm was better on, are what an engineering
 * comparison can support.
 */

import { z } from 'zod';

import type { ExperimentSummary } from '@/core/experiments/schema';

import { validateComparison, type ComparisonValidity } from './fairness';
import {
  benchmarkStatusSchema,
  successCriterionFor,
  type BenchmarkCase,
  type BenchmarkRunRecord,
  type BenchmarkStatus,
  type BenchmarkSuite,
  type SuccessCriterion,
} from './schema';

// --- Distributions ----------------------------------------------------------

/**
 * A metric across the runs of one arm.
 *
 * `values` is the raw sample, in seed order, and everything else is derived
 * from it. `missing` counts the completed runs for which the metric was not
 * defined — a pointing error with no acquisition, a reacquisition time with no
 * loss — which is the number that stops a median from flattering an arm that
 * mostly failed.
 */
export const distributionSchema = z.strictObject({
  values: z.array(z.number()),
  missing: z.number().int().nonnegative(),
  count: z.number().int().nonnegative(),
  mean: z.number().nullable(),
  median: z.number().nullable(),
  p95: z.number().nullable(),
  min: z.number().nullable(),
  max: z.number().nullable(),
});
export type Distribution = z.infer<typeof distributionSchema>;

const EMPTY: Distribution = {
  values: [],
  missing: 0,
  count: 0,
  mean: null,
  median: null,
  p95: null,
  min: null,
  max: null,
};

/**
 * Linear-interpolated percentile on the sorted sample.
 *
 * The same definition the experiment metrics use, so a benchmark's P95 and a
 * run report's P95 mean the same thing.
 */
function percentile(sorted: readonly number[], fraction: number): number {
  const position = fraction * (sorted.length - 1);
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (position - lower) * (sorted[upper]! - sorted[lower]!);
}

export function distribution(samples: readonly (number | null)[]): Distribution {
  const values = samples.filter((value): value is number => value !== null);
  const missing = samples.length - values.length;
  if (values.length === 0) return { ...EMPTY, missing };

  const sorted = [...values].sort((a, b) => a - b);
  return {
    values,
    missing,
    count: values.length,
    mean: values.reduce((sum, value) => sum + value, 0) / values.length,
    median: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
  };
}

// --- Which metrics a benchmark reports ---------------------------------------

/**
 * The metrics compared across arms, and how each is read off a run summary.
 *
 * `lowerIsBetter` exists so a paired comparison can say which arm won a seed
 * without anyone having to remember whether more retention is good. It is not
 * used to combine metrics into a score, because they do not combine.
 */
export interface BenchmarkMetricDefinition {
  readonly key: string;
  readonly label: string;
  readonly unit: string;
  readonly lowerIsBetter: boolean;
  readonly read: (summary: ExperimentSummary) => number | null;
}

export const BENCHMARK_METRICS: readonly BenchmarkMetricDefinition[] = [
  {
    key: 'acquisitionTimeS',
    label: 'Coarse acquisition time',
    unit: 's',
    lowerIsBetter: true,
    read: (s) => s.coarseAcquisitionTime.value,
  },
  {
    key: 'rmsPointingErrorUrad',
    label: 'RMS pointing error (post-acquisition)',
    unit: 'µrad',
    lowerIsBetter: true,
    read: (s) =>
      s.angularPointingError.postAcquisition.rms.value === null
        ? null
        : s.angularPointingError.postAcquisition.rms.value * 1e6,
  },
  {
    key: 'p95PointingErrorUrad',
    label: 'P95 pointing error (post-acquisition)',
    unit: 'µrad',
    lowerIsBetter: true,
    read: (s) =>
      s.angularPointingError.postAcquisition.p95.value === null
        ? null
        : s.angularPointingError.postAcquisition.p95.value * 1e6,
  },
  {
    key: 'lockRetentionRate',
    label: 'Lock retention',
    unit: '1',
    lowerIsBetter: false,
    read: (s) => s.lockRetentionRate.value,
  },
  {
    key: 'reacquisitionTimeS',
    label: 'Reacquisition time (recovered episodes)',
    unit: 's',
    lowerIsBetter: true,
    read: (s) => s.reacquisitionTime.mean.value,
  },
  {
    key: 'falseLockSeconds',
    label: 'False-lock duration',
    unit: 's',
    lowerIsBetter: true,
    read: (s) => s.falseLockDurationSeconds.value,
  },
];

// --- Success ----------------------------------------------------------------

/** Whether one completed run met the suite's declared bar. */
export function runSucceeded(summary: ExperimentSummary, criterion: SuccessCriterion): boolean {
  const acquired = summary.acquisitionOutcome === 'acquired';
  switch (criterion.kind) {
    case 'acquired':
      return acquired;
    case 'retention-at-least':
      return acquired && (summary.lockRetentionRate.value ?? 0) >= criterion.threshold;
    case 'handoff-ready':
      return acquired && (summary.handoff?.episodes ?? 0) > 0;
    case 'retention-without-false-lock':
      return (
        acquired &&
        (summary.lockRetentionRate.value ?? 0) >= criterion.threshold &&
        summary.falseLockEpisodes === 0
      );
  }
}

// --- Aggregates -------------------------------------------------------------

export const armAggregateSchema = z.strictObject({
  armId: z.string(),
  label: z.string(),
  algorithmId: z.string(),
  algorithmVersion: z.string(),
  attempted: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  /** Completed runs whose evaluator outcome was `acquired`. */
  acquired: z.number().int().nonnegative(),
  /** Completed runs meeting the declared success criterion. */
  succeeded: z.number().int().nonnegative(),
  /** `succeeded / completed`, or `null` when nothing completed. */
  successRate: z.number().nullable(),
  /** Completed runs that never recovered a lost lock. */
  unrecoveredLossRuns: z.number().int().nonnegative(),
  /** Completed runs with at least one false lock. */
  falseLockRuns: z.number().int().nonnegative(),
  /** Completed runs that reached handoff readiness. */
  handoffReadyRuns: z.number().int().nonnegative(),
  metrics: z.record(z.string(), distributionSchema),
});
export type ArmAggregate = z.infer<typeof armAggregateSchema>;

/** One seed, one metric, two arms: which was better and by how much. */
export const pairedDifferenceSchema = z.strictObject({
  seed: z.number().int(),
  baseline: z.number().nullable(),
  candidate: z.number().nullable(),
  /** `candidate - baseline`, or `null` when either side is absent. */
  delta: z.number().nullable(),
  /** Which arm was better on this seed, or `null` when it cannot be said. */
  better: z.enum(['baseline', 'candidate', 'tie']).nullable(),
});
export type PairedDifference = z.infer<typeof pairedDifferenceSchema>;

export const pairedComparisonSchema = z.strictObject({
  metricKey: z.string(),
  metricLabel: z.string(),
  unit: z.string(),
  lowerIsBetter: z.boolean(),
  baselineArmId: z.string(),
  candidateArmId: z.string(),
  differences: z.array(pairedDifferenceSchema),
  /** Seeds on which each arm was better, and seeds where it could not be said. */
  candidateBetter: z.number().int().nonnegative(),
  baselineBetter: z.number().int().nonnegative(),
  ties: z.number().int().nonnegative(),
  undecided: z.number().int().nonnegative(),
});
export type PairedComparison = z.infer<typeof pairedComparisonSchema>;

export const caseAggregateSchema = z.strictObject({
  caseId: z.string(),
  label: z.string(),
  scenarioId: z.string(),
  seeds: z.array(z.number().int()),
  successCriterion: z.string(),
  /** Whether this case's arms may be compared at all. */
  comparison: z.strictObject({
    valid: z.boolean(),
    reason: z.string().nullable(),
    detail: z.string().nullable(),
  }),
  arms: z.array(armAggregateSchema),
  /** Every arm after the first, each paired against the first. */
  paired: z.array(pairedComparisonSchema),
});
export type CaseAggregate = z.infer<typeof caseAggregateSchema>;

export const benchmarkAggregateSchema = z.strictObject({
  schemaVersion: z.literal(1),
  benchmarkId: z.string(),
  suiteId: z.string(),
  suiteName: z.string(),
  suiteFingerprint: z.string(),
  /** Reflects the manifest: a partial suite says so here. */
  status: benchmarkStatusSchema,
  plannedRuns: z.number().int().nonnegative(),
  attempted: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  cases: z.array(caseAggregateSchema),
});
export type BenchmarkAggregate = z.infer<typeof benchmarkAggregateSchema>;

/** Human wording for a success criterion, for the report and the table header. */
export function describeSuccess(criterion: SuccessCriterion): string {
  switch (criterion.kind) {
    case 'acquired':
      return 'coarse lock acquired';
    case 'retention-at-least':
      return `acquired and retention ≥ ${criterion.threshold.toFixed(2)}`;
    case 'handoff-ready':
      return 'acquired and handoff-ready at least once';
    case 'retention-without-false-lock':
      return `acquired, retention ≥ ${criterion.threshold.toFixed(2)}, no false lock`;
  }
}

/** A completed run and the summary it produced. */
export interface CompletedRun {
  readonly record: BenchmarkRunRecord;
  readonly summary: ExperimentSummary;
}

/**
 * Builds the aggregate from the manifest's records and the summaries on disk.
 *
 * Pure: given the same records and summaries it produces the same document,
 * which is what makes `recomputeBenchmark` able to check a stored aggregate
 * against a freshly computed one.
 */
export function aggregateBenchmark(input: {
  readonly suite: BenchmarkSuite;
  readonly benchmarkId: string;
  readonly suiteFingerprint: string;
  readonly status: BenchmarkStatus;
  readonly plannedRuns: number;
  readonly records: readonly BenchmarkRunRecord[];
  readonly summaries: ReadonlyMap<string, ExperimentSummary>;
}): BenchmarkAggregate {
  const cases = input.suite.cases.map((benchmarkCase) =>
    aggregateCase(input.suite, benchmarkCase, input.records, input.summaries),
  );

  return {
    schemaVersion: 1,
    benchmarkId: input.benchmarkId,
    suiteId: input.suite.suiteId,
    suiteName: input.suite.name,
    suiteFingerprint: input.suiteFingerprint,
    status: input.status,
    plannedRuns: input.plannedRuns,
    attempted: input.records.length,
    completed: input.records.filter((r) => r.status === 'completed').length,
    failed: input.records.filter((r) => r.status === 'failed').length,
    cancelled: input.records.filter((r) => r.status === 'cancelled').length,
    cases,
  };
}

function aggregateCase(
  suite: BenchmarkSuite,
  benchmarkCase: BenchmarkCase,
  records: readonly BenchmarkRunRecord[],
  summaries: ReadonlyMap<string, ExperimentSummary>,
): CaseAggregate {
  const criterion = successCriterionFor(suite, benchmarkCase);
  const mine = records.filter((record) => record.caseId === benchmarkCase.caseId);

  const arms = benchmarkCase.arms.map((arm) =>
    aggregateArm(benchmarkCase, arm.armId, arm.label, mine, summaries, criterion),
  );

  // Only completed runs can be compared; a cancelled one has no physics to
  // disagree about because it never flew.
  const completed = mine.filter((record) => record.status === 'completed');
  const validity: ComparisonValidity = validateComparison(completed);

  const paired =
    validity.valid && benchmarkCase.arms.length > 1 ? pairArms(benchmarkCase, mine, summaries) : [];

  return {
    caseId: benchmarkCase.caseId,
    label: benchmarkCase.label,
    scenarioId: benchmarkCase.scenarioId,
    seeds: [...benchmarkCase.seeds],
    successCriterion: describeSuccess(criterion),
    comparison: { valid: validity.valid, reason: validity.reason, detail: validity.detail },
    arms,
    paired,
  };
}

function aggregateArm(
  benchmarkCase: BenchmarkCase,
  armId: string,
  label: string,
  records: readonly BenchmarkRunRecord[],
  summaries: ReadonlyMap<string, ExperimentSummary>,
  criterion: SuccessCriterion,
): ArmAggregate {
  const mine = records.filter((record) => record.armId === armId);
  const completedRecords = mine.filter((record) => record.status === 'completed');
  const completedSummaries = completedRecords
    .map((record) => summaries.get(record.runId))
    .filter((summary): summary is ExperimentSummary => summary !== undefined);

  // In seed order, so a distribution reads against the case's seed list and
  // lines up with the paired comparison below.
  //
  // Only completed runs are sampled. A run that failed or was cancelled is not
  // a missing measurement — it is not a measurement — and it is counted under
  // `failed` and `cancelled`, where it stays visible. Within the completed
  // runs, a metric that is undefined (no acquisition, so no pointing error) is
  // a genuine missing sample and is counted as one.
  const inSeedOrder = benchmarkCase.seeds
    .map((seed) => completedRecords.find((record) => record.seed === seed))
    .filter((record): record is BenchmarkRunRecord => record !== undefined);

  const metrics: Record<string, Distribution> = {};
  for (const metric of BENCHMARK_METRICS) {
    metrics[metric.key] = distribution(
      inSeedOrder.map((record) => {
        const summary = summaries.get(record.runId);
        return summary === undefined ? null : metric.read(summary);
      }),
    );
  }

  return {
    armId,
    label,
    algorithmId: mine[0]?.algorithmId ?? 'unknown',
    algorithmVersion: mine[0]?.algorithmVersion ?? 'unknown',
    attempted: mine.length,
    completed: completedRecords.length,
    failed: mine.filter((record) => record.status === 'failed').length,
    cancelled: mine.filter((record) => record.status === 'cancelled').length,
    acquired: completedSummaries.filter((s) => s.acquisitionOutcome === 'acquired').length,
    succeeded: completedSummaries.filter((s) => runSucceeded(s, criterion)).length,
    successRate:
      completedRecords.length === 0
        ? null
        : completedSummaries.filter((s) => runSucceeded(s, criterion)).length /
          completedRecords.length,
    unrecoveredLossRuns: completedSummaries.filter((s) => s.unrecoveredLosses > 0).length,
    falseLockRuns: completedSummaries.filter((s) => s.falseLockEpisodes > 0).length,
    handoffReadyRuns: completedSummaries.filter((s) => (s.handoff?.episodes ?? 0) > 0).length,
    metrics,
  };
}

/**
 * Pairs every arm against the first one, seed by seed.
 *
 * The first arm is the reference by convention, and a suite states its
 * reference by putting it first. Pairing is what the shared seed buys: both
 * arms met the same vibration, the same noise realization and the same decoy,
 * so a difference is attributable to the algorithm in a way that a difference
 * of averages over unrelated runs never is.
 */
function pairArms(
  benchmarkCase: BenchmarkCase,
  records: readonly BenchmarkRunRecord[],
  summaries: ReadonlyMap<string, ExperimentSummary>,
): PairedComparison[] {
  const [reference, ...others] = benchmarkCase.arms;
  if (reference === undefined) return [];

  const valueFor = (
    armId: string,
    seed: number,
    metric: BenchmarkMetricDefinition,
  ): number | null => {
    const record = records.find(
      (r) => r.armId === armId && r.seed === seed && r.status === 'completed',
    );
    const summary = record === undefined ? undefined : summaries.get(record.runId);
    return summary === undefined ? null : metric.read(summary);
  };

  const comparisons: PairedComparison[] = [];
  for (const arm of others) {
    for (const metric of BENCHMARK_METRICS) {
      const differences: PairedDifference[] = benchmarkCase.seeds.map((seed) => {
        const baseline = valueFor(reference.armId, seed, metric);
        const candidate = valueFor(arm.armId, seed, metric);
        // A delta with one side missing is not a small delta, it is no delta.
        // Reported as null so nothing downstream can average it as zero.
        const delta = baseline === null || candidate === null ? null : candidate - baseline;
        const better =
          delta === null
            ? null
            : delta === 0
              ? ('tie' as const)
              : delta < 0 === metric.lowerIsBetter
                ? ('candidate' as const)
                : ('baseline' as const);
        return { seed, baseline, candidate, delta, better };
      });

      comparisons.push({
        metricKey: metric.key,
        metricLabel: metric.label,
        unit: metric.unit,
        lowerIsBetter: metric.lowerIsBetter,
        baselineArmId: reference.armId,
        candidateArmId: arm.armId,
        differences,
        candidateBetter: differences.filter((d) => d.better === 'candidate').length,
        baselineBetter: differences.filter((d) => d.better === 'baseline').length,
        ties: differences.filter((d) => d.better === 'tie').length,
        undecided: differences.filter((d) => d.better === null).length,
      });
    }
  }
  return comparisons;
}
