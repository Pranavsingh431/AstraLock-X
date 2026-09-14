/**
 * The privileged evaluation tap.
 *
 * This is the only place that compares what the tracker did against what was
 * actually there. It reads ground truth, which is legitimate and necessary: an
 * evaluator that could not see the truth could not score anything. What it must
 * never do is let any of that reach the algorithm, and it does not — it is
 * called by the recorder after the algorithm has finished with a frame, nothing
 * it produces is routed back, and the lint barrier makes this directory
 * unreachable from `src/core/algorithms/**` (ADR-0014).
 *
 * It records **physical facts only**: the pointing error, the range, whether
 * the bearing lies inside the mount's travel, where the target projects. Metric
 * thresholds — lock, dwell, association radius, trackable range — are applied
 * later, by the KPI engine, so the raw file does not change when a definition
 * does.
 *
 * Pointing error is defined here, precisely. See docs/METRICS.md.
 */

import type { SimulationConfig } from '@/core/contracts/simulation';
import { cameraBasis, projectPoint, resolveIntrinsics } from '@/core/sensors/pinhole';
import type { ResolvedIntrinsics } from '@/core/sensors/pinhole';
import type { SimulationEngine } from '@/core/simulation/engine';

import type { EvaluationSample } from './schema';

/** A world-frame unit vector in East-North-Up. */
export interface UnitVector {
  readonly east: number;
  readonly north: number;
  readonly up: number;
}

/**
 * Angle between two unit vectors, computed stably.
 *
 * `acos(dot)` alone loses its precision when the vectors are nearly parallel —
 * exactly the regime a working tracker spends its time in, where the derivative
 * of `acos` is infinite and the dot product is 1 to within rounding. A pointing
 * error of 100 µrad has a dot product of 1 − 5e-9, which double precision knows
 * to only a few significant figures.
 *
 * `atan2(|a × b|, a · b)` is well conditioned across the whole range, because
 * near zero the cross product is linear in the angle rather than quadratic.
 * That is the difference between resolving a microradian and not.
 */
export function angleBetween(a: UnitVector, b: UnitVector): number {
  const crossEast = a.north * b.up - a.up * b.north;
  const crossNorth = a.up * b.east - a.east * b.up;
  const crossUp = a.east * b.north - a.north * b.east;
  const crossMagnitude = Math.hypot(crossEast, crossNorth, crossUp);
  const dot = a.east * b.east + a.north * b.north + a.up * b.up;
  return Math.atan2(crossMagnitude, dot);
}

/** Normalises a world vector, or returns `null` for a zero-length one. */
export function normalise(east: number, north: number, up: number): UnitVector | null {
  const length = Math.hypot(east, north, up);
  if (!(length > 0) || !Number.isFinite(length)) return null;
  return { east: east / length, north: north / length, up: up / length };
}

/** What the evaluator worked out about one instant, before any threshold. */
export interface EvaluationFrame {
  readonly opticalAxis: UnitVector;
  readonly targetLineOfSight: UnitVector | null;
  /** Angle between the two, in radians, or `null` if there is no target. */
  readonly angularPointingError: number | null;
  readonly trueImageX: number | null;
  readonly trueImageY: number | null;
  /** Distance from the true projected centre to the principal point, in pixels. */
  readonly imagePointingError: number | null;
  readonly targetRange: number | null;
  readonly targetInImage: boolean;
  readonly targetWithinTravel: boolean;
  /** Non-designated emitters projecting inside the image. */
  readonly otherEmittersInImage: number;
}

export interface EvaluatorOptions {
  readonly engine: SimulationEngine;
  readonly config: SimulationConfig;
  /** Index of the designated target. Defaults to the first. */
  readonly designatedIndex?: number;
}

/** A detected centroid, in the image's continuous pixel coordinates. */
export interface DetectedPoint {
  readonly x: number;
  readonly y: number;
}

export class Evaluator {
  private readonly engine: SimulationEngine;
  private readonly intrinsics: ResolvedIntrinsics;
  public readonly designatedIndex: number;
  private readonly pan: { readonly min: number; readonly max: number };
  private readonly tilt: { readonly min: number; readonly max: number };

  constructor(options: EvaluatorOptions) {
    this.engine = options.engine;
    this.intrinsics = resolveIntrinsics(options.config.camera);
    this.designatedIndex = options.designatedIndex ?? 0;
    this.pan = { min: options.config.gimbal.pan.minAngle, max: options.config.gimbal.pan.maxAngle };
    this.tilt = {
      min: options.config.gimbal.tilt.minAngle,
      max: options.config.gimbal.tilt.maxAngle,
    };
  }

  /** The principal point, for reporting distance-from-centre of a detection. */
  public get principalPoint(): { readonly x: number; readonly y: number } {
    return { x: this.intrinsics.cx, y: this.intrinsics.cy };
  }

  /**
   * Evaluates one instant of simulated time, and optionally a detection made
   * at that instant.
   *
   * Uses the **true** optical pose — the mount's mechanical output, not the
   * encoder reading. Scoring against the encoder would score the tracker's
   * belief about where it was pointing rather than where it was actually
   * pointing, which is precisely the error being measured.
   */
  public at(
    simulationTime: number,
    detection: DetectedPoint | null = null,
  ): EvaluationFrame & {
    readonly centroidError: number | null;
    readonly detectionOnOtherEmitter: boolean;
  } {
    const pose = this.engine.gimbalPoseAt(simulationTime);
    const basis = cameraBasis(pose.azimuth, pose.elevation);
    const opticalAxis: UnitVector = {
      east: basis.forward.x,
      north: basis.forward.y,
      up: basis.forward.z,
    };

    const truth = this.engine.sampleAtTime(simulationTime);
    const platform = truth.platform.pose.position;

    // One pass over every emitter: where each projects, which is nearest the
    // detection, and how many non-designated ones are in view.
    let otherEmittersInImage = 0;
    let nearestIndex = -1;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let relative: { x: number; y: number; z: number } | null = null;
    let imageX: number | null = null;
    let imageY: number | null = null;
    let inImage = false;

    for (let index = 0; index < truth.targets.length; index += 1) {
      const position = truth.targets[index]!.pose.position;
      const offset = {
        x: position.x - platform.x,
        y: position.y - platform.y,
        z: position.z - platform.z,
      };
      const projection = projectPoint(offset, basis, this.intrinsics);
      const visible =
        projection.visibility === 'visible' &&
        projection.imageX !== null &&
        projection.imageY !== null;

      if (index === this.designatedIndex) {
        relative = offset;
        inImage = visible;
        imageX = visible ? projection.imageX : null;
        imageY = visible ? projection.imageY : null;
      } else if (visible) {
        otherEmittersInImage += 1;
      }

      if (detection !== null && visible) {
        const distance = Math.hypot(
          detection.x - projection.imageX,
          detection.y - projection.imageY,
        );
        if (distance < nearestDistance) {
          nearestDistance = distance;
          nearestIndex = index;
        }
      }
    }

    if (relative === null) {
      return {
        opticalAxis,
        targetLineOfSight: null,
        angularPointingError: null,
        trueImageX: null,
        trueImageY: null,
        imagePointingError: null,
        targetRange: null,
        targetInImage: false,
        targetWithinTravel: false,
        otherEmittersInImage,
        centroidError: null,
        detectionOnOtherEmitter: nearestIndex !== -1,
      };
    }

    const range = Math.hypot(relative.x, relative.y, relative.z);
    const lineOfSight = normalise(relative.x, relative.y, relative.z);

    return {
      opticalAxis,
      targetLineOfSight: lineOfSight,
      angularPointingError: lineOfSight === null ? null : angleBetween(opticalAxis, lineOfSight),
      trueImageX: imageX,
      trueImageY: imageY,
      imagePointingError:
        imageX === null || imageY === null
          ? null
          : Math.hypot(imageX - this.intrinsics.cx, imageY - this.intrinsics.cy),
      targetRange: range,
      targetInImage: inImage,
      targetWithinTravel: this.withinTravel(lineOfSight),
      otherEmittersInImage,
      // Detector centroid error: a different quantity from pointing error, and
      // defined only when the target projects into the image and a detection
      // exists. A miss is recorded as a miss, never as an enormous error.
      centroidError:
        detection === null || imageX === null || imageY === null
          ? null
          : Math.hypot(detection.x - imageX, detection.y - imageY),
      detectionOnOtherEmitter: nearestIndex !== -1 && nearestIndex !== this.designatedIndex,
    };
  }

  /**
   * The full evaluation row for one processed frame.
   *
   * `patState` and `detection` are the algorithm's own, safe outputs for that
   * frame; they are copied in so the row reads alone.
   */
  public sample(
    frameId: number,
    captureTime: number,
    patState: string,
    detection: DetectedPoint | null,
  ): EvaluationSample {
    const frame = this.at(captureTime, detection);
    return {
      frame_id: frameId,
      capture_time_s: captureTime,
      pat_state: patState,
      detection_present: detection !== null,
      truth_optical_axis_east: frame.opticalAxis.east,
      truth_optical_axis_north: frame.opticalAxis.north,
      truth_optical_axis_up: frame.opticalAxis.up,
      truth_target_los_east: frame.targetLineOfSight?.east ?? null,
      truth_target_los_north: frame.targetLineOfSight?.north ?? null,
      truth_target_los_up: frame.targetLineOfSight?.up ?? null,
      truth_angular_pointing_error_rad: frame.angularPointingError,
      truth_target_range_m: frame.targetRange,
      truth_target_within_travel: frame.targetWithinTravel,
      truth_target_in_image: frame.targetInImage,
      truth_image_x_px: frame.trueImageX,
      truth_image_y_px: frame.trueImageY,
      truth_image_pointing_error_px: frame.imagePointingError,
      truth_detector_centroid_error_px: frame.centroidError,
      truth_detection_on_other_emitter: frame.detectionOnOtherEmitter,
      truth_other_emitters_in_image: frame.otherEmittersInImage,
    };
  }

  /**
   * Whether the bearing to the target lies inside both axes' travel.
   *
   * A property of the geometry and the mount, not of the metrics definition,
   * and deliberately not of where the camera happens to be pointing.
   */
  private withinTravel(lineOfSight: UnitVector | null): boolean {
    if (lineOfSight === null) return false;
    const azimuth = Math.atan2(lineOfSight.east, lineOfSight.north);
    const elevation = Math.atan2(lineOfSight.up, Math.hypot(lineOfSight.east, lineOfSight.north));
    return (
      azimuth >= this.pan.min &&
      azimuth <= this.pan.max &&
      elevation >= this.tilt.min &&
      elevation <= this.tilt.max
    );
  }
}
