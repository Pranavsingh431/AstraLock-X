/**
 * A reproducible sequence of bounded manoeuvres.
 *
 * The point of this family is a target that is genuinely hard to follow but
 * exactly repeatable. The whole schedule is generated **up front** from the
 * trajectory random stream and then frozen, which has two consequences worth
 * stating:
 *
 *  - `sampleAt` stays a pure function of time, like every other family. It does
 *    not draw as it goes, so sampling at 3.0 s does not depend on whether 2.0 s
 *    was sampled first, and the renderer can interpolate freely between ticks.
 *  - The schedule is inspectable. It is exposed for the debug panel, so a run
 *    that went wrong can be explained rather than guessed at.
 *
 * This is not per-frame position jitter. Each segment is constant-acceleration
 * motion integrated in closed form, so velocity and acceleration are consistent
 * with position throughout, and the target obeys the acceleration and speed
 * limits it was configured with.
 */

import type { RandomStream } from '../rng';
import { type Vector3, ZERO, add, length, scale, vec3 } from '../vector';
import type { Trajectory, TrajectorySample } from './types';

/** One constant-acceleration leg. */
export interface ManeuverSegment {
  readonly index: number;
  /** Simulated seconds at which this leg begins. */
  readonly startTime: number;
  readonly duration: number;
  readonly startPosition: Vector3;
  readonly startVelocity: Vector3;
  readonly acceleration: Vector3;
}

export interface SeededManeuverOptions {
  readonly initialPosition: Vector3;
  readonly initialVelocity: Vector3;
  /** Metres per second squared, the magnitude ceiling for a leg. */
  readonly maxAcceleration: number;
  /** Speed ceiling, applied at leg boundaries. */
  readonly maxSpeed: number;
  readonly minSegmentDuration: number;
  readonly maxSegmentDuration: number;
  /**
   * Distance from the world origin past which acceleration is redirected
   * homeward, keeping a long run inside a usable volume.
   */
  readonly boundsRadius: number;
  /** Simulated seconds the schedule must cover. */
  readonly duration: number;
}

/** Draws taken per generated segment; fixed so the count is predictable. */
const DRAWS_PER_SEGMENT = 4;

/**
 * A direction uniformly distributed over the unit sphere, in two draws.
 *
 * Sampling `z` uniformly on [-1, 1] and the azimuth uniformly is exact —
 * Archimedes' theorem — unlike normalising three uniform components, which
 * clusters toward the cube's corners. Two draws with no rejection also keeps
 * the draw count per segment constant, which matters because a variable count
 * would make the stream cursor depend on the path taken.
 */
function randomDirection(stream: RandomStream): Vector3 {
  const z = stream.nextRange(-1, 1);
  const azimuth = stream.nextRange(0, 2 * Math.PI);
  const radial = Math.sqrt(Math.max(0, 1 - z * z));
  return vec3(radial * Math.cos(azimuth), radial * Math.sin(azimuth), z);
}

/** Scales `v` down to `limit` if it exceeds it. Direction is preserved. */
function clampMagnitude(v: Vector3, limit: number): Vector3 {
  const magnitude = length(v);
  return magnitude > limit && magnitude > 0 ? scale(v, limit / magnitude) : v;
}

/**
 * A generated schedule, plus the state it ends in.
 *
 * The terminal state is part of the schedule rather than something the
 * evaluator recomputes, because it is where the run coasts from once the
 * schedule is exhausted, and it must carry the same speed clamp the generator
 * applied at every other boundary.
 */
export interface ManeuverSchedule {
  readonly segments: readonly ManeuverSegment[];
  /** Simulated seconds at which the last segment ends. */
  readonly terminalTime: number;
  readonly terminalPosition: Vector3;
  readonly terminalVelocity: Vector3;
}

/**
 * Generates the manoeuvre schedule.
 *
 * Exactly {@link DRAWS_PER_SEGMENT} draws are taken per segment regardless of
 * the path the target takes, including when the homeward override replaces the
 * drawn direction. Consuming the draws either way keeps the stream cursor a
 * function of the segment count alone.
 */
export function generateManeuverSchedule(
  stream: RandomStream,
  options: SeededManeuverOptions,
): ManeuverSchedule {
  const segments: ManeuverSegment[] = [];

  let time = 0;
  let position = options.initialPosition;
  let velocity = clampMagnitude(options.initialVelocity, options.maxSpeed);
  let index = 0;

  while (time < options.duration) {
    const duration = stream.nextRange(options.minSegmentDuration, options.maxSegmentDuration);
    const drawnDirection = randomDirection(stream);
    const magnitude = stream.nextRange(0, options.maxAcceleration);

    // Outside the working volume, steer back rather than wander off. The drawn
    // direction is still consumed above so the cursor does not depend on where
    // the target happens to be.
    const distanceFromOrigin = length(position);
    const direction =
      distanceFromOrigin > options.boundsRadius && distanceFromOrigin > 0
        ? scale(position, -1 / distanceFromOrigin)
        : drawnDirection;

    const acceleration = scale(direction, magnitude);

    segments.push({
      index,
      startTime: time,
      duration,
      startPosition: position,
      startVelocity: velocity,
      acceleration,
    });

    // Closed-form integration to the end of the leg.
    position = add(
      add(position, scale(velocity, duration)),
      scale(acceleration, 0.5 * duration * duration),
    );
    velocity = clampMagnitude(add(velocity, scale(acceleration, duration)), options.maxSpeed);

    time += duration;
    index += 1;
  }

  return {
    segments,
    terminalTime: time,
    terminalPosition: position,
    terminalVelocity: velocity,
  };
}

/** Draws the schedule for `segmentCount` segments will consume. */
export const drawsForSegments = (segmentCount: number): number => segmentCount * DRAWS_PER_SEGMENT;

/**
 * Evaluates a pre-generated manoeuvre schedule.
 *
 * Within a leg the motion is `p = p0 + v0 tau + a tau^2 / 2`, so the sample is
 * exact at any time, not only at tick boundaries.
 */
export class SeededManeuverTrajectory implements Trajectory {
  public readonly kind = 'seeded-maneuver' as const;

  /** The generated schedule, exposed for the ground-truth debug inspector. */
  public readonly schedule: readonly ManeuverSegment[];

  private readonly terminal: ManeuverSchedule;

  constructor(schedule: ManeuverSchedule) {
    if (schedule.segments.length === 0) {
      throw new RangeError('A seeded manoeuvre trajectory needs at least one segment');
    }
    this.schedule = schedule.segments;
    this.terminal = schedule;
  }

  public sampleAt(timeSeconds: number): TrajectorySample {
    const first = this.schedule[0]!;
    if (timeSeconds <= 0) {
      return { position: first.startPosition, velocity: first.startVelocity, acceleration: ZERO };
    }

    // Past the end of the schedule the target coasts: position and velocity
    // stay continuous, and speed stays inside the configured ceiling. The
    // alternative — extrapolating the last leg's acceleration — is unbounded,
    // and a run that outlives its schedule would accelerate without limit.
    if (timeSeconds >= this.terminal.terminalTime) {
      const coast = timeSeconds - this.terminal.terminalTime;
      return {
        position: add(this.terminal.terminalPosition, scale(this.terminal.terminalVelocity, coast)),
        velocity: this.terminal.terminalVelocity,
        acceleration: ZERO,
      };
    }

    const segment = this.segmentAt(timeSeconds);
    const tau = timeSeconds - segment.startTime;

    return {
      position: add(
        add(segment.startPosition, scale(segment.startVelocity, tau)),
        scale(segment.acceleration, 0.5 * tau * tau),
      ),
      velocity: add(segment.startVelocity, scale(segment.acceleration, tau)),
      acceleration: segment.acceleration,
    };
  }

  /** The leg covering `t`, by binary search over start times. */
  private segmentAt(t: number): ManeuverSegment {
    let low = 0;
    let high = this.schedule.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if (this.schedule[mid]!.startTime <= t) low = mid;
      else high = mid - 1;
    }
    return this.schedule[low]!;
  }

  public describe(): string {
    return `Seeded manoeuvre, ${this.schedule.length} segments over ${this.terminal.terminalTime.toFixed(1)} s`;
  }
}
