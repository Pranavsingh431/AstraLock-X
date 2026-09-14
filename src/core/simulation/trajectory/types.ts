/**
 * What a trajectory is, in this system.
 *
 * A trajectory is a **pure function of simulated time**. It is not an object
 * that gets nudged each frame: `sampleAt(t)` must return the same state for the
 * same `t` regardless of how many times it is called, in what order, or how the
 * run reached that time. That is what lets a run be replayed, stepped
 * backwards in a future Replay view, or evaluated at a render instant between
 * two ticks without the world state depending on the renderer.
 *
 * Position, velocity and acceleration are returned together and must be
 * mutually consistent — velocity is the analytic derivative of position, not a
 * finite difference across ticks. Differencing would make the reported velocity
 * depend on the timestep and would add rate noise no real target produced.
 */

import type { Vector3 } from '../vector';

/** Instantaneous state of a moving point, in world ENU. */
export interface TrajectorySample {
  /** Metres. */
  readonly position: Vector3;
  /** Metres per second. */
  readonly velocity: Vector3;
  /** Metres per second squared. */
  readonly acceleration: Vector3;
}

/** Families implemented in Phase 1. */
export type TrajectoryKind =
  'stationary' | 'linear' | 'circular' | 'sinusoidal' | 'waypoint' | 'seeded-maneuver';

export interface Trajectory {
  readonly kind: TrajectoryKind;
  /** State at a simulated time in seconds. Pure. */
  sampleAt(timeSeconds: number): TrajectorySample;
  /**
   * Human-readable description of what this trajectory will do, for the debug
   * inspector. Derived from configuration, never from the current state.
   */
  describe(): string;
}
