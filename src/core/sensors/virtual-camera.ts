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
import { integratedLevel } from '@/core/contracts/code-waveform';
import { DisturbanceStack, type FrameDisturbance } from '@/core/disturbance';
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
import { type ResolvedIntrinsics, cameraBasis, projectPoint, resolveIntrinsics } from './pinhole';
import {
  addGaussianPointSource,
  addGaussianPointSourceFloat,
  energyPreservingPeak,
  fillBackground,
  type FloatRasterTarget,
  type RasterTarget,
} from './psf';
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
  /**
   * The frame, valid until {@link release}.
   *
   * A getter rather than a field: reading it after release throws instead of
   * handing back pixels the pool has since overwritten. That turns the one
   * failure mode of a buffer pool — a silent data race with an asynchronous
   * consumer — into an immediate, local error.
   *
   * @throws {FrameLeaseError} once released.
   */
  readonly frame: CameraSensorFrame;
  readonly truth: SensorEvaluationTruth;
  /** Whether the pixel buffer has gone back to the pool. */
  readonly isReleased: boolean;
  /** Returns the pixel buffer to the pool. Safe to call more than once. */
  release(): void;
  /**
   * A copy that owns its pixels and outlives the lease.
   *
   * The escape hatch for anything that needs to keep a frame — a recorder, or
   * an asynchronous perception stage. The copy costs one allocation, which is
   * the honest price of persistence and is paid knowingly rather than
   * discovered later as corruption.
   */
  toOwned(): CameraSensorFrame;
}

/** Largest value each supported format can hold. */
const FORMAT_MAX_VALUE: Record<PixelFormat, number> = { mono8: 255, mono16: 65535 };

export interface VirtualCameraOptions {
  readonly config: SimulationConfig;
  /** Frames that may be leased at once before the pool refuses. */
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
  /**
   * Scheduled frames the *sensor* failed to deliver.
   *
   * Categorically different from `supersededForDisplay` above: that is the
   * display declining to build pixels it would throw away, this is the
   * instrument not producing a frame at all. A dropped frame has no pixels, no
   * truth record and no consumer.
   */
  readonly dropped: number;
}

export class VirtualCameraSensor {
  public readonly config: SimulationConfig;
  public readonly clock: CameraClock;
  public readonly intrinsics: ResolvedIntrinsics;
  /** Identifies the optical configuration, carried on every frame. */
  public readonly cameraConfigId: string;

  private readonly pool: FrameBufferPool;
  private readonly format: PixelFormat;
  private readonly maxValue: number;
  private readonly backgroundValue: number;

  private scheduled = 0;
  private rasterized = 0;
  private superseded = 0;
  private dropped = 0;

  /**
   * The disturbances acting on this run, or `null` for none.
   *
   * `null` and a clean stack are treated identically and both take the
   * pre-Phase-7 image formation path.
   */
  private readonly disturbances: DisturbanceStack | null;
  /**
   * The stack, clean or not.
   *
   * Kept separately from `disturbances` because a scenario can need the
   * integrating renderer without having any disturbance at all: a coded beacon
   * alone is enough. A clean stack contributes nothing to a frame, and asking
   * it for a transmittance or a base attitude returns the identity.
   */
  private readonly stack: DisturbanceStack;
  /** Whether this run renders through the integrating path. */
  private readonly integrating: boolean;
  /**
   * Accumulation buffer for the disturbed path, allocated once.
   *
   * Only built when something can actually write to it: a clean run never
   * allocates it, so turning disturbances off costs neither time nor memory.
   */
  private readonly accumulator: Float64Array | null;
  /** The realization of the most recently rasterized frame. */
  private lastRealization: FrameDisturbance | null = null;

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
    this.cameraConfigId = `${options.config.id}@v${String(options.config.schemaVersion)}`;
    this.pool = new FrameBufferPool(
      this.intrinsics.width * this.intrinsics.height,
      options.poolCapacity ?? 3,
    );

    const stack = new DisturbanceStack(
      options.config.disturbances,
      options.config.seed,
      camera.frameRate,
    );
    this.stack = stack;

    // A modulated beacon needs the integrating path whatever the weather:
    // reporting the code's level at one instant would be a sample the camera
    // never took, and at the default timing an exposure can straddle a symbol
    // boundary. So the presence of a code is, by itself, a reason to integrate.
    const coded = options.config.targets.some(
      (target) => target.beacon?.identityCode?.enabled === true,
    );
    this.disturbances = stack.isClean ? null : stack;
    this.integrating = !stack.isClean || coded;
    this.accumulator = this.integrating
      ? new Float64Array(this.intrinsics.width * this.intrinsics.height)
      : null;
  }

  /**
   * The disturbance realization of the last frame rasterized, or `null`.
   *
   * **Privileged.** This is the answer key: the true base attitude, the true
   * apparent beacon displacement and the true scintillation gain. It is read by
   * the evaluator and by debug views, never by an algorithm.
   */
  public get lastDisturbance(): FrameDisturbance | null {
    return this.lastRealization;
  }

  /** Whether any disturbance is active on this run. */
  public get hasDisturbances(): boolean {
    return this.disturbances !== null;
  }

  /** The derived seed of each disturbance stream, for the experiment record. */
  public disturbanceStreamSeeds(): Record<string, number> {
    return this.disturbances?.streamSeeds() ?? {};
  }

  /** Frames the sensor failed to deliver. Never counted as generated. */
  public get framesDropped(): number {
    return this.dropped;
  }

  /**
   * Whether the sensor will fail to deliver a scheduled frame.
   *
   * Exposed so the runtime can account for a loss without rasterizing pixels
   * nobody will ever see.
   */
  public isFrameDropped(frameIndex: number): boolean {
    return this.disturbances?.isDroppedAt(frameIndex) ?? false;
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

  /**
   * Clears counters and reclaims every outstanding lease.
   *
   * Reclaiming matters: a run torn down mid-capture must not leave the pool
   * permanently exhausted, and chasing down every holder is exactly the
   * bookkeeping the lease exists to avoid.
   */
  public reset(): void {
    this.scheduled = 0;
    this.rasterized = 0;
    this.superseded = 0;
    this.dropped = 0;
    this.lastRealization = null;
    this.disturbances?.reset();
    this.pool.releaseAll();
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
      // A dropped frame is not rasterized, not delivered and not counted as
      // generated. The consumer simply never hears about it, which is exactly
      // what a camera that failed to produce a frame gives you.
      if (this.disturbances?.isDroppedAt(index) === true) {
        this.dropped += 1;
        this.lastRealization = this.disturbances.realizationAt(
          index,
          this.clock.captureTime(index),
        );
        continue;
      }
      const capture = this.captureFrame(sampler, index);
      try {
        onCapture(capture);
      } finally {
        // Borrowed for the callback only. A consumer that wants to keep the
        // frame calls toOwned(); releasing here is what keeps a long headless
        // interval from exhausting the pool on its second frame.
        capture.release();
      }
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

    if (range.count === 0) return { capture: null, supersededForDisplay: 0, dropped: 0 };

    const skipped = range.count - 1;
    this.superseded += skipped;

    if (this.disturbances?.isDroppedAt(range.last) === true) {
      this.dropped += 1;
      this.lastRealization = this.disturbances.realizationAt(
        range.last,
        this.clock.captureTime(range.last),
      );
      return { capture: null, supersededForDisplay: skipped, dropped: 1 };
    }

    return {
      capture: this.captureFrame(sampler, range.last),
      supersededForDisplay: skipped,
      dropped: 0,
    };
  }

  /**
   * Rasterizes one specific frame index.
   *
   * Dispatches on whether anything can actually change a pixel. The clean path
   * is the pre-Phase-7 renderer, unchanged and byte-for-byte: "disturbances off"
   * therefore means *exactly* Phase 6 rather than a numerically similar
   * approximation of it, which is what lets every Phase 0-6 regression stay
   * pinned to its original values.
   */
  public captureFrame(sampler: WorldSampler, frameIndex: number): SensorCapture {
    const captureTime = this.clock.captureTime(frameIndex);
    if (!this.integrating) {
      return this.rasterize(frameIndex, captureTime, sampler.sampleAt(captureTime));
    }
    return this.rasterizeDisturbed(sampler, frameIndex, captureTime, this.stack);
  }

  private rasterize(
    frameIndex: number,
    captureTime: number,
    sample: SensorWorldSample,
  ): SensorCapture {
    const { width, height } = this.intrinsics;
    const lease = this.pool.acquire();
    const data = lease.pixels;

    const target: RasterTarget = { data, width, height, maxValue: this.maxValue };
    fillBackground(target, this.backgroundValue);

    // Geometry uses the TRUE mechanical output: that is where the lens is.
    // The frame will report the measured angle instead (ADR-0011).
    const pose = sample.cameraPose;
    const basis = cameraBasis(pose.trueAzimuth, pose.trueElevation);
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
          // No wander on a clean run, so where the light landed and where the
          // emitter is are the same point.
          apparentImageX: projection.imageX,
          apparentImageY: projection.imageY,
          range: meters(projection.range),
          offsetAzimuth: radians(offsetAzimuth),
          offsetElevation: radians(offsetElevation),
          peakIntensity,
          // The clean path never renders a coded emitter: a code forces the
          // integrating path, so anything reaching here is steady.
          emittedLevel: 1,
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
      // What the encoder reports, not where the mount really is.
      pose: {
        azimuth: radians(pose.measuredAzimuth),
        elevation: radians(pose.measuredElevation),
      },
      cameraConfigId: this.cameraConfigId,
    };

    const truth = brandSensorTruth({
      frameId: frameIndex,
      captureTime: seconds(captureTime),
      cameraAzimuth: radians(pose.trueAzimuth),
      cameraElevation: radians(pose.trueElevation),
      cameraPositionEast: meters(sample.cameraPosition.x),
      cameraPositionNorth: meters(sample.cameraPosition.y),
      cameraPositionUp: meters(sample.cameraPosition.z),
      disturbance: null,
      projections,
    });

    return brandAsGroundTruth({
      get frame(): CameraSensorFrame {
        // Touching the lease is what throws once released; the frame object
        // itself is inert, so the check has to happen on the way to it.
        void lease.pixels;
        return frame;
      },
      truth,
      get isReleased(): boolean {
        return lease.isReleased;
      },
      release(): void {
        lease.release();
      },
      toOwned(): CameraSensorFrame {
        return { ...frame, data: new Uint8Array(lease.pixels) };
      },
    });
  }

  /**
   * Rasterizes one frame through the disturbance pipeline.
   *
   * The order below is the physical one and is not interchangeable — see
   * docs/DISTURBANCE_MODEL.md. Light is collected over the exposure first, then
   * ambient background is added to it, then the sensor's noise is applied to the
   * total, and only then is the result clipped and quantised. Quantising earlier
   * would round the same photon budget several times; adding noise earlier would
   * put it through the optics.
   */
  private rasterizeDisturbed(
    sampler: WorldSampler,
    frameIndex: number,
    captureTime: number,
    disturbances: DisturbanceStack,
  ): SensorCapture {
    const { width, height } = this.intrinsics;
    const accumulator = this.accumulator!;

    // Background first, as the initial value of the accumulator rather than a
    // second pass over it. The camera's own pedestal and the ambient sky are
    // both constant over the exposure, so integrating them is the same as
    // starting from them — and it saves a full clear of three hundred thousand
    // doubles every frame.
    disturbances.fillBackground(accumulator, width, height, this.maxValue, this.backgroundValue);

    const realization = disturbances.realizationAt(frameIndex, captureTime);
    this.lastRealization = realization;

    // The exposure window is centred on the capture instant, so the frame's
    // timestamp is its mid-exposure time. Centring is what keeps a blurred
    // centroid at the target's position *at* the timestamp: an exposure running
    // [t, t+T] would put it half an exposure behind, which every evaluation
    // comparing a detection against truth at t would then read as pointing bias.
    const exposure = this.config.camera.exposure;
    const subSamples = disturbances.subSamples;
    const windowStart = captureTime - exposure / 2;
    const subStep = exposure / subSamples;

    // Wander displaces where the beacon *appears* to come from. A beacon that
    // appears further round in azimuth is geometrically identical to a camera
    // pointed further back, so it is applied by subtracting it from the optical
    // axis used for projection. The recorded truth keeps the two separate: the
    // camera axis it stores excludes wander entirely.
    const wander = realization.wander;

    const target: FloatRasterTarget = { data: accumulator, width, height };
    const pixelsWritten = new Map<string, number>();
    const attenuatedPeak = new Map<string, number>();

    // The sample at the capture instant is the one the truth record describes.
    let centreSample = sampler.sampleAt(captureTime);

    for (let step = 0; step < subSamples; step += 1) {
      // Midpoint of each sub-interval. With one sub-sample this is exactly the
      // capture instant, so an exposure of one sample reproduces instantaneous
      // capture rather than merely approximating it.
      const subStart = windowStart + subStep * step;
      const subEnd = subStart + subStep;
      const subTime = subStart + subStep / 2;
      const sample = subSamples === 1 ? centreSample : sampler.sampleAt(subTime);
      if (subSamples > 1 && step === Math.floor(subSamples / 2)) centreSample = sample;

      // Base attitude is evaluated at the sub-sample time, so platform vibration
      // during the exposure produces real blur rather than a rigid shift.
      const base = disturbances.baseAttitudeAt(subTime, frameIndex);
      const basis = cameraBasis(
        radians(sample.cameraPose.trueAzimuth + base.azimuth - wander.azimuth),
        radians(sample.cameraPose.trueElevation + base.elevation - wander.elevation),
      );

      for (const emitter of sample.emitters) {
        const relative = {
          x: emitter.position.x - sample.cameraPosition.x,
          y: emitter.position.y - sample.cameraPosition.y,
          z: emitter.position.z - sample.cameraPosition.z,
        };
        const projection = projectPoint(relative, basis, this.intrinsics);
        if (
          projection.visibility !== 'visible' ||
          projection.imageX === null ||
          projection.imageY === null
        ) {
          continue;
        }

        // The code's contribution is the **integral** of its level over this
        // sub-interval, not its value at the midpoint. With a single sub-sample
        // that interval is the whole exposure, so the exposure integral is
        // exact rather than approximated; with several, each one carries its own
        // exact share and the code is correctly weighted against the motion
        // blur that the sub-sampling is there to produce.
        // Nullish, not strictly null: a source with no code field and one with
        // an explicit null are the same physical thing, an unmodulated emitter,
        // and there is no third reading to preserve.
        const codeLevel =
          emitter.code == null ? 1 : integratedLevel(emitter.code, subStart, subEnd);

        // Radiometry: what survives the path, and how that varies in time.
        const transmittance = disturbances.transmittanceOver(projection.range);
        const intensity = emitter.intensity * codeLevel * transmittance * realization.scintillation;

        // Defocus spreads the same energy over a wider spot, so the peak falls
        // as sigma^2 rises and the integral is unchanged.
        const spread = disturbances.spreadFor(emitter.psfSigma);
        const peak = energyPreservingPeak(intensity * this.maxValue, emitter.psfSigma, spread);

        const written = addGaussianPointSourceFloat(
          target,
          projection.imageX,
          projection.imageY,
          // Each sub-sample carries its share of the exposure's light, so the
          // total collected is independent of how finely it was sampled.
          peak / subSamples,
          spread,
        );
        pixelsWritten.set(emitter.id, (pixelsWritten.get(emitter.id) ?? 0) + written);
        attenuatedPeak.set(emitter.id, Math.max(attenuatedPeak.get(emitter.id) ?? 0, peak));
      }
    }

    const lease = this.pool.acquire();
    this.quantise(accumulator, lease.pixels, disturbances, frameIndex);

    // Truth is described at the capture instant, with the true optical axis —
    // which includes base attitude, because the platform really does move the
    // camera, and excludes wander, because wander does not.
    const pose = centreSample.cameraPose;
    const truthBase = disturbances.baseAttitudeAt(captureTime, frameIndex);
    const opticalAzimuth = pose.trueAzimuth + truthBase.azimuth;
    const opticalElevation = pose.trueElevation + truthBase.elevation;
    const geometricBasis = cameraBasis(radians(opticalAzimuth), radians(opticalElevation));
    const apparentBasis = cameraBasis(
      radians(opticalAzimuth - wander.azimuth),
      radians(opticalElevation - wander.elevation),
    );

    const projections: EmitterProjectionTruth[] = [];
    for (const emitter of centreSample.emitters) {
      const relative = {
        x: emitter.position.x - centreSample.cameraPosition.x,
        y: emitter.position.y - centreSample.cameraPosition.y,
        z: emitter.position.z - centreSample.cameraPosition.z,
      };
      const geometric = projectPoint(relative, geometricBasis, this.intrinsics);
      const apparent = projectPoint(relative, apparentBasis, this.intrinsics);

      projections.push(
        brandProjectionTruth({
          emitterId: emitter.id,
          hostEntityId: emitter.hostEntityId,
          visibility: geometric.visibility,
          imageX: geometric.imageX,
          imageY: geometric.imageY,
          apparentImageX: apparent.imageX,
          apparentImageY: apparent.imageY,
          range: meters(geometric.range),
          offsetAzimuth: radians(Math.atan2(geometric.cameraX, geometric.cameraZ)),
          offsetElevation: radians(
            Math.atan2(geometric.cameraY, Math.hypot(geometric.cameraX, geometric.cameraZ)),
          ),
          peakIntensity: attenuatedPeak.get(emitter.id) ?? 0,
          emittedLevel:
            emitter.code == null
              ? 1
              : integratedLevel(
                  emitter.code,
                  captureTime - exposure / 2,
                  captureTime + exposure / 2,
                ),
          pixelsWritten: pixelsWritten.get(emitter.id) ?? 0,
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
      data: lease.pixels,
      exposure: this.config.camera.exposure,
      gain: this.config.camera.gain,
      // Frames the sensor failed to deliver, cumulative. A delivered frame can
      // say how many went missing before it; it cannot describe one that does
      // not exist, and a dropped frame is never handed to anyone.
      droppedSince: this.dropped,
      // Still the encoder's reading, which measures the gimbal axes only. Base
      // attitude is absent from it on purpose: without a separate attitude
      // reference a real terminal cannot measure how its own mounting moved.
      pose: {
        azimuth: radians(pose.measuredAzimuth),
        elevation: radians(pose.measuredElevation),
      },
      cameraConfigId: this.cameraConfigId,
    };

    const truth = brandSensorTruth({
      frameId: frameIndex,
      captureTime: seconds(captureTime),
      cameraAzimuth: radians(opticalAzimuth),
      cameraElevation: radians(opticalElevation),
      cameraPositionEast: meters(centreSample.cameraPosition.x),
      cameraPositionNorth: meters(centreSample.cameraPosition.y),
      cameraPositionUp: meters(centreSample.cameraPosition.z),
      disturbance: realization,
      projections,
    });

    return brandAsGroundTruth({
      get frame(): CameraSensorFrame {
        void lease.pixels;
        return frame;
      },
      truth,
      get isReleased(): boolean {
        return lease.isReleased;
      },
      release(): void {
        lease.release();
      },
      toOwned(): CameraSensorFrame {
        return { ...frame, data: new Uint8Array(lease.pixels) };
      },
    });
  }

  /**
   * Applies sensor noise, then clips and quantises.
   *
   * Noise is added to the accumulated intensity, never to the quantised result:
   * a sensor's noise is in its signal chain, not in its analogue-to-digital
   * converter. Shot noise comes first because it is a property of the light that
   * arrived, read noise second because it is a property of the electronics that
   * measured it, and the clip is last because saturation is what the well does
   * to whatever reached it.
   *
   * Clipping is a clamp, never a wrap. A wrapped overflow turns the brightest
   * pixel in the image into the darkest, which is invisible in a thumbnail and
   * fatal to a detector.
   */
  private quantise(
    accumulator: Float64Array,
    out: Uint8Array,
    disturbances: DisturbanceStack,
    frameIndex: number,
  ): void {
    const maxValue = this.maxValue;
    const shotScale = disturbances.shotNoiseScale;
    const readSigma = disturbances.readNoiseSigma;
    const length = accumulator.length;

    // Three specialised loops rather than one with branches inside it. This runs
    // three hundred thousand times a frame at sixty frames a second, so a
    // predictable branch per pixel is not free, and the shapes are different
    // enough that one loop cannot be fast for all of them.

    if (shotScale <= 0 && readSigma <= 0) {
      for (let index = 0; index < length; index += 1) {
        const value = accumulator[index]!;
        out[index] = value <= 0 ? 0 : value >= maxValue ? maxValue : (value + 0.5) | 0;
      }
      return;
    }

    // Each frame's noise field is seeded from the frame index, so it is the same
    // field whether the frame was rendered in a headless sweep or skipped to in
    // a live view.
    if (shotScale > 0 && readSigma > 0) {
      const shot = disturbances.shotNoiseFor(frameIndex);
      const read = disturbances.readNoiseFor(frameIndex);
      for (let index = 0; index < length; index += 1) {
        const signal = accumulator[index]!;
        const value =
          signal +
          shotScale * Math.sqrt(signal > 0 ? signal : 0) * shot.nextGaussian() +
          readSigma * read.nextGaussian();
        out[index] = value <= 0 ? 0 : value >= maxValue ? maxValue : (value + 0.5) | 0;
      }
      return;
    }

    if (shotScale > 0) {
      const shot = disturbances.shotNoiseFor(frameIndex);
      for (let index = 0; index < length; index += 1) {
        const signal = accumulator[index]!;
        const value = signal + shotScale * Math.sqrt(signal > 0 ? signal : 0) * shot.nextGaussian();
        out[index] = value <= 0 ? 0 : value >= maxValue ? maxValue : (value + 0.5) | 0;
      }
      return;
    }

    const read = disturbances.readNoiseFor(frameIndex);
    for (let index = 0; index < length; index += 1) {
      const value = accumulator[index]! + readSigma * read.nextGaussian();
      out[index] = value <= 0 ? 0 : value >= maxValue ? maxValue : (value + 0.5) | 0;
    }
  }
}

/**
 * Copies a frame's pixels.
 *
 * Prefer `capture.toOwned()`, which copies the whole frame and is checked
 * against the lease. This remains for a caller that already holds a frame and
 * wants only the pixels.
 */
export function copyFramePixels(frame: CameraSensorFrame): Uint8Array {
  return new Uint8Array(frame.data as Uint8Array);
}

/** Convenience accessors for the branded angles on a frame's pose. */
export type FramePoseAzimuth = Radians;
export type FrameCameraPosition = Meters;
