/**
 * What makes two runs comparable, and what to do when they are not.
 *
 * A benchmark's whole claim is "same world, different algorithm". That claim is
 * easy to assert and easy to break: a scenario edited between arms, a seed that
 * differed, a metric threshold changed halfway. None of those would announce
 * itself — the run would complete, the numbers would look plausible, and the
 * comparison would be meaningless.
 *
 * So the claim is checked rather than asserted. Every run carries two
 * fingerprints, and a comparison that finds them disagreeing is reported as
 * invalid instead of being reduced to a winner.
 *
 * ## Physical fingerprint
 *
 * Everything that decides what light reached the camera: the scenario's
 * identity and seed, the targets and their beacons and codes, the camera, the
 * gimbal, the platform, the disturbance configuration including frame loss, the
 * duration and tick rate.
 *
 * `name` is excluded because it is a display label, and two runs that differ
 * only in what a human called the scenario are physically the same. Everything
 * else in `SimulationConfig` is included, so a field added to the schema later
 * is covered by default rather than silently omitted — the failure mode of an
 * allowlist.
 *
 * **The algorithm is not in it, and that is the point.** The fingerprint must
 * be identical across the arms of a case; if algorithm configuration entered it,
 * it never could be.
 *
 * ## Metric fingerprint
 *
 * The metric definitions a run was scored under. Two arms scored against
 * different lock thresholds are not two measurements of the same thing, and
 * §7 of the phase specification makes that invalidating rather than a footnote.
 * A suite that deliberately varies thresholds is a metric-sensitivity
 * experiment and is not this.
 */

import type { SimulationConfig } from '@/core/contracts/simulation';
import { fingerprint } from '@/core/experiments/fingerprint';
import type { MetricsConfig } from '@/core/experiments/schema';

/**
 * Identity of the physics a run was flown against.
 *
 * Prefixed so a stored value says what it is when read out of a manifest
 * without its surrounding context.
 */
export function physicalFingerprint(config: SimulationConfig): string {
  // Destructured rather than deleted, so adding a field to SimulationConfig
  // includes it automatically and omitting one is a visible act here.
  const { name: _name, ...physics } = config;
  return `physical:${fingerprint(physics)}`;
}

/** Identity of the metric definitions a run was scored under. */
export function metricFingerprint(config: MetricsConfig): string {
  return `metric:${fingerprint(config)}`;
}

/** Why a comparison cannot be made. */
export type ComparisonInvalidity =
  'INVALID_PHYSICAL_MISMATCH' | 'INVALID_METRIC_MISMATCH' | 'INVALID_NO_RUNS';

export interface ComparisonValidity {
  readonly valid: boolean;
  /** `null` when valid. */
  readonly reason: ComparisonInvalidity | null;
  /** Human-readable detail for the report, or `null`. */
  readonly detail: string | null;
}

const VALID: ComparisonValidity = { valid: true, reason: null, detail: null };

/**
 * Whether a set of runs may be compared with one another.
 *
 * Takes the runs that are actually going to be compared, which is deliberately
 * narrower than "every run in the suite": a benchmark comparing two arms of one
 * case at one seed needs those to agree and does not care what some other case
 * was flown against.
 *
 * Comparing zero runs is invalid rather than vacuously true. A table cell built
 * from nothing should say so.
 */
export function validateComparison(
  runs: readonly { physicalFingerprint: string; metricFingerprint: string }[],
): ComparisonValidity {
  if (runs.length === 0) {
    return {
      valid: false,
      reason: 'INVALID_NO_RUNS',
      detail: 'No completed runs to compare.',
    };
  }

  const physical = new Set(runs.map((run) => run.physicalFingerprint));
  if (physical.size > 1) {
    return {
      valid: false,
      reason: 'INVALID_PHYSICAL_MISMATCH',
      detail:
        `The arms were flown against ${String(physical.size)} different physical configurations ` +
        `(${[...physical].map((f) => f.slice(0, 22)).join(', ')}). ` +
        'A comparison across different physics measures the difference in physics.',
    };
  }

  const metric = new Set(runs.map((run) => run.metricFingerprint));
  if (metric.size > 1) {
    return {
      valid: false,
      reason: 'INVALID_METRIC_MISMATCH',
      detail:
        `The arms were scored under ${String(metric.size)} different metric definitions. ` +
        'Two arms scored against different thresholds are not two measurements of the same thing.',
    };
  }

  return VALID;
}
