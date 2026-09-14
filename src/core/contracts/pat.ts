/**
 * Pointing, Acquisition and Tracking mode state.
 *
 * The coarse PAT loop is a state machine before it is an estimator: what the
 * system should do next depends on whether it is searching, closing on a
 * candidate, holding a lock, or recovering from one it just lost.
 */

import type { TrackId } from './estimation';
import type { Decibels, Radians, Seconds } from './units';

/**
 * - `idle`      powered but not commanded to do anything;
 * - `scan`      sweeping a search pattern, nothing acquired;
 * - `acquire`   a candidate is being confirmed before committing to it;
 * - `track`     holding a confirmed track inside the tracking envelope;
 * - `lost`      a confirmed track was dropped; not yet searching again;
 * - `reacquire` lock was lost recently; searching the predicted neighbourhood;
 * - `fault`     hardware or algorithm fault; not pointing under control.
 *
 * `lost` and `reacquire` are different claims. `lost` says only that the track
 * is gone; `reacquire` says the system is actively searching where it predicts
 * the target went. The Phase 4 baseline reaches `lost` and then restarts a
 * blind scan, so it never enters `reacquire` — predictive local recovery is
 * deliberately left to the robust algorithm, and the baseline must not be able
 * to claim it.
 */
/**
 * Where a PAT algorithm is.
 *
 * `handoff` is **handoff-ready**: the coarse tracker judges that alignment meets
 * the fine-pointing stage's acceptance conditions and keeps holding it. No
 * fine-pointing actuator is modelled; the mode says the coarse loop is ready to
 * hand over, not that anything has taken over.
 */
export type PATMode =
  'idle' | 'scan' | 'acquire' | 'track' | 'lost' | 'reacquire' | 'handoff' | 'fault';

/** Why the mode last changed. Recorded so a run can be explained afterwards. */
export type PATTransitionReason =
  | 'commanded'
  | 'candidate-detected'
  | 'track-confirmed'
  | 'track-lost'
  | 'search-exhausted'
  | 'gimbal-saturated'
  | 'algorithm-error';

/**
 * Current state of the PAT loop.
 *
 * `estimatedPointingError` is the tracker's own view of how far off boresight
 * it believes the target to be. It is not the true error: an over-confident
 * tracker reports a small value here while missing badly, and detecting that
 * gap is one of the things AstraLock-X exists to measure.
 */
export interface PATState {
  readonly mode: PATMode;
  /** Simulated time the current mode was entered. */
  readonly since: Seconds;
  /** Reason for the most recent transition. */
  readonly lastTransitionReason: PATTransitionReason;
  /** Track currently being followed, or `null` outside `track`/`reacquire`. */
  readonly activeTrack: TrackId | null;
  /** The tracker's estimate of boresight-to-target angle, or `null` if unknown. */
  readonly estimatedPointingError: Radians | null;
  /**
   * Estimated optical link margin, or `null` when no beacon is being received.
   * Drives the decision to hand over from coarse to fine pointing.
   */
  readonly linkMargin: Decibels | null;
  /** Consecutive frames the active track failed to update. */
  readonly consecutiveMisses: number;
  /** Total mode transitions so far. Excessive churn is itself a failure mode. */
  readonly transitionCount: number;
}
