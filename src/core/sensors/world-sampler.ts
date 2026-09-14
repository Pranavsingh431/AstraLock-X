/**
 * Getting world state at a camera capture time.
 *
 * Capture times do not land on physics ticks. At 200 Hz physics and 60 FPS a
 * frame falls 3.33 ticks apart, so two frames in three are taken between ticks.
 * Using "whichever tick is nearest" would introduce up to 2.5 ms of timing
 * error — at 30 m/s that is 75 mm of position error, silently, in the data a
 * future tracker is scored on.
 *
 * Two policies are provided.
 *
 * **Exact** is the default and has no timing error at all. It is available
 * because Phase 1 made trajectories pure functions of time: the engine can be
 * asked for the state at 16.667 ms directly, and that is the state, not an
 * approximation of it.
 *
 * **Linear between ticks** interpolates between the two bracketing snapshots.
 * It exists for the case exact sampling cannot cover — a world whose evolution
 * depends on its own previous state, which is what a closed control loop will
 * make it — and because it bounds the error the exact path avoids. Positions
 * interpolate linearly; angles interpolate along the shortest path, so a
 * bearing crossing +/-pi does not swing the long way round.
 *
 * Sensor sampling is **not** display interpolation. The renderer blends frames
 * for smooth motion at the display's rate; this decides what the instrument
 * actually saw. They are separate, and neither is allowed to feed the other.
 *
 * See docs/SENSOR_MODEL.md.
 */

import type { WorldState } from '@/core/contracts/ground-truth';
import { type Radians, radians, wrapToPi } from '@/core/contracts/units';

import type { DynamicGimbal } from '@/core/gimbal/dynamic-gimbal';
import type { SimulationEngine } from '@/core/simulation/engine';

import { type OpticalEmitter, emittersFrom } from './emitters';
import type { Vec3Lite } from './pinhole';

/**
 * Where the camera is pointing, in both senses.
 *
 * The split is the whole of ADR-0011. Image formation uses the **true**
 * mechanical output, because that is where the lens actually is. The frame
 * reports the **measured** angle, because an encoder count is all a real system
 * gets. They differ by up to half a count, always, and a future controller has
 * to cope with that difference rather than be spared it.
 */
export interface SensorCameraPose {
  /** True mechanical output of the mount. Drives the geometry. */
  readonly trueAzimuth: number;
  readonly trueElevation: number;
  /** Encoder reading. Goes on the frame. */
  readonly measuredAzimuth: number;
  readonly measuredElevation: number;
  /** Differenced from successive encoder readings, not sensed. */
  readonly measuredAzimuthRate: number;
  readonly measuredElevationRate: number;
}

/** World state as the sensor needs it, at one instant. */
export interface SensorWorldSample {
  readonly time: number;
  /** Camera position in world ENU metres. */
  readonly cameraPosition: Vec3Lite;
  /** Where the mount is pointing, true and measured. */
  readonly cameraPose: SensorCameraPose;
  readonly emitters: readonly OpticalEmitter[];
}

export type SensorSamplingPolicy = 'exact' | 'linear-between-ticks';

export interface WorldSampler {
  readonly policy: SensorSamplingPolicy;
  sampleAt(timeSeconds: number): SensorWorldSample;
}

/**
 * Interpolates between two angles along the shorter arc.
 *
 * Interpolating 3.1 rad to -3.1 rad naively sweeps almost all the way round the
 * circle; the shortest path is the 0.08 rad step across the discontinuity. Any
 * angular quantity sampled between ticks has to use this or it will produce a
 * spurious excursion every time it crosses the branch cut.
 */
export function lerpAngleShortestPath(from: number, to: number, alpha: number): Radians {
  const delta = wrapToPi(radians(to - from));
  return wrapToPi(radians(from + delta * alpha));
}

function poseFromGimbal(gimbal: DynamicGimbal, time: number): SensorCameraPose {
  const truth = gimbal.truePointingAt(time);
  const measured = gimbal.measuredPointingAt(time);
  return {
    trueAzimuth: truth.panAngle,
    trueElevation: truth.tiltAngle,
    measuredAzimuth: measured.panAngle,
    measuredElevation: measured.tiltAngle,
    measuredAzimuthRate: measured.derivedPanRate,
    measuredElevationRate: measured.derivedTiltRate,
  };
}

function sampleFromWorld(
  world: WorldState,
  time: number,
  pose: SensorCameraPose,
): SensorWorldSample {
  const platform = world.truth.platform.pose.position;
  return {
    time,
    cameraPosition: { x: platform.x, y: platform.y, z: platform.z },
    cameraPose: pose,
    emitters: emittersFrom(
      world.config,
      world.truth.targets.map((target) => target.pose.position),
    ),
  };
}

/**
 * Evaluates the world at exactly the requested time.
 *
 * No approximation, so nothing to document about the error. Possible only while
 * the world remains a pure function of time.
 */
export class ExactWorldSampler implements WorldSampler {
  public readonly policy = 'exact' as const;

  constructor(private readonly engine: SimulationEngine) {}

  public sampleAt(timeSeconds: number): SensorWorldSample {
    const truth = this.engine.sampleAtTime(timeSeconds);
    const platform = truth.platform.pose.position;

    return {
      time: timeSeconds,
      cameraPosition: { x: platform.x, y: platform.y, z: platform.z },
      // The world is exact at this instant; the mount is interpolated from its
      // own history, because a stateful mechanism has no closed form.
      cameraPose: poseFromGimbal(this.engine.gimbal, timeSeconds),
      emitters: emittersFrom(
        this.engine.config,
        truth.targets.map((target) => target.pose.position),
      ),
    };
  }
}

/**
 * Interpolates between two bracketing snapshots.
 *
 * The approximation is second-order in the tick interval: for motion with
 * acceleration `a` sampled across an interval `h`, linear interpolation errs by
 * at most `a h^2 / 8`. At the bundled 200 Hz tick (h = 5 ms) and a manoeuvring
 * target at 6 m/s^2 that is under 19 micrometres — far below anything a camera
 * at these ranges could resolve. The bound is stated because it is the whole
 * justification for the policy being acceptable at all.
 *
 * @throws {RangeError} when asked for a time outside the bracketing pair, since
 * extrapolating would invent motion rather than approximate it.
 */
export class InterpolatingWorldSampler implements WorldSampler {
  public readonly policy = 'linear-between-ticks' as const;

  private readonly earlierTime: number;
  private readonly laterTime: number;

  constructor(
    private readonly earlier: WorldState,
    private readonly later: WorldState,
    private readonly gimbal: DynamicGimbal,
  ) {
    this.earlierTime = earlier.truth.time;
    this.laterTime = later.truth.time;
    if (this.laterTime < this.earlierTime) {
      throw new RangeError('Interpolating sampler needs snapshots in chronological order');
    }
  }

  /** Largest interval this sampler will span, for the error bound above. */
  public get intervalSeconds(): number {
    return this.laterTime - this.earlierTime;
  }

  public sampleAt(timeSeconds: number): SensorWorldSample {
    const span = this.laterTime - this.earlierTime;
    const pose = poseFromGimbal(this.gimbal, timeSeconds);
    if (span === 0) return sampleFromWorld(this.later, timeSeconds, pose);

    if (timeSeconds < this.earlierTime || timeSeconds > this.laterTime) {
      throw new RangeError(
        `Sensor sample time ${String(timeSeconds)} s lies outside the bracketing snapshots ` +
          `[${String(this.earlierTime)}, ${String(this.laterTime)}] s`,
      );
    }

    const alpha = (timeSeconds - this.earlierTime) / span;
    const a = sampleFromWorld(this.earlier, this.earlierTime, pose);
    const b = sampleFromWorld(this.later, this.laterTime, pose);

    return {
      time: timeSeconds,
      cameraPosition: lerpVec(a.cameraPosition, b.cameraPosition, alpha),
      cameraPose: pose,
      emitters: b.emitters.map((emitter, index) => {
        const before = a.emitters[index];
        return before === undefined
          ? emitter
          : { ...emitter, position: lerpVec(before.position, emitter.position, alpha) };
      }),
    };
  }
}

const lerpVec = (from: Vec3Lite, to: Vec3Lite, alpha: number): Vec3Lite => ({
  x: from.x + (to.x - from.x) * alpha,
  y: from.y + (to.y - from.y) * alpha,
  z: from.z + (to.z - from.z) * alpha,
});
