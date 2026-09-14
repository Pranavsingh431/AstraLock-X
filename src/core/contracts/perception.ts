/**
 * Perception contracts: what a detector extracts from a frame.
 *
 * An observation is a claim about the image, not about the world. It carries no
 * target identity, because deciding which blob is which target across frames is
 * the estimator's job and handing it over would trivialise the problem.
 */

import type { Bearing, ImagePoint, ImageRect, Matrix2x2 } from './geometry';
import type { Decibels, Normalized, Seconds } from './units';

declare const observationIdBrand: unique symbol;
/** Identity of a single detection within a single frame. Not stable across frames. */
export type ObservationId = string & { readonly [observationIdBrand]: 'ObservationId' };

/** How a detection was produced, for diagnostics and per-detector metrics. */
export type DetectionMethod =
  'intensity-centroid' | 'matched-filter' | 'correlation' | 'contour' | 'learned-detector';

/**
 * One candidate target extracted from one frame.
 *
 * Detections are candidates, not truth: a scene with sun glint or a hot cloud
 * edge will produce observations that correspond to nothing.
 */
export interface TargetObservation {
  readonly observationId: ObservationId;
  /** Frame this detection came from. */
  readonly frameId: number;
  /** Mid-exposure time of that frame. */
  readonly time: Seconds;
  /** Sub-pixel centroid in image coordinates. */
  readonly centroid: ImagePoint;
  /** Extent of the detection, when the method produces one. */
  readonly boundingBox: ImageRect | null;
  /**
   * Centroid re-projected to a bearing using the believed intrinsics and
   * measured gimbal angles. Carries every error in that chain.
   */
  readonly bearing: Bearing;
  /** Measurement covariance in image space, in px^2. */
  readonly pixelCovariance: Matrix2x2;
  /** Peak intensity, normalised against the format's full scale. */
  readonly peakIntensity: Normalized;
  /** Estimated signal-to-noise ratio of the detection. */
  readonly snr: Decibels;
  /** Detector's own confidence on [0, 1]. */
  readonly confidence: Normalized;
  readonly method: DetectionMethod;
}
