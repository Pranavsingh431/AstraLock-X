/**
 * Builds the true state of the world at a given simulated time.
 *
 * Every quantity here is a pure function of the scenario, the trajectories and
 * the time. Nothing accumulates across calls, which is what makes
 * `stateAt(t)` independent of how the run arrived at `t` — the property the
 * whole determinism story rests on.
 */

import type {
  GroundTruthGimbalState,
  GroundTruthPlatformState,
  GroundTruthState,
  GroundTruthTargetState,
} from '@/core/contracts/ground-truth';
import { brandAsGroundTruth } from '@/core/contracts/ground-truth';
import type { CameraConfig, SimulationConfig } from '@/core/contracts/simulation';
import {
  type Meters,
  type Radians,
  meters,
  metersPerSecond,
  normalized,
  radians,
  radiansPerSecond,
  seconds,
} from '@/core/contracts/units';

import { resolveIntrinsics } from '@/core/sensors/pinhole';

import { WORLD_FRAME, bearingRateTo, bearingTo, directionFromBearing } from './coordinates';
import { targetIdAt } from './entities';
import type { Trajectory, TrajectorySample } from './trajectory';
import { type Vector3, add, cross, dot, normalize, scale, subtract, vec3 } from './vector';

/** Identity rotation. Phase 1 models targets as points with no attitude. */
const IDENTITY_ORIENTATION = { w: 1, x: 0, y: 0, z: 0 } as const;

/** Half-angles of a pinhole camera's rectangular field of view. */
export interface FieldOfViewHalfAngles {
  readonly horizontal: number;
  readonly vertical: number;
}

/**
 * Field of view implied by the camera configuration.
 *
 * Delegates to the sensor module's intrinsics resolution so the world's idea of
 * what is in view and the sensor's idea cannot drift apart — they are the same
 * numbers, derived once.
 */
export function fieldOfViewHalfAngles(camera: CameraConfig): FieldOfViewHalfAngles {
  const intrinsics = resolveIntrinsics(camera);
  return {
    horizontal: intrinsics.horizontalFov / 2,
    vertical: intrinsics.verticalFov / 2,
  };
}

/**
 * Orthonormal camera frame about a boresight direction.
 *
 * `right` is chosen perpendicular to world Up so the image has no roll. When
 * the boresight is vertical that construction degenerates, and North is used as
 * the reference instead — an arbitrary but deterministic choice, which is what
 * matters.
 */
function cameraFrame(boresight: Vector3): {
  readonly forward: Vector3;
  readonly right: Vector3;
  readonly up: Vector3;
} {
  const forward = normalize(boresight);
  const worldUp = vec3(0, 0, 1);
  const reference = Math.abs(dot(forward, worldUp)) > 0.999 ? vec3(0, 1, 0) : worldUp;
  const right = normalize(cross(forward, reference));
  const up = cross(right, forward);
  return { forward, right, up };
}

/**
 * Whether a direction falls inside the camera's rectangular field of view.
 *
 * Geometric containment only. There is no occlusion test, no image formation
 * and no detectability threshold — a target can be inside the field of view and
 * still be invisible to a real sensor. Those belong to Phase 2.
 */
function isInsideFieldOfView(
  targetDirection: Vector3,
  boresight: Vector3,
  halfAngles: FieldOfViewHalfAngles,
): boolean {
  const frame = cameraFrame(boresight);
  const forward = dot(targetDirection, frame.forward);
  if (forward <= 0) return false;

  const horizontal = Math.atan2(dot(targetDirection, frame.right), forward);
  const vertical = Math.atan2(dot(targetDirection, frame.up), forward);

  return Math.abs(horizontal) <= halfAngles.horizontal && Math.abs(vertical) <= halfAngles.vertical;
}

/** Angle between two unit vectors, numerically safe at both ends. */
function angleBetween(a: Vector3, b: Vector3): number {
  return Math.acos(Math.min(1, Math.max(-1, dot(a, b))));
}

const toMeters = (v: Vector3) => ({ x: meters(v.x), y: meters(v.y), z: meters(v.z) });
const toMetersPerSecond = (v: Vector3) => ({
  x: metersPerSecond(v.x),
  y: metersPerSecond(v.y),
  z: metersPerSecond(v.z),
});

/** Platform state at `timeSeconds`, moving at constant velocity. */
export function platformStateAt(
  config: SimulationConfig,
  timeSeconds: number,
): {
  readonly state: GroundTruthPlatformState;
  readonly position: Vector3;
  readonly velocity: Vector3;
} {
  const velocity = vec3(
    config.platform.initialVelocity.x,
    config.platform.initialVelocity.y,
    config.platform.initialVelocity.z,
  );
  const position = add(
    vec3(
      config.platform.initialPosition.x,
      config.platform.initialPosition.y,
      config.platform.initialPosition.z,
    ),
    scale(velocity, timeSeconds),
  );

  const state = brandAsGroundTruth({
    pose: {
      frame: WORLD_FRAME,
      position: toMeters(position),
      orientation: IDENTITY_ORIENTATION,
    },
    velocity: toMetersPerSecond(velocity),
    // Platform attitude dynamics and base-motion disturbance are not modelled
    // in Phase 1. Reported as zero and documented, rather than filled with a
    // plausible-looking number nothing computed.
    angularVelocity: {
      x: radiansPerSecond(0),
      y: radiansPerSecond(0),
      z: radiansPerSecond(0),
    },
    disturbance: {
      x: radiansPerSecond(0),
      y: radiansPerSecond(0),
      z: radiansPerSecond(0),
    },
  }) satisfies GroundTruthPlatformState;

  return { state, position, velocity };
}

/**
 * True pointing of the mount at one instant.
 *
 * Supplied by the caller rather than read from configuration: the gimbal is a
 * stateful actuator now, so its angles are a result of the run rather than a
 * property of the scenario. Keeping this a parameter is what lets
 * `sampleGroundTruth` stay a pure function of its inputs.
 */
export interface GimbalPoseSample {
  /** True mechanical output, after servo dynamics and backlash. */
  readonly azimuth: Radians;
  readonly elevation: Radians;
  readonly azimuthRate: number;
  readonly elevationRate: number;
}

/** Wraps a true pointing sample in the privileged gimbal contract. */
export function gimbalStateAt(pose: GimbalPoseSample): GroundTruthGimbalState {
  return brandAsGroundTruth({
    azimuth: pose.azimuth,
    elevation: pose.elevation,
    azimuthRate: radiansPerSecond(pose.azimuthRate),
    elevationRate: radiansPerSecond(pose.elevationRate),
    boresight: {
      frame: WORLD_FRAME,
      azimuth: pose.azimuth,
      elevation: pose.elevation,
    },
  }) satisfies GroundTruthGimbalState;
}

export interface WorldSampleInput {
  readonly config: SimulationConfig;
  readonly trajectories: readonly Trajectory[];
  readonly tick: number;
  readonly timeSeconds: number;
  /** True mount pointing at `timeSeconds`, from the actuator. */
  readonly gimbalPose: GimbalPoseSample;
}

/** The complete true state of the world at one instant. */
export function sampleGroundTruth(input: WorldSampleInput): GroundTruthState {
  const { config, trajectories, tick, timeSeconds } = input;

  const platform = platformStateAt(config, timeSeconds);
  const gimbal = gimbalStateAt(input.gimbalPose);
  const halfAngles = fieldOfViewHalfAngles(config.camera);

  const boresightVector = directionFromBearing({
    azimuth: input.gimbalPose.azimuth,
    elevation: input.gimbalPose.elevation,
  });
  const boresight = vec3(boresightVector.x, boresightVector.y, boresightVector.z);

  const platformPositionMeters = toMeters(platform.position);
  const platformVelocityMps = toMetersPerSecond(platform.velocity);

  let pointingError: Radians | null = null;

  const targets = trajectories.map((trajectory, index): GroundTruthTargetState => {
    const sample: TrajectorySample = trajectory.sampleAt(timeSeconds);
    const positionMeters = toMeters(sample.position);

    const bearing = bearingTo(platformPositionMeters, positionMeters);
    const bearingRate = bearingRateTo(
      platformPositionMeters,
      platformVelocityMps,
      positionMeters,
      toMetersPerSecond(sample.velocity),
    );

    const offset = subtract(sample.position, platform.position);
    const separation = Math.hypot(offset.x, offset.y, offset.z);
    const direction = separation === 0 ? boresight : scale(offset, 1 / separation);

    // The first target is the designated one; multi-target designation is a
    // later concern.
    if (index === 0) {
      pointingError = radians(angleBetween(boresight, direction));
    }

    return brandAsGroundTruth({
      id: targetIdAt(index),
      pose: {
        frame: WORLD_FRAME,
        position: positionMeters,
        orientation: IDENTITY_ORIENTATION,
      },
      velocity: toMetersPerSecond(sample.velocity),
      bearingFromGimbal: {
        frame: WORLD_FRAME,
        azimuth: bearing.azimuth,
        elevation: bearing.elevation,
      },
      bearingRateFromGimbal: {
        frame: WORLD_FRAME,
        azimuth: bearingRate.azimuth,
        elevation: bearingRate.elevation,
      },
      range: bearing.range,
      inFieldOfView: isInsideFieldOfView(direction, boresight, halfAngles),
      // No occlusion model in Phase 1, so nothing is ever occluded. Stated as a
      // modelling assumption in docs/SIMULATION.md.
      visibility: normalized(1),
      // Received optical power needs a link budget, which Phase 1 does not
      // compute. Reporting the configured transmit power here would be a
      // different quantity wearing this field's name.
      beaconPower: null,
    }) satisfies GroundTruthTargetState;
  });

  return brandAsGroundTruth({
    tick,
    time: seconds(timeSeconds),
    platform: platform.state,
    gimbal,
    targets,
    pointingError,
  }) satisfies GroundTruthState;
}

/** Acceleration of each target at `timeSeconds`, for the debug inspector. */
export function sampleAccelerations(
  trajectories: readonly Trajectory[],
  timeSeconds: number,
): readonly { x: Meters; y: Meters; z: Meters }[] {
  return trajectories.map((trajectory) => toMeters(trajectory.sampleAt(timeSeconds).acceleration));
}
