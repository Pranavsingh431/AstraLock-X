/**
 * Telemetry: the ground-truth-free record of a run.
 *
 * One sample per tick, carrying what the system itself could know. It is safe
 * to stream to any consumer, including a live tracking algorithm, because
 * nothing in it is privileged.
 *
 * Truth-referenced series — actual pointing error, whether a track corresponds
 * to a real target — deliberately live elsewhere, in evaluation output, so that
 * a chart of "what the system believed" can never be confused with a chart of
 * "what was actually happening".
 */

import type { ControlCommand } from './control';
import type { PATMode } from './pat';
import type { Milliseconds, Radians, RadiansPerSecond, Seconds } from './units';

/** Per-stage compute cost for one tick, measured on the wall clock. */
export interface StageTiming {
  readonly perception: Milliseconds;
  readonly estimation: Milliseconds;
  readonly control: Milliseconds;
  /** Total time inside the algorithm, which may exceed the sum of the stages. */
  readonly total: Milliseconds;
}

/** One tick of the ground-truth-free telemetry stream. */
export interface TelemetrySample {
  readonly tick: number;
  /** Simulated time of this tick. */
  readonly time: Seconds;
  /** Frame processed on this tick, or `null` when no frame was available. */
  readonly frameId: number | null;
  readonly patMode: PATMode;
  /** Measured gimbal angles at this tick. */
  readonly measuredAzimuth: Radians;
  readonly measuredElevation: Radians;
  readonly measuredAzimuthRate: RadiansPerSecond;
  readonly measuredElevationRate: RadiansPerSecond;
  /** Command the algorithm issued, or `null` if it issued none. */
  readonly command: ControlCommand | null;
  /** The tracker's own estimate of its pointing error. Not the true error. */
  readonly estimatedPointingError: Radians | null;
  /** Detections produced from this tick's frame. */
  readonly observationCount: number;
  /** Live tracks, in any status other than `lost`. */
  readonly trackCount: number;
  readonly timing: StageTiming;
}
