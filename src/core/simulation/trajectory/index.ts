/**
 * Builds a runnable {@link Trajectory} from a declared {@link TrajectoryConfig}.
 *
 * The split matters: the config is data that round-trips through a scenario
 * file, and the trajectory is the evaluator. Only the evaluator can turn a
 * declaration into a future position, and it lives behind the ground-truth lint
 * barrier, so tracking-side code cannot perform that step (ADR-0003).
 */

import type { TrajectoryConfig } from '@/core/contracts/trajectory';

import type { RandomStream } from '../rng';
import { type Vector3, vec3 } from '../vector';
import {
  CircularTrajectory,
  LinearTrajectory,
  SinusoidalTrajectory,
  StationaryTrajectory,
  WaypointTrajectory,
} from './analytic';
import { SeededManeuverTrajectory, generateManeuverSchedule } from './seeded-maneuver';
import type { Trajectory } from './types';

export * from './types';
export * from './analytic';
export * from './seeded-maneuver';

const toVector = (v: { x: number; y: number; z: number }): Vector3 => vec3(v.x, v.y, v.z);

export interface TrajectoryBuildContext {
  /**
   * The `trajectory` random stream.
   *
   * Only the seeded manoeuvre family consumes it, and it consumes the stream
   * once at construction rather than while sampling, so building a trajectory
   * has a fixed, inspectable cost on the stream cursor.
   */
  readonly stream: RandomStream;
  /** Simulated seconds the run will cover, so a schedule can be generated to fit. */
  readonly durationSeconds: number;
}

/**
 * Constructs the evaluator for a declared trajectory.
 *
 * @throws {RangeError} for configurations the family itself rejects, such as
 * waypoints that do not advance in time.
 */
export function createTrajectory(
  config: TrajectoryConfig,
  context: TrajectoryBuildContext,
): Trajectory {
  switch (config.kind) {
    case 'stationary':
      return new StationaryTrajectory(toVector(config.position));

    case 'linear':
      return new LinearTrajectory(toVector(config.position), toVector(config.velocity));

    case 'circular':
      return new CircularTrajectory(
        toVector(config.center),
        config.radius,
        config.angularRate,
        toVector(config.planeNormal),
        config.initialPhase,
      );

    case 'sinusoidal':
      return new SinusoidalTrajectory(
        toVector(config.position),
        toVector(config.velocity),
        config.components.map((component) => ({
          axis: toVector(component.axis),
          amplitude: component.amplitude,
          frequency: component.frequency,
          phase: component.phase,
        })),
      );

    case 'waypoint':
      return new WaypointTrajectory(
        config.waypoints.map((waypoint) => ({
          position: toVector(waypoint.position),
          arrivalTime: waypoint.arrivalTime,
        })),
        config.loop,
      );

    case 'seeded-maneuver':
      return new SeededManeuverTrajectory(
        generateManeuverSchedule(context.stream, {
          initialPosition: toVector(config.initialPosition),
          initialVelocity: toVector(config.initialVelocity),
          maxAcceleration: config.maxAcceleration,
          maxSpeed: config.maxSpeed,
          minSegmentDuration: config.minSegmentDuration,
          maxSegmentDuration: config.maxSegmentDuration,
          boundsRadius: config.boundsRadius,
          duration: context.durationSeconds,
        }),
      );
  }
}
