/**
 * The disturbance stack: every effect, in the order it physically acts.
 *
 * **Order is part of the model, not an implementation detail.** Attenuating
 * after adding background would dim the sky along with the beacon; adding read
 * noise before the point spread would put it through the optics. The chain below
 * is the one documented in docs/DISTURBANCE_MODEL.md, and each stage names the
 * layer it belongs to:
 *
 * ```
 *   geometric     base attitude  ->  where the camera actually points
 *                 wander         ->  where the beacon appears to come from
 *   radiometric   attenuation    ->  how much of it survives the path
 *                 scintillation  ->  how much that varies with time
 *                 exposure       ->  integrate the optical state over the frame
 *                 defocus        ->  spread it further across the sensor
 *                 background     ->  add ambient light
 *   sensor        shot noise     ->  signal-dependent
 *                 read noise     ->  signal-independent
 *                 clip, quantise ->  what the ADC can express
 *   transport     dropout        ->  whether the frame is delivered at all
 * ```
 *
 * **Privileged.** This module computes the disturbance realization, which is
 * the answer key to what the pixels look like. It sits behind the ground-truth
 * barrier and no algorithm may import it.
 *
 * Every stochastic value is indexed by frame, so the realization is a function
 * of the seed and the frame number alone — not of how many frames were drawn
 * before it. See `./streams` for why that matters.
 */

import type { DisturbanceConfig } from '@/core/contracts/disturbance';
import { isCleanDisturbance } from '@/core/contracts/disturbance';
import type { SimulationSeed } from '@/core/contracts/simulation';

import { BurstChain, OrnsteinUhlenbeck, toneSum, type Tone } from './processes';
import { DisturbanceStreams, type SequentialNoise } from './streams';

/** Base attitude offsets applied to the camera's optical orientation. */
export interface BaseAttitude {
  /** Radians added to the mount's true azimuth. */
  readonly azimuth: number;
  /** Radians added to the mount's true elevation. */
  readonly elevation: number;
}

/** Apparent angular displacement of the received beacon, radians. */
export interface WanderOffset {
  readonly azimuth: number;
  readonly elevation: number;
}

/**
 * The disturbance realization for one frame.
 *
 * Recorded as evaluation truth and used by the sensor. Small and scalar on
 * purpose: the per-pixel noise field is *not* in here, because it is hundreds
 * of kilobytes a frame and is exactly reproducible from the seed and the frame
 * index, which are.
 */
export interface FrameDisturbance {
  readonly frameIndex: number;
  readonly captureTime: number;
  /** Base attitude at the capture instant. */
  readonly base: BaseAttitude;
  /** Apparent beacon displacement at the capture instant. */
  readonly wander: WanderOffset;
  /** Multiplier from scintillation. Mean 1 over a long run. */
  readonly scintillation: number;
  /** Whether the sensor failed to deliver this frame. */
  readonly dropped: boolean;
}

/**
 * Builds and evaluates every configured disturbance for a run.
 *
 * One instance per run. Construct it once; it holds the correlated processes,
 * which have to be walked forward in frame order.
 */
export class DisturbanceStack {
  public readonly config: DisturbanceConfig;
  /** True when nothing here can change a pixel or drop a frame. */
  public readonly isClean: boolean;

  private readonly streams: DisturbanceStreams;
  private readonly framePeriod: number;

  private readonly azimuthTones: Tone[];
  private readonly elevationTones: Tone[];
  private readonly jitterAzimuth: OrnsteinUhlenbeck | null;
  private readonly jitterElevation: OrnsteinUhlenbeck | null;
  private readonly scintillationProcess: OrnsteinUhlenbeck | null;
  private readonly wanderAzimuth: OrnsteinUhlenbeck | null;
  private readonly wanderElevation: OrnsteinUhlenbeck | null;
  private readonly burst: BurstChain | null;

  constructor(config: DisturbanceConfig, seed: SimulationSeed, frameRate: number) {
    if (!(frameRate > 0)) {
      throw new RangeError(`Frame rate must be positive, received ${String(frameRate)}`);
    }
    this.config = config;
    this.isClean = isCleanDisturbance(config);
    this.streams = new DisturbanceStreams(seed);
    this.framePeriod = 1 / frameRate;

    const platform = config.platform;
    const tones = platform.enabled ? platform.tones : [];
    this.azimuthTones = tones
      .filter((tone) => tone.axis === 'azimuth')
      .map((tone) => ({ amplitude: tone.amplitude, frequency: tone.frequency, phase: tone.phase }));
    this.elevationTones = tones
      .filter((tone) => tone.axis === 'elevation')
      .map((tone) => ({ amplitude: tone.amplitude, frequency: tone.frequency, phase: tone.phase }));

    // Correlated processes live on the frame grid. Both axes share one stream
    // and are separated by lane, so they are independent of each other without
    // needing a stream name each.
    const jitter = platform.jitter;
    const jitterActive = platform.enabled && jitter.enabled && jitter.rms > 0;
    const jitterStream = this.streams.get('disturbance:platform-jitter');
    this.jitterAzimuth = jitterActive
      ? new OrnsteinUhlenbeck(jitterStream, this.framePeriod, jitter.correlationTime, jitter.rms, 0)
      : null;
    this.jitterElevation = jitterActive
      ? new OrnsteinUhlenbeck(jitterStream, this.framePeriod, jitter.correlationTime, jitter.rms, 1)
      : null;

    const scintillation = config.atmosphere.scintillation;
    this.scintillationProcess =
      scintillation.enabled && scintillation.logAmplitudeSigma > 0
        ? new OrnsteinUhlenbeck(
            this.streams.get('disturbance:scintillation'),
            this.framePeriod,
            scintillation.correlationTime,
            scintillation.logAmplitudeSigma,
          )
        : null;

    const wander = config.atmosphere.wander;
    const wanderStream = this.streams.get('disturbance:wander');
    const wanderActive = wander.enabled && wander.rms > 0;
    this.wanderAzimuth = wanderActive
      ? new OrnsteinUhlenbeck(wanderStream, this.framePeriod, wander.correlationTime, wander.rms, 0)
      : null;
    this.wanderElevation = wanderActive
      ? new OrnsteinUhlenbeck(wanderStream, this.framePeriod, wander.correlationTime, wander.rms, 1)
      : null;

    this.burst =
      config.dropouts.mode === 'burst'
        ? new BurstChain(
            this.streams.get('disturbance:dropout'),
            config.dropouts.meanGoodFrames,
            config.dropouts.meanBadFrames,
          )
        : null;
  }

  /** Each stream's derived seed, for the experiment record. */
  public streamSeeds(): Record<string, number> {
    return this.streams.seeds();
  }

  /**
   * Base attitude at a time, in radians.
   *
   * Tones are closed-form in time. Jitter lives on the frame grid, so it is
   * sampled at the frame the time belongs to: a disturbance that is defined
   * per frame cannot be interpolated between frames without inventing detail
   * the model does not have.
   */
  public baseAttitudeAt(time: number, frameIndex: number): BaseAttitude {
    const platform = this.config.platform;
    if (!platform.enabled) return { azimuth: 0, elevation: 0 };

    return {
      azimuth:
        platform.biasAzimuth +
        toneSum(this.azimuthTones, time) +
        (this.jitterAzimuth?.valueAt(frameIndex) ?? 0),
      elevation:
        platform.biasElevation +
        toneSum(this.elevationTones, time) +
        (this.jitterElevation?.valueAt(frameIndex) ?? 0),
    };
  }

  /** Apparent angular displacement of the beacon at a frame, in radians. */
  public wanderAt(frameIndex: number): WanderOffset {
    return {
      azimuth: this.wanderAzimuth?.valueAt(frameIndex) ?? 0,
      elevation: this.wanderElevation?.valueAt(frameIndex) ?? 0,
    };
  }

  /**
   * Scintillation multiplier at a frame.
   *
   * `exp(X - sigma^2/2)`, which has mean one: switching scintillation on changes
   * how much the received intensity varies, not how bright it is on average.
   */
  public scintillationAt(frameIndex: number): number {
    if (this.scintillationProcess === null) return 1;
    const sigma = this.config.atmosphere.scintillation.logAmplitudeSigma;
    return Math.exp(this.scintillationProcess.valueAt(frameIndex) - (sigma * sigma) / 2);
  }

  /**
   * Transmittance over a path, as an intensity fraction on (0, 1].
   *
   * `10^(-dbPerKm * rangeKm / 10)`. Intensity convention throughout: 3 dB is
   * half the intensity. No field amplitude is attenuated anywhere in this model,
   * so the 20log10 convention never applies.
   */
  public transmittanceOver(rangeMetres: number): number {
    const attenuation = this.config.atmosphere.attenuation;
    if (!attenuation.enabled || attenuation.dbPerKm === 0) return 1;
    const decibels = (attenuation.dbPerKm * Math.max(0, rangeMetres)) / 1000;
    return Math.pow(10, -decibels / 10);
  }

  /**
   * Whether the sensor fails to deliver a frame.
   *
   * A dropped frame is never rasterized and never reaches the algorithm. It is
   * not a black frame and carries no flag — a camera that failed to deliver
   * cannot tell you that it did.
   */
  public isDroppedAt(frameIndex: number): boolean {
    const dropouts = this.config.dropouts;
    if (dropouts.mode === 'none') return false;
    if (dropouts.mode === 'burst') return this.burst?.isBadAt(frameIndex) ?? false;
    if (dropouts.probability <= 0) return false;
    return this.streams.get('disturbance:dropout').floatAt(frameIndex) < dropouts.probability;
  }

  /** Point-spread standard deviation after defocus, in pixels. */
  public spreadFor(beaconSigma: number): number {
    const defocus = this.config.optics.defocus;
    if (!defocus.enabled || defocus.extraSigma <= 0) return beaconSigma;
    // Quadrature, so the broadened spot has the variance of the two combined.
    return Math.sqrt(beaconSigma * beaconSigma + defocus.extraSigma * defocus.extraSigma);
  }

  /** Optical states integrated per frame. */
  public get subSamples(): number {
    const exposure = this.config.optics.exposure;
    return exposure.enabled ? Math.max(1, Math.trunc(exposure.subSamples)) : 1;
  }

  /** Whether any ambient background is to be added. */
  public get hasBackground(): boolean {
    const background = this.config.optics.background;
    return background.enabled && (background.level > 0 || background.gradient > 0);
  }

  /**
   * Ambient background at a pixel, in intensity counts.
   *
   * Uniform level plus a linear ramp whose peak-to-peak amplitude is `gradient`,
   * centred so that the mean over the image is the uniform level alone — a
   * gradient changes the shape of the background, not how much of it there is.
   *
   * For one pixel. Filling a whole frame goes through {@link fillBackground},
   * which hoists the trigonometry out of the loop; calling this per pixel would
   * evaluate a sine and a cosine six hundred thousand times a frame.
   */
  public backgroundAt(
    x: number,
    y: number,
    width: number,
    height: number,
    maxValue: number,
  ): number {
    const plane = this.backgroundPlane(width, height, maxValue);
    if (plane === null) return 0;
    return Math.max(0, plane.constant + plane.perX * x + plane.perY * y);
  }

  /**
   * The background as an affine plane in pixel coordinates, or `null` when off.
   *
   * `level(x, y) = constant + perX*x + perY*y`, already scaled to intensity
   * counts. Computed once per frame so the loop that fills the image is two
   * multiply-adds per pixel rather than a sine, a cosine and a division.
   */
  private backgroundPlane(
    width: number,
    height: number,
    maxValue: number,
  ): { constant: number; perX: number; perY: number } | null {
    const background = this.config.optics.background;
    if (!background.enabled) return null;

    const level: number = background.level;
    if (background.gradient <= 0) {
      return { constant: level * maxValue, perX: 0, perY: 0 };
    }

    const cos = Math.cos(background.gradientAngle);
    const sin = Math.sin(background.gradientAngle);
    // Projection onto the gradient direction, normalised so the ramp spans
    // [-0.5, 0.5] across the image however it is oriented.
    const span = Math.abs(cos) * width + Math.abs(sin) * height;
    const scale = (background.gradient * maxValue) / (span === 0 ? 1 : span);

    return {
      constant: level * maxValue - scale * ((width / 2) * cos + (height / 2) * sin),
      perX: scale * cos,
      perY: scale * sin,
    };
  }

  /**
   * Writes the camera pedestal plus ambient background over a whole frame.
   *
   * One pass, with the gradient evaluated incrementally. This is the hot loop of
   * the disturbed renderer: at 640x480 it runs three hundred thousand times a
   * frame, and evaluating the trigonometry inside it cost more than every other
   * disturbance put together.
   */
  public fillBackground(
    target: Float64Array,
    width: number,
    height: number,
    maxValue: number,
    pedestal: number,
  ): void {
    const plane = this.backgroundPlane(width, height, maxValue);
    if (plane === null) {
      if (pedestal !== 0) target.fill(pedestal);
      else target.fill(0);
      return;
    }

    for (let y = 0; y < height; y += 1) {
      const row = y * width;
      let value = pedestal + plane.constant + plane.perY * y;
      for (let x = 0; x < width; x += 1) {
        target[row + x] = value > 0 ? value : 0;
        value += plane.perX;
      }
    }
  }

  /** A per-frame sequential noise generator for the read-noise field. */
  public readNoiseFor(frameIndex: number): SequentialNoise {
    return this.streams.get('disturbance:sensor-read').sequentialAt(frameIndex);
  }

  /** A per-frame sequential noise generator for the shot-noise field. */
  public shotNoiseFor(frameIndex: number): SequentialNoise {
    return this.streams.get('disturbance:sensor-shot').sequentialAt(frameIndex);
  }

  /** Whether any per-pixel noise is configured. */
  public get hasSensorNoise(): boolean {
    const sensor = this.config.sensor;
    return (
      (sensor.readNoise.enabled && sensor.readNoise.sigma > 0) ||
      (sensor.shotNoise.enabled && sensor.shotNoise.scale > 0)
    );
  }

  public get readNoiseSigma(): number {
    const readNoise = this.config.sensor.readNoise;
    return readNoise.enabled ? readNoise.sigma : 0;
  }

  public get shotNoiseScale(): number {
    const shotNoise = this.config.sensor.shotNoise;
    return shotNoise.enabled ? shotNoise.scale : 0;
  }

  /**
   * The whole scalar realization for a frame.
   *
   * What the evaluator records. The per-pixel noise field is deliberately absent
   * — it is reproducible from the seed and the frame index, and storing it would
   * turn a structured experiment record into a video.
   */
  public realizationAt(frameIndex: number, captureTime: number): FrameDisturbance {
    return {
      frameIndex,
      captureTime,
      base: this.baseAttitudeAt(captureTime, frameIndex),
      wander: this.wanderAt(frameIndex),
      scintillation: this.scintillationAt(frameIndex),
      dropped: this.isDroppedAt(frameIndex),
    };
  }

  /** Returns every correlated process to its start, replaying the same run. */
  public reset(): void {
    this.jitterAzimuth?.reset();
    this.jitterElevation?.reset();
    this.scintillationProcess?.reset();
    this.wanderAzimuth?.reset();
    this.wanderElevation?.reset();
    this.burst?.reset();
  }
}
