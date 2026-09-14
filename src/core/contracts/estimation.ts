/**
 * Estimation contracts: the tracker's belief about a target over time.
 *
 * A `TrackId` is invented by the tracker and has no relationship to the
 * simulator's `TargetId`. Scoring a run therefore requires solving the
 * association between tracks and targets, which is handled in evaluation and
 * is itself part of what gets measured.
 */

import type { Bearing, BearingRate, BearingStateCovariance } from './geometry';
import type { Meters, Normalized, Seconds } from './units';

declare const trackIdBrand: unique symbol;
/** Tracker-assigned identity, stable across frames for as long as the track lives. */
export type TrackId = string & { readonly [trackIdBrand]: 'TrackId' };

/**
 * Lifecycle of a track.
 *
 * - `tentative` seen too few times to trust;
 * - `confirmed` receiving updates and consistent;
 * - `coasting`  propagating on the motion model with no recent measurement;
 * - `lost`      given up on; will not be updated again.
 */
export type TrackStatus = 'tentative' | 'confirmed' | 'coasting' | 'lost';

/** The tracker's current belief about one target. */
export interface TargetEstimate {
  readonly trackId: TrackId;
  /** Time this estimate is valid for. */
  readonly time: Seconds;
  /** Estimated bearing to the target. */
  readonly bearing: Bearing;
  /** Estimated angular rate. */
  readonly bearingRate: BearingRate;
  /** Covariance over (az, el, az-rate, el-rate). */
  readonly covariance: BearingStateCovariance;
  readonly status: TrackStatus;
  readonly confidence: Normalized;
  /** Number of measurement updates this track has received. */
  readonly updateCount: number;
  /** Consecutive frames with no associated measurement. */
  readonly missedUpdates: number;
  /**
   * Normalised innovation squared from the most recent update, or `null` while
   * coasting. A filter whose NIS sits far from its expected chi-squared value
   * is mistuned, which matters more than raw error for a coarse PAT loop.
   */
  readonly normalisedInnovationSquared: number | null;
  /**
   * Range estimate, or `null` when unobservable. A single camera gives bearing
   * only; range requires a second sensor or a manoeuvre.
   */
  readonly range: Meters | null;
}
