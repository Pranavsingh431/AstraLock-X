/**
 * The five analytic trajectory families.
 *
 * Each is a closed-form function of time with derivatives obtained by
 * differentiating the position expression, so velocity and acceleration agree
 * with position exactly rather than approximately.
 */

import { type Vector3, ZERO, add, cross, lerp, planeBasis, scale, subtract, vec3 } from '../vector';
import type { Trajectory, TrajectorySample } from './types';

/** A point that does not move. */
export class StationaryTrajectory implements Trajectory {
  public readonly kind = 'stationary' as const;

  constructor(private readonly position: Vector3) {}

  public sampleAt(): TrajectorySample {
    return { position: this.position, velocity: ZERO, acceleration: ZERO };
  }

  public describe(): string {
    const { x, y, z } = this.position;
    return `Stationary at E=${x.toFixed(1)} N=${y.toFixed(1)} U=${z.toFixed(1)} m`;
  }
}

/**
 * Constant velocity.
 *
 * ```
 *   p(t) = p0 + v0 t
 *   v(t) = v0
 *   a(t) = 0
 * ```
 */
export class LinearTrajectory implements Trajectory {
  public readonly kind = 'linear' as const;

  constructor(
    private readonly origin: Vector3,
    private readonly velocity: Vector3,
  ) {}

  public sampleAt(timeSeconds: number): TrajectorySample {
    return {
      position: add(this.origin, scale(this.velocity, timeSeconds)),
      velocity: this.velocity,
      acceleration: ZERO,
    };
  }

  public describe(): string {
    const speed = Math.hypot(this.velocity.x, this.velocity.y, this.velocity.z);
    return `Linear pass at ${speed.toFixed(1)} m/s`;
  }
}

/**
 * Uniform circular motion in an arbitrary plane.
 *
 * With `u`, `w` an orthonormal basis of the plane whose normal is `n`, and
 * `theta = phase0 + omega t`:
 *
 * ```
 *   p(t) = c + R (cos(theta) u + sin(theta) w)
 *   v(t) = R omega (-sin(theta) u + cos(theta) w)
 *   a(t) = -R omega^2 (cos(theta) u + sin(theta) w) = -omega^2 (p - c)
 * ```
 *
 * The acceleration is centripetal, as it must be: it points from the target
 * back at the centre with magnitude `omega^2 R`. The tests check that identity
 * rather than the formula, since a sign error would satisfy the formula but not
 * the physics.
 */
export class CircularTrajectory implements Trajectory {
  public readonly kind = 'circular' as const;

  private readonly u: Vector3;
  private readonly w: Vector3;

  constructor(
    private readonly center: Vector3,
    private readonly radius: number,
    private readonly angularRate: number,
    planeNormal: Vector3,
    private readonly initialPhase: number,
  ) {
    const [u, w] = planeBasis(planeNormal);
    this.u = u;
    this.w = w;
  }

  public sampleAt(timeSeconds: number): TrajectorySample {
    const theta = this.initialPhase + this.angularRate * timeSeconds;
    const cosTheta = Math.cos(theta);
    const sinTheta = Math.sin(theta);

    const radial = add(scale(this.u, cosTheta), scale(this.w, sinTheta));
    const tangential = add(scale(this.u, -sinTheta), scale(this.w, cosTheta));

    return {
      position: add(this.center, scale(radial, this.radius)),
      velocity: scale(tangential, this.radius * this.angularRate),
      acceleration: scale(radial, -this.radius * this.angularRate * this.angularRate),
    };
  }

  public describe(): string {
    const periodSeconds =
      this.angularRate === 0 ? Infinity : (2 * Math.PI) / Math.abs(this.angularRate);
    return `Circular, radius ${this.radius.toFixed(1)} m, period ${periodSeconds.toFixed(1)} s`;
  }
}

/** One sinusoidal component added to the base motion. */
export interface SinusoidalComponent {
  /** Direction the oscillation acts along. Normalised at construction. */
  readonly axis: Vector3;
  /** Peak displacement, metres. */
  readonly amplitude: number;
  /** Hertz. */
  readonly frequency: number;
  /** Radians. */
  readonly phase: number;
}

/**
 * Constant-velocity base motion plus any number of sinusoids.
 *
 * ```
 *   p(t) = p0 + v0 t + sum_i A_i sin(w_i t + phi_i) d_i     w_i = 2 pi f_i
 *   v(t) = v0        + sum_i A_i w_i cos(w_i t + phi_i) d_i
 *   a(t) =           - sum_i A_i w_i^2 sin(w_i t + phi_i) d_i
 * ```
 *
 * This is a real weaving manoeuvre, not a visual wobble applied to a rendered
 * object: the oscillation is in the authoritative state, so the velocity and
 * acceleration a tracker would eventually have to follow are present too.
 */
export class SinusoidalTrajectory implements Trajectory {
  public readonly kind = 'sinusoidal' as const;

  private readonly components: readonly (SinusoidalComponent & {
    readonly angularFrequency: number;
  })[];

  constructor(
    private readonly origin: Vector3,
    private readonly baseVelocity: Vector3,
    components: readonly SinusoidalComponent[],
  ) {
    this.components = components.map((component) => ({
      ...component,
      angularFrequency: 2 * Math.PI * component.frequency,
    }));
  }

  public sampleAt(timeSeconds: number): TrajectorySample {
    let position = add(this.origin, scale(this.baseVelocity, timeSeconds));
    let velocity = this.baseVelocity;
    let acceleration = ZERO;

    for (const component of this.components) {
      const angle = component.angularFrequency * timeSeconds + component.phase;
      const sin = Math.sin(angle);
      const cos = Math.cos(angle);
      const w = component.angularFrequency;

      position = add(position, scale(component.axis, component.amplitude * sin));
      velocity = add(velocity, scale(component.axis, component.amplitude * w * cos));
      acceleration = add(acceleration, scale(component.axis, -component.amplitude * w * w * sin));
    }

    return { position, velocity, acceleration };
  }

  public describe(): string {
    return `Sinusoidal manoeuvre, ${this.components.length} component(s)`;
  }
}

/** One node of a {@link WaypointTrajectory}. */
export interface Waypoint {
  readonly position: Vector3;
  /** Simulated time, in seconds, at which the target is at `position`. */
  readonly arrivalTime: number;
}

/**
 * Piecewise-linear interpolation between timed waypoints.
 *
 * **Interpolation model for Phase 1: piecewise linear in time.** Position is
 * continuous; velocity is constant within a segment and steps discontinuously
 * at each node; acceleration is zero everywhere except at the nodes, where it
 * is an impulse that this model reports as zero. That is a deliberate and
 * documented simplification — a smooth spline would hide the corner but invent
 * accelerations nobody specified. A future phase can add a C1 model as a second
 * interpolation option without changing this one.
 *
 * Outside the schedule the target holds the first or last waypoint with zero
 * velocity, unless `loop` is set, in which case time wraps over the schedule's
 * span.
 */
export class WaypointTrajectory implements Trajectory {
  public readonly kind = 'waypoint' as const;

  private readonly startTime: number;
  private readonly endTime: number;

  /**
   * @throws {RangeError} when fewer than two waypoints are given, or when
   * arrival times are not strictly increasing. A zero-duration segment would
   * require infinite speed, and a decreasing one would require going back in
   * time; both are configuration errors worth refusing loudly.
   */
  constructor(
    private readonly waypoints: readonly Waypoint[],
    private readonly loop: boolean,
  ) {
    if (waypoints.length < 2) {
      throw new RangeError(
        `A waypoint trajectory needs at least two waypoints, got ${waypoints.length}`,
      );
    }
    for (let index = 1; index < waypoints.length; index += 1) {
      const previous = waypoints[index - 1]!;
      const current = waypoints[index]!;
      if (!(current.arrivalTime > previous.arrivalTime)) {
        throw new RangeError(
          `Waypoint arrival times must strictly increase; waypoint ${index} arrives at ` +
            `${current.arrivalTime} s, not after ${previous.arrivalTime} s`,
        );
      }
    }
    this.startTime = waypoints[0]!.arrivalTime;
    this.endTime = waypoints[waypoints.length - 1]!.arrivalTime;
  }

  public sampleAt(timeSeconds: number): TrajectorySample {
    const span = this.endTime - this.startTime;
    let t = timeSeconds;

    if (this.loop && span > 0) {
      const offset = (timeSeconds - this.startTime) % span;
      t = this.startTime + (offset < 0 ? offset + span : offset);
    }

    if (t <= this.startTime) {
      return { position: this.waypoints[0]!.position, velocity: ZERO, acceleration: ZERO };
    }
    if (t >= this.endTime) {
      const last = this.waypoints[this.waypoints.length - 1]!;
      return { position: last.position, velocity: ZERO, acceleration: ZERO };
    }

    const index = this.segmentIndexAt(t);
    const from = this.waypoints[index]!;
    const to = this.waypoints[index + 1]!;
    const duration = to.arrivalTime - from.arrivalTime;
    const alpha = (t - from.arrivalTime) / duration;

    return {
      position: lerp(from.position, to.position, alpha),
      velocity: scale(subtract(to.position, from.position), 1 / duration),
      acceleration: ZERO,
    };
  }

  /** Index of the segment containing `t`, by binary search. */
  private segmentIndexAt(t: number): number {
    let low = 0;
    let high = this.waypoints.length - 1;
    while (low < high - 1) {
      const mid = (low + high) >> 1;
      if (this.waypoints[mid]!.arrivalTime <= t) low = mid;
      else high = mid;
    }
    return low;
  }

  public describe(): string {
    return `${this.waypoints.length} waypoints over ${(this.endTime - this.startTime).toFixed(1)} s${
      this.loop ? ', looping' : ''
    }`;
  }
}

/** Exported for the circular trajectory's tests to rebuild the plane basis. */
export const planeBasisFor = (normal: Vector3): readonly [Vector3, Vector3] => planeBasis(normal);

/** Re-exported so callers building configs do not need the vector module. */
export { vec3, cross };
