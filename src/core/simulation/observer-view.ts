/**
 * The rendering adapter.
 *
 * Turns an authoritative {@link WorldState} into numbers a renderer can draw,
 * already expressed in Three.js coordinates. This is the one place the ENU
 * convention meets the Y-up convention, and the direction of travel is strictly
 * one way: the simulation knows nothing about this module.
 *
 * The result is branded as ground truth, because that is what it is. The
 * observer view is a privileged debug view of the answer key, and branding it
 * means the runtime guard would catch it if it ever reached a tracker.
 */

import type { GroundTruthState, WorldState } from '@/core/contracts/ground-truth';
import { brandAsGroundTruth } from '@/core/contracts/ground-truth';
import { type GroundTruthTainted } from '@/core/contracts/isolation';
import { meters } from '@/core/contracts/units';

import { type RenderVec3, directionFromBearing, enuToRender } from './coordinates';
import { PLATFORM_ENTITY_ID, beaconIdAt } from './entities';
import type { SimulationEngine } from './engine';

/** One drawable entity. */
export interface ObserverEntityView {
  readonly id: string;
  readonly kind: 'target' | 'beacon' | 'platform';
  readonly label: string;
  /** Renderer coordinates, metres. */
  readonly position: RenderVec3;
  /** Renderer coordinates, metres per second. */
  readonly velocity: RenderVec3;
  /** Slant range from the observer, metres. `null` for the observer itself. */
  readonly range: number | null;
  /** Whether the target is geometrically inside the camera's field of view. */
  readonly inFieldOfView: boolean;
}

/** Everything the observer view needs for one rendered frame. */
export interface ObserverFrame extends GroundTruthTainted {
  readonly tick: number;
  /** Simulated seconds. Fractional when interpolated between ticks. */
  readonly time: number;
  readonly observer: ObserverEntityView;
  readonly targets: readonly ObserverEntityView[];
  readonly beacons: readonly ObserverEntityView[];
  /** Far end of the drawn boresight ray, in renderer coordinates. */
  readonly boresightEnd: RenderVec3;
  /** Angle between boresight and the designated target, radians. */
  readonly pointingError: number | null;
}

/** Length of the drawn boresight ray, in metres. */
const BORESIGHT_RAY_LENGTH = 1500;

function entityFromTruth(truth: GroundTruthState, index: number): ObserverEntityView {
  const target = truth.targets[index]!;
  return {
    id: target.id,
    kind: 'target',
    label: `Target ${String(index)}`,
    position: enuToRender(target.pose.position),
    velocity: enuToRender({
      x: meters(target.velocity.x),
      y: meters(target.velocity.y),
      z: meters(target.velocity.z),
    }),
    range: target.range,
    inFieldOfView: target.inFieldOfView,
  };
}

/** Builds a drawable frame from an authoritative world snapshot. */
export function buildObserverFrame(world: WorldState, labels: readonly string[]): ObserverFrame {
  const truth = world.truth;
  const platformPosition = truth.platform.pose.position;

  const observer: ObserverEntityView = {
    id: PLATFORM_ENTITY_ID,
    kind: 'platform',
    label: 'Observer',
    position: enuToRender(platformPosition),
    velocity: enuToRender({
      x: meters(truth.platform.velocity.x),
      y: meters(truth.platform.velocity.y),
      z: meters(truth.platform.velocity.z),
    }),
    range: null,
    inFieldOfView: false,
  };

  const direction = directionFromBearing(truth.gimbal.boresight);
  const boresightEnd = enuToRender({
    x: meters(platformPosition.x + direction.x * BORESIGHT_RAY_LENGTH),
    y: meters(platformPosition.y + direction.y * BORESIGHT_RAY_LENGTH),
    z: meters(platformPosition.z + direction.z * BORESIGHT_RAY_LENGTH),
  });

  const targets = truth.targets.map((_, index) => {
    const view = entityFromTruth(truth, index);
    return { ...view, label: labels[index] ?? view.label };
  });

  // The beacon marker sits at the target it belongs to. It is drawn separately
  // so the view distinguishes "where the target is" from "where its optical
  // source is", which will differ once a beacon has an offset on the body.
  const beacons = targets.map((target, index) => ({
    ...target,
    id: beaconIdAt(index),
    kind: 'beacon' as const,
    label: `${target.label} beacon`,
  }));

  return brandAsGroundTruth({
    tick: truth.tick,
    time: truth.time,
    observer,
    targets,
    beacons,
    boresightEnd,
    pointingError: truth.pointingError,
  }) satisfies ObserverFrame;
}

const lerpVec = (a: RenderVec3, b: RenderVec3, alpha: number): RenderVec3 => [
  a[0] + (b[0] - a[0]) * alpha,
  a[1] + (b[1] - a[1]) * alpha,
  a[2] + (b[2] - a[2]) * alpha,
];

function lerpEntity(
  a: ObserverEntityView,
  b: ObserverEntityView,
  alpha: number,
): ObserverEntityView {
  return {
    ...b,
    position: lerpVec(a.position, b.position, alpha),
    velocity: lerpVec(a.velocity, b.velocity, alpha),
    range: a.range === null || b.range === null ? b.range : a.range + (b.range - a.range) * alpha,
  };
}

/**
 * Blends two frames for display between ticks.
 *
 * Visualisation only. The result is never fed back into the engine, so the
 * world cannot depend on the render rate — the tests assert exactly that by
 * running the same scenario under different interpolation patterns and
 * comparing the authoritative state hash.
 *
 * `alpha` outside [0, 1] is clamped rather than extrapolated: showing a
 * position the simulation never passed through would be inventing motion.
 */
export function interpolateObserverFrame(
  previous: ObserverFrame,
  current: ObserverFrame,
  alpha: number,
): ObserverFrame {
  const a = Math.min(1, Math.max(0, alpha));

  return brandAsGroundTruth({
    tick: current.tick,
    time: previous.time + (current.time - previous.time) * a,
    observer: lerpEntity(previous.observer, current.observer, a),
    targets: current.targets.map((target, index) => {
      const before = previous.targets[index];
      return before === undefined ? target : lerpEntity(before, target, a);
    }),
    beacons: current.beacons.map((beacon, index) => {
      const before = previous.beacons[index];
      return before === undefined ? beacon : lerpEntity(before, beacon, a);
    }),
    boresightEnd: lerpVec(previous.boresightEnd, current.boresightEnd, a),
    pointingError:
      previous.pointingError === null || current.pointingError === null
        ? current.pointingError
        : previous.pointingError + (current.pointingError - previous.pointingError) * a,
  }) satisfies ObserverFrame;
}

/**
 * Polyline of each target's path over the run, in renderer coordinates.
 *
 * Computed once per scenario, not per frame: the trajectory is a pure function
 * of time, so the path does not change as the run progresses, and rebuilding it
 * every frame would be the kind of allocation churn that makes a 3D view feel
 * heavy for no reason.
 */
export function buildTrajectoryPaths(
  engine: SimulationEngine,
  sampleCount = 240,
): readonly (readonly RenderVec3[])[] {
  const duration = engine.config.duration;
  const paths: RenderVec3[][] = engine.config.targets.map(() => []);

  for (let step = 0; step <= sampleCount; step += 1) {
    const time = (duration * step) / sampleCount;
    engine.config.targets.forEach((_, index) => {
      const trajectory = engine.trajectoryAt(index);
      if (trajectory === undefined) return;
      const sample = trajectory.sampleAt(time);
      paths[index]!.push(
        enuToRender({
          x: meters(sample.position.x),
          y: meters(sample.position.y),
          z: meters(sample.position.z),
        }),
      );
    });
  }

  return paths;
}
