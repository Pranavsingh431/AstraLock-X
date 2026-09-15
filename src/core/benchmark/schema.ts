/**
 * What a benchmark is, as data.
 *
 * AstraBench compares algorithms by running them against identical physics and
 * scoring the results with the same evaluator. Everything that makes such a
 * comparison meaningful — which scenarios, which seeds, which algorithm
 * configurations, and what counts as success — is written down here before
 * anything runs, and persisted beside the results. A benchmark whose definition
 * could be adjusted after seeing the numbers would not be a benchmark.
 *
 * ## Why this is versioned separately from experiments
 *
 * A benchmark *run* is an ordinary Phase 5 experiment: the same recorder, the
 * same raw artifacts, the same summary, recomputable the same way. AstraBench
 * adds a layer above that and nothing inside it. So the benchmark schema has
 * its own version and the experiment schema keeps its own, and a change here
 * cannot invalidate a stored run — which is the property that lets Phase 5, 6,
 * 7 and 8 fixtures keep loading untouched.
 *
 * ## The shape
 *
 * ```
 *   BenchmarkSuite
 *     └─ BenchmarkCase        physical scenario + seeds + success rule
 *          └─ BenchmarkArm    algorithm id + its configuration
 *
 *   one run = case x seed x arm
 * ```
 *
 * The nesting is the fairness rule made structural. Physics belongs to the
 * *case*, so every arm of a case necessarily gets the same world; an arm may
 * choose only its algorithm and that algorithm's settings. There is deliberately
 * no field on an arm through which a scenario, a seed or a disturbance could be
 * varied — see docs/ASTRABENCH.md.
 */

import { z } from 'zod';

import { metricsConfigSchema } from '@/core/experiments/schema';
import { SCENARIO_IDS } from '@/scenarios';

/**
 * Version of the benchmark artifact format.
 *
 * - **1** — Phase 9: suites, cases, arms, fairness fingerprints, aggregates.
 */
export const BENCHMARK_SCHEMA_VERSION = 1;

export const scenarioIdSchema = z.enum(SCENARIO_IDS);
/** A scenario a case may fly: one of the bundled ids. */
export type ScenarioIdInSuite = z.infer<typeof scenarioIdSchema>;

// --- Success criteria -------------------------------------------------------

/**
 * When a single run counts as a success.
 *
 * Declared in the suite, before execution, because a success rate chosen after
 * seeing the results is not a measurement. Each variant names the evaluator
 * quantity it reads, so a reader of a report never has to guess what "83%"
 * meant.
 */
export const successCriterionSchema = z.discriminatedUnion('kind', [
  /** The evaluator confirmed a coarse lock at some point in the run. */
  z.strictObject({ kind: z.literal('acquired') }),
  /** Acquired, and held for at least this fraction of the trackable window. */
  z.strictObject({
    kind: z.literal('retention-at-least'),
    threshold: z.number().min(0).max(1),
  }),
  /** Acquired, and reached handoff readiness at least once. */
  z.strictObject({ kind: z.literal('handoff-ready') }),
  /** Acquired, held to a retention floor, and never locked a wrong source. */
  z.strictObject({
    kind: z.literal('retention-without-false-lock'),
    threshold: z.number().min(0).max(1),
  }),
]);
export type SuccessCriterion = z.infer<typeof successCriterionSchema>;

// --- Suite definition -------------------------------------------------------

/**
 * One algorithm under test, with the configuration it is tested under.
 *
 * `config` is `unknown` here and validated against the plugin's own schema when
 * the run is built: the registry is heterogeneous, and a benchmark that hard-
 * coded one algorithm's config type could not compare two.
 *
 * **Physics may not appear in an arm.** There is no scenario field, no seed
 * field and no disturbance field, so the only way to make two arms physically
 * different is to put them in different cases — where the difference is visible.
 */
export const benchmarkArmSchema = z.strictObject({
  /** Stable label for this arm within its case, e.g. `astralock-x-identity-on`. */
  armId: z.string().min(1),
  label: z.string().min(1),
  algorithmId: z.string().min(1),
  /** The plugin's own configuration. Validated against its schema at run time. */
  config: z.unknown(),
});
export type BenchmarkArm = z.infer<typeof benchmarkArmSchema>;

/**
 * One physical situation, run at several seeds, by several algorithms.
 *
 * Seeds are explicit and stored. A benchmark that generated them at execution
 * time could not be repeated and could not be audited, so `seeds` is part of
 * the suite document and a generator, if one is ever offered, must write its
 * output here before the first run starts.
 */
export const benchmarkCaseSchema = z.strictObject({
  caseId: z.string().min(1),
  label: z.string().min(1),
  description: z.string(),
  /** The bundled scenario this case flies. */
  scenarioId: scenarioIdSchema,
  /** Seconds of simulated time per run. */
  durationSeconds: z.number().positive().max(3600),
  /** Explicit, ordered, stored. Never generated at execution time. */
  seeds: z.array(z.number().int().min(0)).min(1),
  arms: z.array(benchmarkArmSchema).min(1),
  /** Overrides the suite default when this case needs a different bar. */
  success: successCriterionSchema.nullable().default(null),
});
export type BenchmarkCase = z.infer<typeof benchmarkCaseSchema>;

export const benchmarkSuiteSchema = z.strictObject({
  schemaVersion: z.literal(BENCHMARK_SCHEMA_VERSION),
  suiteId: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  /**
   * The metric definitions every run in this suite is scored under.
   *
   * One per suite, not one per arm: two arms scored under different thresholds
   * are not comparable, and §7 of the phase specification makes that an
   * invalidating condition rather than a footnote.
   */
  metricsConfig: metricsConfigSchema,
  /** Applied to any case that does not override it. */
  defaultSuccess: successCriterionSchema,
  cases: z.array(benchmarkCaseSchema).min(1),
});
export type BenchmarkSuite = z.infer<typeof benchmarkSuiteSchema>;

/** Total runs a suite will execute: sum over cases of seeds x arms. */
export function totalRuns(suite: BenchmarkSuite): number {
  return suite.cases.reduce((sum, c) => sum + c.seeds.length * c.arms.length, 0);
}

/** The success rule in force for a case. */
export function successCriterionFor(
  suite: BenchmarkSuite,
  benchmarkCase: BenchmarkCase,
): SuccessCriterion {
  return benchmarkCase.success ?? suite.defaultSuccess;
}

// --- Run records ------------------------------------------------------------

/**
 * How one run ended.
 *
 * Three outcomes and all three are kept. A suite that silently dropped its
 * failures would report the success rate of the runs that succeeded, which is
 * always 100%.
 */
export const benchmarkRunStatusSchema = z.enum(['completed', 'failed', 'cancelled']);
export type BenchmarkRunStatus = z.infer<typeof benchmarkRunStatusSchema>;

export const benchmarkRunRecordSchema = z.strictObject({
  /** Identifies the run within the suite: case, seed and arm. */
  caseId: z.string().min(1),
  seed: z.number().int().min(0),
  armId: z.string().min(1),
  algorithmId: z.string().min(1),
  algorithmVersion: z.string().min(1),
  /** The experiment this run produced, in the run store. */
  runId: z.string().min(1),
  status: benchmarkRunStatusSchema,
  /** Present for a failure; `null` otherwise. */
  error: z.string().nullable(),
  /** Identity of the physics, for the fairness check. */
  physicalFingerprint: z.string().min(1),
  /** Identity of the metric definitions this run was scored under. */
  metricFingerprint: z.string().min(1),
  /** Wall clock on the machine that ran it. Never an engineering quantity. */
  hostDurationMs: z.number().nonnegative(),
});
export type BenchmarkRunRecord = z.infer<typeof benchmarkRunRecordSchema>;

// --- Manifest ---------------------------------------------------------------

export const benchmarkStatusSchema = z.enum(['running', 'completed', 'cancelled', 'failed']);
export type BenchmarkStatus = z.infer<typeof benchmarkStatusSchema>;

export const benchmarkManifestSchema = z.strictObject({
  schemaVersion: z.literal(BENCHMARK_SCHEMA_VERSION),
  benchmarkId: z.string().min(1),
  suiteId: z.string().min(1),
  suiteName: z.string().min(1),
  /** Identity of the whole suite document, so a rerun can be matched to it. */
  suiteFingerprint: z.string().min(1),
  status: benchmarkStatusSchema,
  startedAt: z.string().min(1),
  finishedAt: z.string().nullable(),
  /** What the suite intended to run, before anything ran. */
  plannedRuns: z.number().int().nonnegative(),
  runs: z.array(benchmarkRunRecordSchema),
  applicationVersion: z.string().min(1),
  sourceCommit: z.string().nullable(),
  platform: z.string().min(1),
});
export type BenchmarkManifest = z.infer<typeof benchmarkManifestSchema>;

/** Names of the files in a benchmark directory. */
export const BENCHMARK_FILES = {
  manifest: 'manifest.json',
  suite: 'suite.json',
  aggregate: 'aggregate.json',
  report: 'report.html',
} as const;
