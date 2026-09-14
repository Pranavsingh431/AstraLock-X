/**
 * Experiment lifecycle: discrete events during a run, and the summary after it.
 *
 * **Phase 0 sketch, not the Phase 5 record.** The experiment record that is
 * actually persisted, recomputed and reported — manifest, events, telemetry,
 * evaluation, summary — is defined, with runtime schemas, in
 * `src/core/experiments/schema.ts` (docs/EXPERIMENTS.md). These interfaces
 * predate it, are not used by it, and are kept only because the contract
 * export-boundary type test proves them ground-truth-free.
 *
 * Events form an ordered log that explains *why* a run went the way it did;
 * the summary reduces the run to comparable numbers. AstraBench compares
 * algorithms on summaries, and Replay reconstructs a run from events.
 */

import type { TrackId } from './estimation';
import type { PATMode, PATTransitionReason } from './pat';
import type { SimulationConfig, SimulationSeed } from './simulation';
import type { Microradians, Milliseconds, Normalized, Seconds } from './units';

declare const runIdBrand: unique symbol;
/** Identity of a single execution of a config. */
export type RunId = string & { readonly [runIdBrand]: 'RunId' };

interface ExperimentEventBase {
  readonly runId: RunId;
  /** Simulated time the event occurred. */
  readonly time: Seconds;
  readonly tick: number;
}

export interface RunStartedEvent extends ExperimentEventBase {
  readonly kind: 'run-started';
  readonly configId: string;
  readonly seed: SimulationSeed;
  readonly algorithmId: string;
}

export interface RunCompletedEvent extends ExperimentEventBase {
  readonly kind: 'run-completed';
  readonly ticksExecuted: number;
}

export interface RunAbortedEvent extends ExperimentEventBase {
  readonly kind: 'run-aborted';
  readonly reason: string;
}

export interface ModeChangedEvent extends ExperimentEventBase {
  readonly kind: 'mode-changed';
  readonly from: PATMode;
  readonly to: PATMode;
  readonly reason: PATTransitionReason;
}

export interface TrackStartedEvent extends ExperimentEventBase {
  readonly kind: 'track-started';
  readonly trackId: TrackId;
}

export interface TrackLostEvent extends ExperimentEventBase {
  readonly kind: 'track-lost';
  readonly trackId: TrackId;
  readonly missedUpdates: number;
}

export interface GimbalSaturatedEvent extends ExperimentEventBase {
  readonly kind: 'gimbal-saturated';
  readonly axis: 'azimuth' | 'elevation';
  readonly limit: 'rate-limit' | 'travel-limit';
}

export interface FrameDroppedEvent extends ExperimentEventBase {
  readonly kind: 'frame-dropped';
  readonly frameId: number;
}

/**
 * The algorithm threw, or exceeded its time budget.
 *
 * Recorded rather than propagated: an algorithm that fails on one tick is a
 * result worth measuring, not a reason to discard the run.
 */
export interface AlgorithmErrorEvent extends ExperimentEventBase {
  readonly kind: 'algorithm-error';
  readonly message: string;
  readonly recoverable: boolean;
}

/** Anything that can appear in a run's event log. */
export type ExperimentEvent =
  | RunStartedEvent
  | RunCompletedEvent
  | RunAbortedEvent
  | ModeChangedEvent
  | TrackStartedEvent
  | TrackLostEvent
  | GimbalSaturatedEvent
  | FrameDroppedEvent
  | AlgorithmErrorEvent;

/**
 * Distribution of a scalar over a run.
 *
 * Pointing error is heavy-tailed — a loop can sit at a few microradians and
 * still break the link during a brief excursion — so percentiles are reported
 * alongside the mean rather than instead of it.
 */
export interface ErrorStatistics {
  readonly mean: Microradians;
  readonly rms: Microradians;
  readonly p50: Microradians;
  readonly p95: Microradians;
  readonly p99: Microradians;
  readonly max: Microradians;
}

/**
 * Scored result of one run.
 *
 * Produced by evaluation, which compares telemetry against ground truth. It
 * contains derived statistics rather than any ground-truth state, so it is safe
 * to store and display — but it must never be fed back to an algorithm during
 * a run, which the lint barrier over `core/metrics` enforces.
 */
export interface ExperimentSummary {
  readonly runId: RunId;
  readonly configId: string;
  readonly seed: SimulationSeed;
  readonly algorithmId: string;
  /** Hash of the config, so a summary can be matched to the exact inputs. */
  readonly configFingerprint: string;

  readonly ticksExecuted: number;
  readonly simulatedDuration: Seconds;
  /** Wall-clock time the run took, for throughput comparison. */
  readonly wallClockDuration: Milliseconds;

  /** True boresight-to-target angle, measured against ground truth. */
  readonly pointingError: ErrorStatistics;
  /** Fraction of the run spent in `track` mode with a correct association. */
  readonly timeInLock: Normalized;
  /** Simulated time from run start to first confirmed, correct track. */
  readonly acquisitionTime: Seconds | null;
  /** Number of times a correct lock was lost. */
  readonly lostLockCount: number;
  /** Tracks that were confirmed but matched no real target. */
  readonly falseTrackCount: number;

  /** Per-tick algorithm cost, for the compute budget an embedded target implies. */
  readonly meanTickCost: Milliseconds;
  readonly maxTickCost: Milliseconds;

  /** Config the run came from, kept so a summary is self-describing. */
  readonly config: SimulationConfig;
}
