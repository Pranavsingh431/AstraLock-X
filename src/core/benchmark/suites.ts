/**
 * The bundled benchmark suites.
 *
 * Three, for three different questions, kept separate because conflating them
 * is how a demo becomes a claim:
 *
 * - **Quick Validation** — one seed, six cases, a few minutes. It answers "does
 *   the comparison still work?" and is explicitly not comprehensive.
 * - **Engineering Comparison** — five declared seeds over the stochastic and
 *   contested cases. This is the one whose numbers mean something.
 * - **Full Coverage** — every capability built through Phase 8, one seed each,
 *   as a breadth check rather than a statistical one.
 *
 * Every suite pairs the same two trackers against identical physics. The
 * baseline is always the first arm, which makes it the reference the paired
 * comparison measures against.
 *
 * Seeds are written here, in source, before any of them was run. A suite that
 * generated its seeds at execution time could not be repeated and could not be
 * audited, so the generator does not exist.
 */

import {
  DEFAULT_ASTRALOCK_CONFIG,
  DEFAULT_BASELINE_PAT_CONFIG,
  astraLockXPat,
  baselineKfPidPat,
  terminalProfileById,
  withExpectedBeacon,
} from '@/core/algorithms';
import { DEFAULT_METRICS_CONFIG } from '@/core/experiments/schema';

import {
  BENCHMARK_SCHEMA_VERSION,
  benchmarkSuiteSchema,
  type BenchmarkArm,
  type BenchmarkCase,
  type BenchmarkSuite,
  type ScenarioIdInSuite,
} from './schema';

/**
 * The five seeds the engineering suite uses.
 *
 * Fixed in source ahead of any result. Not chosen, not filtered, not reordered:
 * picking seeds after seeing what they produced is how a favourable number gets
 * published, and declaring them here makes that impossible to do by accident.
 */
export const ENGINEERING_SEEDS = [9101, 9102, 9103, 9104, 9105] as const;

/** The single seed the quick and coverage suites use. */
export const DEMONSTRATION_SEED = 9101;

/**
 * The terminal the coded cases are flown with.
 *
 * Chosen here, explicitly, and not read from the scenario. Every bundled coded
 * beacon transmits Code A, so a terminal set to Code A links with them and one
 * set to Code B does not — which is a property of the configuration, visible in
 * `algorithm.json`, rather than something the benchmark arranges behind the
 * scenes. See docs/BEACON_IDENTITY.md.
 */
const MISSION_TERMINAL = terminalProfileById('code-a-15-66ms')!;

const BASELINE_ARM: BenchmarkArm = {
  armId: 'baseline-kf-pid',
  label: 'Baseline KF + PID',
  algorithmId: baselineKfPidPat.manifest.id,
  config: DEFAULT_BASELINE_PAT_CONFIG,
};

/** AstraLock-X with no code correlator: the Phase 7 tracker. */
const ASTRALOCK_ARM: BenchmarkArm = {
  armId: 'astralock-x',
  label: 'AstraLock-X',
  algorithmId: astraLockXPat.manifest.id,
  config: DEFAULT_ASTRALOCK_CONFIG,
};

/** AstraLock-X with the receiver set to the mission's beacon profile. */
const ASTRALOCK_IDENTITY_ARM: BenchmarkArm = {
  armId: 'astralock-x-identity',
  label: 'AstraLock-X + beacon identity',
  algorithmId: astraLockXPat.manifest.id,
  config: withExpectedBeacon(DEFAULT_ASTRALOCK_CONFIG, MISSION_TERMINAL),
};

interface CaseSpec {
  readonly caseId: string;
  readonly label: string;
  readonly description: string;
  readonly scenarioId: ScenarioIdInSuite;
  readonly durationSeconds: number;
  readonly arms: readonly BenchmarkArm[];
  readonly success?: BenchmarkCase['success'];
}

const buildCase = (spec: CaseSpec, seeds: readonly number[]): BenchmarkCase => ({
  caseId: spec.caseId,
  label: spec.label,
  description: spec.description,
  scenarioId: spec.scenarioId,
  durationSeconds: spec.durationSeconds,
  seeds: [...seeds],
  arms: [...spec.arms],
  success: spec.success ?? null,
});

const TWO_TRACKERS = [BASELINE_ARM, ASTRALOCK_ARM] as const;
const IDENTITY_ABLATION = [ASTRALOCK_ARM, ASTRALOCK_IDENTITY_ARM] as const;

// --- Case library -----------------------------------------------------------
//
// Named once and reused by the suites, so two suites that run "the hard decoy"
// are running the same case rather than two cases that happen to look alike.

const FUNDAMENTAL: readonly CaseSpec[] = [
  {
    caseId: 'acquire-outside-fov',
    label: 'Acquisition from outside the field of view',
    description: 'A stationary beacon the mount has to find by searching.',
    scenarioId: 'astralock-stationary',
    durationSeconds: 40,
    arms: TWO_TRACKERS,
  },
  {
    caseId: 'smooth-crossing',
    label: 'Smooth crossing target',
    description: 'A constant-velocity pass: the case neither tracker should struggle with.',
    scenarioId: 'astralock-moving',
    durationSeconds: 40,
    arms: TWO_TRACKERS,
  },
];

const MOTION: readonly CaseSpec[] = [
  {
    caseId: 'manoeuvring-target',
    label: 'Manoeuvring target',
    description: 'Sustained acceleration, where a single-model filter lags.',
    scenarioId: 'astralock-maneuver',
    durationSeconds: 45,
    arms: TWO_TRACKERS,
  },
];

const RECOVERY: readonly CaseSpec[] = [
  {
    caseId: 'short-loss',
    label: 'Brief loss and return',
    description: 'The beacon disappears and comes back near the prediction.',
    scenarioId: 'astralock-short-loss',
    durationSeconds: 45,
    arms: TWO_TRACKERS,
  },
];

const HANDOFF: readonly CaseSpec[] = [
  {
    caseId: 'handoff-ready',
    label: 'Handoff-eligible target',
    description: 'A target steady enough for a coarse-to-fine handoff claim.',
    scenarioId: 'astralock-handoff',
    durationSeconds: 45,
    arms: TWO_TRACKERS,
    success: { kind: 'handoff-ready' },
  },
];

const PLATFORM: readonly CaseSpec[] = [
  {
    caseId: 'platform-vibration',
    label: 'Platform vibration',
    description: 'Base attitude disturbance the encoder cannot see.',
    scenarioId: 'dist-vibration',
    durationSeconds: 45,
    arms: TWO_TRACKERS,
  },
  {
    caseId: 'low-contrast',
    label: 'Low contrast and sensor noise',
    description: 'A dim beacon against shot and read noise.',
    scenarioId: 'dist-low-contrast',
    durationSeconds: 45,
    arms: TWO_TRACKERS,
  },
  {
    caseId: 'frame-loss',
    label: 'Bursty frame loss',
    description: 'Frames that never arrive, in bursts.',
    scenarioId: 'dist-frame-loss',
    durationSeconds: 45,
    arms: TWO_TRACKERS,
  },
  {
    caseId: 'combined-stress',
    label: 'Combined stress',
    description: 'Vibration, attenuation, noise and dropout together.',
    scenarioId: 'dist-combined',
    durationSeconds: 45,
    arms: TWO_TRACKERS,
  },
];

const FALSE_SOURCE: readonly CaseSpec[] = [
  {
    caseId: 'decoy-easy',
    label: 'An obvious decoy',
    description: 'A bright source well off the predicted bearing: gating should reject it.',
    scenarioId: 'dist-decoy-easy',
    durationSeconds: 45,
    arms: TWO_TRACKERS,
  },
  {
    caseId: 'decoy-hard',
    label: 'A plausible decoy',
    description: 'A comparable source crossing close to the prediction. Phase 7 false-locks here.',
    scenarioId: 'dist-decoy-hard',
    durationSeconds: 45,
    arms: TWO_TRACKERS,
    success: { kind: 'retention-without-false-lock', threshold: 0.8 },
  },
];

const IDENTITY: readonly CaseSpec[] = [
  {
    caseId: 'coded-decoy-wrong',
    label: 'Intruder sending a different code',
    description: 'Both sources coded, separable in principle by what they transmit.',
    scenarioId: 'code-decoy-wrong',
    durationSeconds: 45,
    arms: IDENTITY_ABLATION,
    success: { kind: 'retention-without-false-lock', threshold: 0.8 },
  },
  {
    caseId: 'coded-decoy-hard',
    label: 'Hard decoy, both coded',
    description: 'The Phase 7 geometry with both sources coded: the headline identity case.',
    scenarioId: 'code-decoy-hard',
    durationSeconds: 45,
    arms: IDENTITY_ABLATION,
    success: { kind: 'retention-without-false-lock', threshold: 0.8 },
  },
  {
    caseId: 'coded-identical',
    label: 'Intruder sending the identical code',
    description:
      'The same signal from a different object. No receiver can separate these, and the ' +
      'benchmark is expected to show identity adding nothing.',
    scenarioId: 'code-identical',
    durationSeconds: 45,
    arms: IDENTITY_ABLATION,
  },
];

function suite(
  suiteId: string,
  name: string,
  description: string,
  specs: readonly CaseSpec[],
  seeds: readonly number[],
  defaultSuccess: BenchmarkSuite['defaultSuccess'],
): BenchmarkSuite {
  return benchmarkSuiteSchema.parse({
    schemaVersion: BENCHMARK_SCHEMA_VERSION,
    suiteId,
    name,
    description,
    metricsConfig: DEFAULT_METRICS_CONFIG,
    defaultSuccess,
    cases: specs.map((spec) => buildCase(spec, seeds)),
  });
}

/**
 * A short suite for a demonstration or a smoke check.
 *
 * Six cases at one seed. It is a validation harness, not a measurement: one
 * seed of a stochastic scenario is one realization, and nothing here should be
 * quoted as a result.
 */
export const QUICK_VALIDATION_SUITE: BenchmarkSuite = suite(
  'quick-validation',
  'AstraBench Quick Validation',
  'Six cases at a single declared seed. A functional check, not a measurement: ' +
    'one seed of a stochastic scenario is one realization.',
  [FUNDAMENTAL[0]!, FUNDAMENTAL[1]!, MOTION[0]!, RECOVERY[0]!, FALSE_SOURCE[1]!, IDENTITY[1]!],
  [DEMONSTRATION_SEED],
  { kind: 'acquired' },
);

/**
 * The suite whose numbers are worth quoting.
 *
 * Five declared seeds over the cases where the seed actually changes the world:
 * the disturbed scenarios and the contested ones. Paired across arms, so the
 * comparison is per-seed rather than between unrelated averages.
 */
export const ENGINEERING_SUITE: BenchmarkSuite = suite(
  'engineering-comparison',
  'AstraBench Engineering Comparison',
  'The stochastic and contested cases across five seeds declared in source, ' +
    'with every arm of a case flown against identical physics.',
  [...PLATFORM, ...FALSE_SOURCE, ...IDENTITY],
  ENGINEERING_SEEDS,
  { kind: 'retention-at-least', threshold: 0.8 },
);

/** Every capability built through Phase 8, one seed each. Breadth, not depth. */
export const FULL_COVERAGE_SUITE: BenchmarkSuite = suite(
  'full-coverage',
  'AstraBench Full Coverage',
  'Every bundled capability at one declared seed: fundamentals, motion, recovery, ' +
    'handoff, platform and optics, false sources and coded identity.',
  [...FUNDAMENTAL, ...MOTION, ...RECOVERY, ...HANDOFF, ...PLATFORM, ...FALSE_SOURCE, ...IDENTITY],
  [DEMONSTRATION_SEED],
  { kind: 'acquired' },
);

export const BENCHMARK_SUITES: readonly BenchmarkSuite[] = [
  QUICK_VALIDATION_SUITE,
  ENGINEERING_SUITE,
  FULL_COVERAGE_SUITE,
];

export const suiteById = (id: string): BenchmarkSuite | undefined =>
  BENCHMARK_SUITES.find((entry) => entry.suiteId === id);
