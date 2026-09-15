/**
 * What the simulator knows about a captured frame.
 *
 * **Privileged, and branded as ground truth.** This is the answer key for an
 * image: where each emitter really landed, how far away it really was, and why
 * one that is missing is missing.
 *
 * It exists because the camera geometry has to be checkable — a projection bug
 * is otherwise invisible, since a wrong image still looks like an image — and
 * because evaluation will eventually score a tracker's centroid against the
 * true one. It is a **separate object** from `CameraSensorFrame` and never
 * travels with it. The frame is what a device would hand you; this is what only
 * a simulator can know.
 *
 * See docs/adr/0003-ground-truth-isolation.md.
 */

import { brandAsGroundTruth } from '@/core/contracts/ground-truth';
import type { GroundTruthTainted } from '@/core/contracts/isolation';
import type { Meters, Radians, Seconds } from '@/core/contracts/units';

import type { FrameDisturbance } from '@/core/disturbance';

import type { EmitterId } from './emitters';
import type { EmitterVisibility } from './pinhole';

/**
 * The true fate of one emitter in one frame.
 *
 * Branded individually, not merely nested inside the branded record above.
 * A projection carries the true image centre and the true range, so lifting one
 * out of `projections` would otherwise produce a clean-looking object holding
 * the answer key — and the type-level check would not object.
 */
export interface EmitterProjectionTruth extends GroundTruthTainted {
  readonly emitterId: EmitterId;
  readonly hostEntityId: string;
  /** Why it is, or is not, on the image. */
  readonly visibility: EmitterVisibility;
  /**
   * True projected centre in continuous image coordinates, or `null` when the
   * emitter is not visible. This is the value a centroid algorithm will
   * eventually be scored against.
   */
  readonly imageX: number | null;
  readonly imageY: number | null;
  /**
   * Where the emitter's light actually landed, after apparent angular wander.
   *
   * Equal to `imageX`/`imageY` whenever wander is off, which is every run before
   * Phase 7 and every clean run since. The pair is kept separate because the two
   * answer different questions and a single field would silently merge them: the
   * geometric centre says where the emitter *is*, which is what pointing error
   * is measured against, and the apparent centre says where its light *arrived*,
   * which is the best a centroid algorithm could possibly do.
   */
  readonly apparentImageX: number | null;
  readonly apparentImageY: number | null;
  /** True straight-line distance from the camera. */
  readonly range: Meters;
  /** True bearing of the emitter relative to the camera boresight. */
  readonly offsetAzimuth: Radians;
  readonly offsetElevation: Radians;
  /** Peak intensity actually written, after clipping. */
  readonly peakIntensity: number;
  /** Pixels the point spread actually wrote. Zero when clipped away entirely. */
  readonly pixelsWritten: number;
}

/** Everything the simulator knows about one captured frame. */
export interface SensorEvaluationTruth extends GroundTruthTainted {
  readonly frameId: number;
  readonly captureTime: Seconds;
  /** Where the mount truly pointed at capture time. */
  readonly cameraAzimuth: Radians;
  readonly cameraElevation: Radians;
  /** True camera position in world ENU metres. */
  readonly cameraPositionEast: Meters;
  readonly cameraPositionNorth: Meters;
  readonly cameraPositionUp: Meters;
  /**
   * The disturbance realization behind this frame, or `null` on a clean run.
   *
   * The platform attitude that was added to the mount's own pointing, the
   * apparent angular displacement of the beacon, and the scintillation gain.
   * Scalars only: the per-pixel noise field is reproducible from the seed and
   * the frame index, so storing it would turn an experiment record into a video.
   */
  readonly disturbance: FrameDisturbance | null;
  readonly projections: readonly EmitterProjectionTruth[];
}

/** Brands one freshly built projection record. */
export function brandProjectionTruth(
  value: Omit<EmitterProjectionTruth, keyof GroundTruthTainted>,
): EmitterProjectionTruth {
  return brandAsGroundTruth(value);
}

/** Brands a freshly built evaluation record. */
export function brandSensorTruth(
  value: Omit<SensorEvaluationTruth, keyof GroundTruthTainted>,
): SensorEvaluationTruth {
  return brandAsGroundTruth(value);
}
