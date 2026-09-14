/**
 * Target motion, as declared in a scenario.
 *
 * These types describe *what a target will do*, which makes them the answer key
 * for the whole experiment. They live in the contract layer because a scenario
 * has to round-trip as a single JSON document, but note what is and is not
 * reachable from here: this module declares the motion, and
 * `core/simulation/trajectory` evaluates it. The evaluator is behind the lint
 * barrier, so tracking-side code cannot turn a config into a future position
 * even if a config somehow reached it.
 *
 * See docs/adr/0003-ground-truth-isolation.md and docs/SIMULATION.md.
 */

import { z } from 'zod';

import type { Vec3 } from './geometry';
import {
  directionSchema,
  isNonZeroDirection,
  nonNegativeNumber,
  positiveNumber,
  tagged,
  vec3Schema,
} from './schema';
import type {
  Hertz,
  Meters,
  MetersPerSecond,
  MetersPerSecondSquared,
  Radians,
  RadiansPerSecond,
  Seconds,
} from './units';

/** A unitless direction in world ENU. Need not be normalised. */
export interface Direction3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** A point that never moves. */
export interface StationaryTrajectoryConfig {
  readonly kind: 'stationary';
  readonly position: Vec3<Meters>;
}

/** Constant velocity from a starting point. */
export interface LinearTrajectoryConfig {
  readonly kind: 'linear';
  readonly position: Vec3<Meters>;
  readonly velocity: Vec3<MetersPerSecond>;
}

/** Uniform circular motion in the plane through `center` with normal `planeNormal`. */
export interface CircularTrajectoryConfig {
  readonly kind: 'circular';
  readonly center: Vec3<Meters>;
  readonly radius: Meters;
  /** Signed: positive is counter-clockwise looking down the plane normal. */
  readonly angularRate: RadiansPerSecond;
  readonly planeNormal: Direction3;
  /** Phase at t = 0, measured from the plane's first basis vector. */
  readonly initialPhase: Radians;
}

/** One sinusoid added to the base motion. */
export interface SinusoidalComponentConfig {
  readonly axis: Direction3;
  readonly amplitude: Meters;
  readonly frequency: Hertz;
  readonly phase: Radians;
}

/** Constant-velocity base motion plus superimposed sinusoids. */
export interface SinusoidalTrajectoryConfig {
  readonly kind: 'sinusoidal';
  readonly position: Vec3<Meters>;
  readonly velocity: Vec3<MetersPerSecond>;
  readonly components: readonly SinusoidalComponentConfig[];
}

/** A timed node of a waypoint route. */
export interface WaypointConfig {
  readonly position: Vec3<Meters>;
  readonly arrivalTime: Seconds;
}

/**
 * A timed route, interpolated piecewise-linearly.
 *
 * Phase 1 offers exactly one interpolation model; see `WaypointTrajectory` for
 * why, and for what it means for velocity at the nodes.
 */
export interface WaypointTrajectoryConfig {
  readonly kind: 'waypoint';
  readonly waypoints: readonly WaypointConfig[];
  readonly loop: boolean;
}

/** A reproducible sequence of bounded manoeuvres, driven by the run seed. */
export interface SeededManeuverTrajectoryConfig {
  readonly kind: 'seeded-maneuver';
  readonly initialPosition: Vec3<Meters>;
  readonly initialVelocity: Vec3<MetersPerSecond>;
  readonly maxAcceleration: MetersPerSecondSquared;
  readonly maxSpeed: MetersPerSecond;
  readonly minSegmentDuration: Seconds;
  readonly maxSegmentDuration: Seconds;
  /** Distance from the origin past which manoeuvres steer back inward. */
  readonly boundsRadius: Meters;
}

/** Every motion family a Phase 1 scenario can declare. */
export type TrajectoryConfig =
  | StationaryTrajectoryConfig
  | LinearTrajectoryConfig
  | CircularTrajectoryConfig
  | SinusoidalTrajectoryConfig
  | WaypointTrajectoryConfig
  | SeededManeuverTrajectoryConfig;

export type TrajectoryConfigKind = TrajectoryConfig['kind'];

/** Every trajectory kind, for UI listings and exhaustiveness checks. */
export const TRAJECTORY_KINDS = [
  'stationary',
  'linear',
  'circular',
  'sinusoidal',
  'waypoint',
  'seeded-maneuver',
] as const;

// --- Validation -------------------------------------------------------------

const nonZeroDirection = directionSchema.refine(isNonZeroDirection, {
  error: 'Direction must have a non-zero length; a zero vector has no direction.',
});

const stationarySchema = z.strictObject({
  kind: z.literal('stationary'),
  position: vec3Schema<Meters>(),
});

const linearSchema = z.strictObject({
  kind: z.literal('linear'),
  position: vec3Schema<Meters>(),
  velocity: vec3Schema<MetersPerSecond>(),
});

const circularSchema = z.strictObject({
  kind: z.literal('circular'),
  center: vec3Schema<Meters>(),
  radius: tagged<Meters>(positiveNumber),
  angularRate: tagged<RadiansPerSecond>(z.number()),
  planeNormal: nonZeroDirection,
  initialPhase: tagged<Radians>(z.number()),
});

const sinusoidalSchema = z.strictObject({
  kind: z.literal('sinusoidal'),
  position: vec3Schema<Meters>(),
  velocity: vec3Schema<MetersPerSecond>(),
  components: z
    .array(
      z.strictObject({
        axis: nonZeroDirection,
        amplitude: tagged<Meters>(positiveNumber),
        frequency: tagged<Hertz>(positiveNumber),
        phase: tagged<Radians>(z.number()),
      }),
    )
    .min(1),
});

const waypointSchema = z
  .strictObject({
    kind: z.literal('waypoint'),
    waypoints: z
      .array(
        z.strictObject({
          position: vec3Schema<Meters>(),
          arrivalTime: tagged<Seconds>(nonNegativeNumber),
        }),
      )
      .min(2),
    loop: z.boolean(),
  })
  .refine(
    (config) =>
      config.waypoints.every(
        (waypoint, index) =>
          index === 0 || waypoint.arrivalTime > config.waypoints[index - 1]!.arrivalTime,
      ),
    {
      // A zero-duration segment demands infinite speed and a decreasing one
      // demands time travel; both are configuration mistakes, not edge cases to
      // paper over.
      error: 'Waypoint arrival times must strictly increase.',
      path: ['waypoints'],
    },
  );

const seededManeuverSchema = z
  .strictObject({
    kind: z.literal('seeded-maneuver'),
    initialPosition: vec3Schema<Meters>(),
    initialVelocity: vec3Schema<MetersPerSecond>(),
    maxAcceleration: tagged<MetersPerSecondSquared>(positiveNumber),
    maxSpeed: tagged<MetersPerSecond>(positiveNumber),
    minSegmentDuration: tagged<Seconds>(positiveNumber),
    maxSegmentDuration: tagged<Seconds>(positiveNumber),
    boundsRadius: tagged<Meters>(positiveNumber),
  })
  .refine((config) => config.minSegmentDuration <= config.maxSegmentDuration, {
    error: 'minSegmentDuration must not exceed maxSegmentDuration.',
    path: ['minSegmentDuration'],
  });

/** Runtime schema for {@link TrajectoryConfig}. */
export const trajectoryConfigSchema = z.discriminatedUnion('kind', [
  stationarySchema,
  linearSchema,
  circularSchema,
  sinusoidalSchema,
  waypointSchema,
  seededManeuverSchema,
]) satisfies z.ZodType<TrajectoryConfig, unknown>;
