/**
 * The virtual camera.
 *
 * Turns the authoritative world into timestamped pixel buffers. It is plain
 * TypeScript: no Three.js, no WebGL, no canvas, no DOM. A browser canvas may
 * *display* what this produces; it must never be what *creates* it, because a
 * result that only exists inside a GPU readback cannot be produced by a test,
 * a worker, or a headless benchmark run — and those are the places the sensor
 * has to work (ADR-0009).
 *
 * **Privileged.** It consumes world state, so it sits behind the ground-truth
 * barrier. What it emits is split deliberately in two: a `CameraSensorFrame`,
 * which contains only what a real device could hand you, and a
 * `SensorEvaluationTruth`, which contains the answer key and is branded so it
 * cannot reach a tracker.
 *
 * See docs/SENSOR_MODEL.md.
 */

import type { GroundTruthTainted } from '@/core/contracts/isolation';
import { brandAsGroundTruth } from '@/core/contracts/ground-truth';
import type { CameraSensorFrame, PixelFormat } from '@/core/contracts/sensors';
import type { SimulationConfig } from '@/core/contracts/simulation';
import {
  type Meters,
  type Radians,
  meters,
  pixels,
  radians,
  seconds,
} from '@/core/contracts/units';

import { CameraClock } from './camera-clock';
import { FrameBufferPool } from './frame-pool';
import { type CameraMount, IdealCameraMount } from './mount';
import { type ResolvedIntrinsics, cameraBasis, projectPoint, resolveIntrinsics } from './pinhole';
import { addGaussianPointSource, fillBackground, type RasterTarget } from './psf';
import {
  type EmitterProjectionTruth,
  type SensorEvaluationTruth,
  brandProjectionTruth,
  brandSensorTruth,
} from './sensor-truth';
import type { SensorWorldSample, WorldSampler } from './world-sampler';

/**
 * One capture: the device's output and the simulator's record of it.
 *
 * Branded as ground truth *as a pair*, because it contains the truth half.
 * `capture.frame` on its own is clean and is what a tracker is given; the type
 * system rejects any attempt to hand a plugin the pair.
 */
export interface SensorCapture extends GroundTruthTainted {
  readonly frame: CameraSensorFrame;
  readonly truth: SensorEvaluationTruth;
}

/** Largest value each supported format can hold. */
const FORMAT_MAX_VALUE: Record<PixelFormat, number> = { mono8: 255, mono16: 65535 };

export interface VirtualCameraOptions {
  readonly config: SimulationConfig;
  /** Defaults to an {@link IdealCameraMount} at the configured initial pose. */
  readonly mount?: CameraMount;
  /** Frames that may be in flight before a pixel buffer is reused. */
  readonly poolCapacity?: number;
}

/** What happened to the frames due in an interval. */
export interface LatestCaptureResult {
  /** The newest frame due, or `null` when none was. */
  readonly capture: SensorCapture | null;
  /**
   * Frames the camera scheduled but this call did not rasterize, because a
   * newer one was already due.
   *
   * These are **not** dropped camera frames. The camera would have produced
   * them; the display consumer chose not to build pixels it would immediately
   * discard. Calling that a sensor dropout would misattribute a UI decision to
   * the instrument.
   */
  readonly supersededForDisplay: number;
}

export class VirtualCameraSensor {
  public readonly config: SimulationConfig;
  public readonly clock: CameraClock;
  public readonly intrinsics: ResolvedIntrinsics;
  public readonly mount: CameraMount;
  /** Identifies the optical configuration, carried on every frame. */
  public readonly cameraConfigId: string;

  private readonly pool: FrameBufferPool;
  private readonly format: PixelFormat;
  private readonly maxValue: number;
  private readonly backgroundValue: number;

  private scheduled = 0;
  private rasterized = 0;
  private superseded = 0;

  /**
   * @throws {RangeError} for an unsupported pixel format, or a camera
   * configuration the pinhole model cannot resolve.
   */
  constructor(options: VirtualCameraOptions) {
    const camera = options.config.camera;

    if (camera.format !== 'mono8') {
      // GRAY8 is the authoritative Phase 2 format. mono16 is declared in the
      // contract and will be supported when something needs the extra range;
      // pretending to support it now would mean emitting 8-bit data in a
      // 16-bit buffer.
      throw new RangeError(
        `Phase 2 renders mono8 (GRAY8) only; scenario requested "${camera.format}"`,
      );
    }

    this.config = options.config;
    this.format = camera.format;
    this.maxValue = FORMAT_MAX_VALUE[camera.format];
    this.backgroundValue = camera.backgroundLevel * this.maxValue;
    this.intrinsics = resolveIntrinsics(camera);
    this.clock = new CameraClock(camera.frameRate);
    this.mount =
      options.mount ?? new IdealCameraMount(camera.initialAzimuth, camera.initialElevation);
    this.cameraConfigId = `${options.config.id}@v${String(options.config.schemaVersion)}`;
    this.pool = new FrameBufferPool(
      this.intrinsics.width * this.intrinsics.height,
      options.poolCapacity ?? 3,
    );
  }

  /** Frames the camera clock has called for. */
  public get framesScheduled(): number {
    return this.scheduled;
  }

  /** Frames actually turned into pixels. */
  public get framesRasterized(): number {
    return this.rasterized;
  }

  /** Scheduled frames skipped by {@link captureLatest}. Not sensor dropouts. */
  public get framesSupersededForDisplay(): number {
    return this.superseded;
  }

  /** Pixel buffers allocated. Bounded by the pool's capacity. */
  public get buffersAllocated(): number {
    return this.pool.allocated;
  }

  /** Clears counters and returns the mount to its configured pose. */
  public reset(): void {
    this.scheduled = 0;
    this.rasterized = 0;
    this.superseded = 0;
    this.mount.reset();
  }

  /**
   * Rasterizes every frame due in `(afterTime, throughTime]`.
   *
   * The caller receives each capture through `onCapture` rather than as an
   * array, because a long headless interval can schedule thousands of frames
   * and materialising them all would be gigabytes. The caller decides what to
   * keep, and a pixel buffer stays valid only until the pool wraps.
   *
   * @returns the number of frames rasterized.
   */
  public captureRange(
    sampler: WorldSampler,
    afterTime: number,
    throughTime: number,
    onCapture: (capture: SensorCapture) => void,
  ): number {
    const range = this.clock.framesBetween(afterTime, throughTime);
    this.scheduled += range.count;

    for (let index = range.first; index <= range.last; index += 1) {
      onCapture(this.captureFrame(sampler, index));
    }
    return range.count;
  }

  /**
   * Rasterizes only the newest frame due in `(afterTime, throughTime]`.
   *
   * The live-display policy. A viewer can only look at the most recent image,
   * so building the ones behind it would cost time and memory to produce
   * something immediately discarded — and would let a slow consumer accumulate
   * an unbounded backlog. Older frames are counted as superseded, which is a
   * display decision and is reported as one.
   */
  public captureLatest(
    sampler: WorldSampler,
    afterTime: number,
    throughTime: number,
  ): LatestCaptureResult {
    const range = this.clock.framesBetween(afterTime, throughTime);
    this.scheduled += range.count;

    if (range.count === 0) return { capture: null, supersededForDisplay: 0 };

    const skipped = range.count - 1;
    this.superseded += skipped;
    return { capture: this.captureFrame(sampler, range.last), supersededForDisplay: skipped };
  }

  /** Rasterizes one specific frame index. */
  public captureFrame(sampler: WorldSampler, frameIndex: number): SensorCapture {
    const captureTime = this.clock.captureTime(frameIndex);
    const sample = sampler.sampleAt(captureTime);
    return this.rasterize(frameIndex, captureTime, sample);
  }

  private rasterize(
    frameIndex: number,
    captureTime: number,
    sample: SensorWorldSample,
  ): SensorCapture {
    const { width, height } = this.intrinsics;
    const data = this.pool.acquire();

    const target: RasterTarget = { data, width, height, maxValue: this.maxValue };
    fillBackground(target, this.backgroundValue);

    const pose = this.mount.pose();
    const basis = cameraBasis(pose.azimuth, pose.elevation);
    const projections: EmitterProjectionTruth[] = [];

    for (const emitter of sample.emitters) {
      const relative = {
        x: emitter.position.x - sample.cameraPosition.x,
        y: emitter.position.y - sample.cameraPosition.y,
        z: emitter.position.z - sample.cameraPosition.z,
      };
      const projection = projectPoint(relative, basis, this.intrinsics);

      let pixelsWritten = 0;
      let peakIntensity = 0;

      if (
        projection.visibility === 'visible' &&
        projection.imageX !== null &&
        projection.imageY !== null
      ) {
        peakIntensity = emitter.intensity * this.maxValue;
        pixelsWritten = addGaussianPointSource(
          target,
          projection.imageX,
          projection.imageY,
          peakIntensity,
          emitter.psfSigma,
        );
      }

      // Offsets from the boresight, for checking the geometry from outside.
      const offsetAzimuth = Math.atan2(projection.cameraX, projection.cameraZ);
      const offsetElevation = Math.atan2(
        projection.cameraY,
        Math.hypot(projection.cameraX, projection.cameraZ),
      );

      projections.push(
        brandProjectionTruth({
          emitterId: emitter.id,
          hostEntityId: emitter.hostEntityId,
          visibility: projection.visibility,
          imageX: projection.imageX,
          imageY: projection.imageY,
          range: meters(projection.range),
          offsetAzimuth: radians(offsetAzimuth),
          offsetElevation: radians(offsetElevation),
          peakIntensity,
          pixelsWritten,
        }),
      );
    }

    this.rasterized += 1;

    const frame: CameraSensorFrame = {
      frameId: frameIndex,
      captureTime: seconds(captureTime),
      width: pixels(width),
      height: pixels(height),
      format: this.format,
      data,
      exposure: this.config.camera.exposure,
      gain: this.config.camera.gain,
      // No sensor dropout model in Phase 2, so no frame is ever dropped by the
      // sensor. Reported as null rather than fabricated.
      droppedSince: null,
      pose: { azimuth: pose.azimuth, elevation: pose.elevation },
      cameraConfigId: this.cameraConfigId,
    };

    const truth = brandSensorTruth({
      frameId: frameIndex,
      captureTime: seconds(captureTime),
      cameraAzimuth: pose.azimuth,
      cameraElevation: pose.elevation,
      cameraPositionEast: meters(sample.cameraPosition.x),
      cameraPositionNorth: meters(sample.cameraPosition.y),
      cameraPositionUp: meters(sample.cameraPosition.z),
      projections,
    });

    return brandAsGroundTruth({ frame, truth });
  }
}

/** Copies a frame's pixels, for a consumer that needs to outlive the pool. */
export function copyFramePixels(frame: CameraSensorFrame): Uint8Array {
  return new Uint8Array(frame.data as Uint8Array);
}

/** Convenience accessors for the branded angles on a frame's pose. */
export type FramePoseAzimuth = Radians;
export type FrameCameraPosition = Meters;
