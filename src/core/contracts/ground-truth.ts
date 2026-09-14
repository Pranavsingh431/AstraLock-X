/**
 * Simulator ground truth.
 *
 * Everything in this module is branded {@link GroundTruthTainted} and is
 * therefore unreachable from the tracking side, both by type and by lint rule.
 *
 * Legitimate consumers are exactly:
 *   - the simulator, which produces it;
 *   - evaluation and metrics, which score a tracker against it;
 *   - debug views explicitly labelled as ground-truth overlays in the UI.
 *
 * This module is deliberately *not* re-exported from `contracts/index.ts`. A
 * consumer has to name this file to obtain ground truth, which makes every
 * such dependency visible in a diff.
 *
 * See docs/adr/0003-ground-truth-isolation.md.
 */

import type { Bearing, BearingRate, Pose, Vec3 } from './geometry';
import type { SimulationConfig } from './simulation';
import { GROUND_TRUTH_BRAND, type GroundTruthTainted } from './isolation';
import type {
  Meters,
  MetersPerSecond,
  Normalized,
  Radians,
  RadiansPerSecond,
  Seconds,
  Watts,
} from './units';

/**
 * Simulator-assigned identity of a target.
 *
 * A tracker never receives one of these. It invents its own `TrackId` and the
 * evaluator solves the association between the two; handing the tracker a
 * `TargetId` would turn multi-target tracking into a lookup.
 */
declare const targetIdBrand: unique symbol;
export type TargetId = string & { readonly [targetIdBrand]: 'TargetId' };

/** True state of one simulated target at a single instant. */
export interface GroundTruthTargetState extends GroundTruthTainted {
  readonly id: TargetId;
  /** True pose in the world frame. */
  readonly pose: Pose;
  /** True linear velocity in the world frame. */
  readonly velocity: Vec3<MetersPerSecond>;
  /** True bearing of the target as seen from the gimbal. */
  readonly bearingFromGimbal: Bearing;
  /** True angular rate of that bearing. */
  readonly bearingRateFromGimbal: BearingRate;
  /** True slant range from the gimbal to the target. */
  readonly range: Meters;
  /** Whether the target is geometrically inside the camera field of view. */
  readonly inFieldOfView: boolean;
  /**
   * Fraction of the target that is unoccluded, on [0, 1]. Ground truth for
   * occlusion; a tracker may only infer it from the image.
   */
  readonly visibility: Normalized;
  /** Optical power arriving from the target's beacon, if it has one. */
  readonly beaconPower: Watts | null;
}

/** True state of the platform carrying the gimbal. */
export interface GroundTruthPlatformState extends GroundTruthTainted {
  readonly pose: Pose;
  readonly velocity: Vec3<MetersPerSecond>;
  readonly angularVelocity: Vec3<RadiansPerSecond>;
  /**
   * True base-motion disturbance injected at this instant, before any sensor
   * noise. This is what a stabilisation loop is fighting.
   */
  readonly disturbance: Vec3<RadiansPerSecond>;
}

/**
 * True gimbal state.
 *
 * Distinct from the `GimbalState` a tracker sees: that one is an *encoder
 * reading*, carrying quantisation, bias and latency. The difference between
 * the two is exactly what calibration and control have to cope with.
 */
export interface GroundTruthGimbalState extends GroundTruthTainted {
  readonly azimuth: Radians;
  readonly elevation: Radians;
  readonly azimuthRate: RadiansPerSecond;
  readonly elevationRate: RadiansPerSecond;
  /** True boresight direction in the world frame. */
  readonly boresight: Bearing;
}

/**
 * The complete true state of the world at one simulation tick.
 *
 * Instantaneous by construction. Future trajectory is not part of this type and
 * is not exposed anywhere a tracker could reach, so lookahead is impossible
 * rather than merely discouraged.
 */
export interface GroundTruthState extends GroundTruthTainted {
  /** Monotonic tick index from the start of the run. */
  readonly tick: number;
  /** Simulated time since the start of the run. */
  readonly time: Seconds;
  readonly platform: GroundTruthPlatformState;
  readonly gimbal: GroundTruthGimbalState;
  readonly targets: readonly GroundTruthTargetState[];
  /**
   * True angular distance between boresight and the designated target, which is
   * the primary accuracy metric for coarse PAT. `null` when no target is
   * designated.
   */
  readonly pointingError: Radians | null;
}

/**
 * The simulator's complete internal state at one tick.
 *
 * Ground truth plus everything needed to resume the run bit-for-bit: the config
 * that produced it and the cursor of every random stream. A run that is paused
 * and resumed from a `WorldState` must continue exactly as an uninterrupted run
 * would have (ADR-0004).
 *
 * Branded like the rest of this module: a `WorldState` is strictly simulator
 * property and never crosses to the tracking side.
 */
export interface WorldState extends GroundTruthTainted {
  /** The config this run was started from. */
  readonly config: SimulationConfig;
  /** True state of the world at this tick. */
  readonly truth: GroundTruthState;
  /**
   * Draw count of each named random stream, keyed by stream label. Restoring
   * these is what makes a resumed run identical to an uninterrupted one.
   */
  readonly randomStreamCursors: Readonly<Record<string, number>>;
  /** Number of camera frames emitted so far, including dropped ones. */
  readonly frameCounter: number;
}

/**
 * Attaches the ground-truth brand to a freshly constructed state object.
 *
 * The simulator builds these values as plain objects and brands them on the way
 * out, which keeps the marker in one place instead of repeated at every literal.
 */
export function brandAsGroundTruth<T extends object>(value: T): T & GroundTruthTainted {
  return Object.defineProperty(value, GROUND_TRUTH_BRAND, {
    value: true,
    // Enumerable so the brand survives structuredClone across a worker
    // boundary; non-writable so it cannot be stripped to smuggle the value
    // past the runtime check.
    enumerable: true,
    writable: false,
    configurable: false,
  }) as T & GroundTruthTainted;
}
