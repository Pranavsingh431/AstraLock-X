/**
 * Physical disturbance configuration.
 *
 * Disturbances are part of the **scenario**, not of an algorithm's settings. A
 * tracker must not be able to choose the weather it is tested in, and a result
 * is only comparable to another result if the physics both ran against is
 * recorded in one place and fingerprinted with everything else.
 *
 * Every field here is a physical or instrumental quantity with a stated unit.
 * None of it reaches a tracking algorithm: what a tracker sees is the pixels
 * that come out of the far end of the pipeline, which is the only place a real
 * receiver would see any of this either.
 *
 * See docs/DISTURBANCE_MODEL.md for the equations and the pipeline order.
 */

import { z } from 'zod';

import { nonNegativeNumber, positiveNumber, tagged, unitIntervalNumber } from './schema';
import type { Hertz, Normalized, Pixels, Radians, Seconds } from './units';

// --- Platform ---------------------------------------------------------------

/** Which base angle a vibration tone drives. */
export type VibrationAxis = 'azimuth' | 'elevation';

/**
 * One sinusoidal component of base motion.
 *
 * `offset(t) = amplitude * sin(2*pi*frequency*t + phase)`, in radians of base
 * attitude. Several tones on one axis sum.
 */
export interface VibrationTone {
  readonly axis: VibrationAxis;
  /** Peak angular amplitude, radians. */
  readonly amplitude: Radians;
  readonly frequency: Hertz;
  /** Phase at t = 0, radians. Fixed, so a tone is fully deterministic. */
  readonly phase: Radians;
}

/**
 * Correlated random base motion.
 *
 * A first-order (Ornstein-Uhlenbeck) process, not white noise. Independent
 * angle jumps every tick would have unbounded bandwidth and infinite
 * acceleration, and calling that "vibration" would be describing a numerical
 * artefact rather than a platform.
 */
export interface AngularJitterConfig {
  readonly enabled: boolean;
  /** Stationary RMS of the process, radians, per axis. */
  readonly rms: Radians;
  /** 1/e correlation time of the process, seconds. */
  readonly correlationTime: Seconds;
}

/**
 * Motion of the structure the gimbal is bolted to.
 *
 * This is **not** gimbal-axis motion. The camera's optical orientation in the
 * world is the base attitude composed with the gimbal's own axis angles, and
 * the gimbal encoder measures only the latter. So base motion is genuinely
 * invisible to the tracker except as image motion — which is exactly what it
 * is on a real vehicle without a separate attitude reference.
 */
export interface PlatformDisturbanceConfig {
  readonly enabled: boolean;
  /** Constant base offset, radians. Useful as a fixed boresight error. */
  readonly biasAzimuth: Radians;
  readonly biasElevation: Radians;
  readonly tones: readonly VibrationTone[];
  readonly jitter: AngularJitterConfig;
}

// --- Atmosphere -------------------------------------------------------------

/**
 * Path attenuation.
 *
 * `attenuationDb = dbPerKm * rangeKm`, and the emitter's apparent **intensity**
 * is multiplied by `10^(-attenuationDb / 10)`. That is the power/intensity
 * convention: 3 dB halves the intensity. This model never attenuates a field
 * amplitude, so the 20log10 convention does not apply anywhere in it.
 */
export interface AttenuationConfig {
  readonly enabled: boolean;
  /** Attenuation coefficient, dB per kilometre of path. */
  readonly dbPerKm: number;
}

/**
 * Intensity scintillation.
 *
 * A correlated log-normal multiplier: `gain(t) = exp(X(t) - sigma^2 / 2)` where
 * `X` is a zero-mean Ornstein-Uhlenbeck process with standard deviation
 * `logAmplitudeSigma`. The `-sigma^2/2` term makes `E[gain] = 1`, so turning
 * scintillation on changes the *variance* of the received intensity without
 * changing its mean — otherwise the effect would be indistinguishable from a
 * gain change.
 *
 * This is a camera-observable model of what scintillation does to a measured
 * blob. It is not wave propagation, and it does not pretend to be.
 */
export interface ScintillationConfig {
  readonly enabled: boolean;
  /** Standard deviation of log-intensity. Weak fluctuation below about 0.5. */
  readonly logAmplitudeSigma: number;
  /** 1/e correlation time of the log-intensity process, seconds. */
  readonly correlationTime: Seconds;
}

/**
 * Apparent angular displacement of the received beacon.
 *
 * Two orthogonal correlated components that move where the beacon's energy
 * lands on the sensor **without moving the target**. The distinction matters
 * for scoring: geometric pointing error is measured against the target's true
 * line of sight, and apparent displacement is an optical effect on top of it.
 * An evaluator can therefore separate "the mount is pointed wrong" from "the
 * beacon arrived from a slightly different direction than it left".
 *
 * A camera-domain proxy for beam wander and angle-of-arrival fluctuation, not a
 * propagation solution.
 */
export interface WanderConfig {
  readonly enabled: boolean;
  /** Stationary RMS of each angular component, radians. */
  readonly rms: Radians;
  /** 1/e correlation time, seconds. Larger means slower drift. */
  readonly correlationTime: Seconds;
}

export interface AtmosphereDisturbanceConfig {
  readonly attenuation: AttenuationConfig;
  readonly scintillation: ScintillationConfig;
  readonly wander: WanderConfig;
}

// --- Optics -----------------------------------------------------------------

/**
 * Finite exposure.
 *
 * The Phase 2 sensor sampled the world at one instant. With this enabled the
 * frame integrates `subSamples` optical states spread across the exposure
 * window, so relative motion during the exposure produces real motion blur
 * along the direction of that motion — and a stationary beacon produces none,
 * because every sub-sample lands in the same place.
 *
 * Blur is therefore a *consequence* of motion during the exposure, never a
 * blur filter applied to a finished image.
 */
export interface ExposureConfig {
  readonly enabled: boolean;
  /** Optical states integrated per frame. 1 reproduces instantaneous capture. */
  readonly subSamples: number;
}

/**
 * Defocus, as point-spread broadening.
 *
 * Added in quadrature to the beacon's own spread:
 * `sigma_effective = sqrt(sigma_beacon^2 + extraSigma^2)`. Total energy is
 * preserved, so the peak falls as the spot widens. This is not a lens model and
 * makes no claim to be one.
 */
export interface DefocusConfig {
  readonly enabled: boolean;
  /** Additional point-spread standard deviation, pixels. */
  readonly extraSigma: Pixels;
}

/**
 * Ambient background light.
 *
 * A uniform level plus an optional linear gradient across the frame, both in
 * normalised units scaled to the format's full range. Adds to the camera's own
 * `backgroundLevel` pedestal rather than replacing it: the pedestal is the
 * instrument, this is the sky.
 *
 * An engineering model of reduced contrast, deliberately not a photograph.
 */
export interface BackgroundConfig {
  readonly enabled: boolean;
  /** Uniform ambient level on [0, 1]. */
  readonly level: Normalized;
  /**
   * Peak-to-peak linear gradient on [0, 1], added across the image.
   *
   * Zero is uniform. The gradient runs along `gradientAngle`.
   */
  readonly gradient: Normalized;
  /** Direction of the gradient, radians, measured from the +x image axis. */
  readonly gradientAngle: Radians;
}

export interface OpticsDisturbanceConfig {
  readonly exposure: ExposureConfig;
  readonly defocus: DefocusConfig;
  readonly background: BackgroundConfig;
}

// --- Sensor -----------------------------------------------------------------

/**
 * Zero-mean read noise, in **simulation intensity counts**.
 *
 * Not electrons. This sensor works in relative 8-bit intensity and has no
 * calibrated conversion gain, so quoting electrons would be a unit the model
 * cannot support. Applied before clipping and quantisation.
 */
export interface ReadNoiseConfig {
  readonly enabled: boolean;
  /** Standard deviation, intensity counts on the 0..255 scale. */
  readonly sigma: number;
}

/**
 * Signal-dependent noise, as an approximation to photon shot noise.
 *
 * `sigma_shot(pixel) = scale * sqrt(max(signal + background, 0))`, with the
 * sample drawn from a normal distribution rather than a Poisson one.
 *
 * This is explicitly an **approximation in intensity units**. A true Poisson
 * photoelectron model needs an intensity-to-expected-count mapping, which needs
 * a calibrated conversion gain, which this sensor does not have. The square-root
 * dependence is the physically meaningful part and is what makes bright pixels
 * noisier than dark ones; the absolute scale is a free parameter.
 */
export interface ShotNoiseConfig {
  readonly enabled: boolean;
  /** Proportionality constant, counts^(1/2). */
  readonly scale: number;
}

export interface SensorDisturbanceConfig {
  readonly readNoise: ReadNoiseConfig;
  readonly shotNoise: ShotNoiseConfig;
}

// --- Frame transport --------------------------------------------------------

/** How sensor frames go missing. */
export type DropoutMode = 'none' | 'independent' | 'burst';

/**
 * Sensor delivery loss.
 *
 * A dropped frame is a frame the algorithm **never receives**. It is not a
 * black frame, and not a frame carrying a "this one is bad" flag: either of
 * those would hand the tracker information a camera that failed to deliver
 * cannot give it.
 *
 * `independent` drops each scheduled frame with `probability`. `burst` runs a
 * two-state Markov chain over frame indices, where `meanGoodFrames` and
 * `meanBadFrames` set the expected dwell in each state, which produces runs of
 * consecutive losses rather than isolated ones.
 */
export interface DropoutDisturbanceConfig {
  readonly mode: DropoutMode;
  /** Per-frame drop probability, used by `independent`. */
  readonly probability: Normalized;
  /** Expected consecutive delivered frames, used by `burst`. */
  readonly meanGoodFrames: number;
  /** Expected consecutive dropped frames, used by `burst`. */
  readonly meanBadFrames: number;
}

// --- The whole thing --------------------------------------------------------

/**
 * Every disturbance acting on one scenario.
 *
 * Note what is **not** here: decoys and other false optical sources. Those are
 * real entities with real trajectories and real beacons, so they live in the
 * scenario's `targets` array alongside the designated target. Representing them
 * as a disturbance parameter would make them a special kind of object the
 * renderer had to know about, and the whole point is that a decoy is not
 * special — it is another emitter, and telling it apart is the tracker's job.
 */
export interface DisturbanceConfig {
  /**
   * Name of the preset this was populated from, or `null`.
   *
   * Provenance only. Every parameter above is stored explicitly, so a run is
   * fully described even if a preset is later redefined or removed. The name is
   * never the record of the configuration.
   */
  readonly preset: string | null;
  readonly platform: PlatformDisturbanceConfig;
  readonly atmosphere: AtmosphereDisturbanceConfig;
  readonly optics: OpticsDisturbanceConfig;
  readonly sensor: SensorDisturbanceConfig;
  readonly dropouts: DropoutDisturbanceConfig;
}

// --- Validation -------------------------------------------------------------

const vibrationToneSchema = z.strictObject({
  axis: z.enum(['azimuth', 'elevation']),
  amplitude: tagged<Radians>(nonNegativeNumber.max(Math.PI)),
  frequency: tagged<Hertz>(positiveNumber.max(10_000)),
  phase: tagged<Radians>(
    z
      .number()
      .min(-2 * Math.PI)
      .max(2 * Math.PI),
  ),
});

export const disturbanceConfigSchema = z.strictObject({
  preset: z.string().min(1).nullable(),

  platform: z.strictObject({
    enabled: z.boolean(),
    biasAzimuth: tagged<Radians>(z.number().min(-Math.PI).max(Math.PI)),
    biasElevation: tagged<Radians>(z.number().min(-Math.PI).max(Math.PI)),
    // Bounded so a typo cannot turn into a scenario that spends its whole run
    // evaluating sinusoids.
    tones: z.array(vibrationToneSchema).max(16),
    jitter: z.strictObject({
      enabled: z.boolean(),
      rms: tagged<Radians>(nonNegativeNumber.max(1)),
      correlationTime: tagged<Seconds>(positiveNumber.max(3600)),
    }),
  }),

  atmosphere: z.strictObject({
    attenuation: z.strictObject({
      enabled: z.boolean(),
      dbPerKm: nonNegativeNumber.max(1000),
    }),
    scintillation: z.strictObject({
      enabled: z.boolean(),
      // Above about 1.0 the log-normal model is outside the weak-to-moderate
      // regime it is defensible in; the bound says so rather than letting a
      // scenario quietly leave the model's domain.
      logAmplitudeSigma: nonNegativeNumber.max(1),
      correlationTime: tagged<Seconds>(positiveNumber.max(3600)),
    }),
    wander: z.strictObject({
      enabled: z.boolean(),
      rms: tagged<Radians>(nonNegativeNumber.max(1)),
      correlationTime: tagged<Seconds>(positiveNumber.max(3600)),
    }),
  }),

  optics: z.strictObject({
    exposure: z.strictObject({
      enabled: z.boolean(),
      subSamples: z.number().int().min(1).max(64),
    }),
    defocus: z.strictObject({
      enabled: z.boolean(),
      extraSigma: tagged<Pixels>(nonNegativeNumber.max(64)),
    }),
    background: z.strictObject({
      enabled: z.boolean(),
      level: tagged<Normalized>(unitIntervalNumber),
      gradient: tagged<Normalized>(unitIntervalNumber),
      gradientAngle: tagged<Radians>(
        z
          .number()
          .min(-2 * Math.PI)
          .max(2 * Math.PI),
      ),
    }),
  }),

  sensor: z.strictObject({
    readNoise: z.strictObject({
      enabled: z.boolean(),
      sigma: nonNegativeNumber.max(255),
    }),
    shotNoise: z.strictObject({
      enabled: z.boolean(),
      scale: nonNegativeNumber.max(64),
    }),
  }),

  dropouts: z.strictObject({
    mode: z.enum(['none', 'independent', 'burst']),
    probability: tagged<Normalized>(unitIntervalNumber),
    meanGoodFrames: positiveNumber.max(1e6),
    meanBadFrames: positiveNumber.max(1e6),
  }),
}) satisfies z.ZodType<DisturbanceConfig, unknown>;

/**
 * Everything off.
 *
 * This is what a scenario written before Phase 7 meant, and it is what the
 * migration inserts into one. Nothing here is a guess: a simulator that could
 * not produce a disturbance was running with none.
 */
const cleanDisturbances: DisturbanceConfig = {
  preset: 'CLEAN',
  platform: {
    enabled: false,
    biasAzimuth: 0 as Radians,
    biasElevation: 0 as Radians,
    tones: [],
    jitter: { enabled: false, rms: 0 as Radians, correlationTime: 1 as Seconds },
  },
  atmosphere: {
    attenuation: { enabled: false, dbPerKm: 0 },
    scintillation: { enabled: false, logAmplitudeSigma: 0, correlationTime: 1 as Seconds },
    wander: { enabled: false, rms: 0 as Radians, correlationTime: 1 as Seconds },
  },
  optics: {
    exposure: { enabled: false, subSamples: 1 },
    defocus: { enabled: false, extraSigma: 0 as Pixels },
    background: {
      enabled: false,
      level: 0 as Normalized,
      gradient: 0 as Normalized,
      gradientAngle: 0 as Radians,
    },
  },
  sensor: {
    readNoise: { enabled: false, sigma: 0 },
    shotNoise: { enabled: false, scale: 0 },
  },
  dropouts: {
    mode: 'none',
    probability: 0 as Normalized,
    meanGoodFrames: 1,
    meanBadFrames: 1,
  },
};

export const CLEAN_DISTURBANCES: DisturbanceConfig = Object.freeze(cleanDisturbances);

/**
 * Whether a configuration can change a single pixel or drop a single frame.
 *
 * Used to take the Phase-6 image-formation path unchanged when there is nothing
 * to do, which is what makes "disturbances off" mean *exactly* Phase 6 rather
 * than approximately Phase 6. A disabled effect and an effect configured to
 * zero are both inert, and both are reported as clean.
 */
export function isCleanDisturbance(config: DisturbanceConfig): boolean {
  const { platform, atmosphere, optics, sensor, dropouts } = config;

  const platformActive =
    platform.enabled &&
    (platform.biasAzimuth !== 0 ||
      platform.biasElevation !== 0 ||
      platform.tones.some((tone) => tone.amplitude !== 0) ||
      (platform.jitter.enabled && platform.jitter.rms > 0));

  const atmosphereActive =
    (atmosphere.attenuation.enabled && atmosphere.attenuation.dbPerKm !== 0) ||
    (atmosphere.scintillation.enabled && atmosphere.scintillation.logAmplitudeSigma > 0) ||
    (atmosphere.wander.enabled && atmosphere.wander.rms > 0);

  const opticsActive =
    (optics.exposure.enabled && optics.exposure.subSamples > 1) ||
    (optics.defocus.enabled && optics.defocus.extraSigma > 0) ||
    (optics.background.enabled && (optics.background.level > 0 || optics.background.gradient > 0));

  const sensorActive =
    (sensor.readNoise.enabled && sensor.readNoise.sigma > 0) ||
    (sensor.shotNoise.enabled && sensor.shotNoise.scale > 0);

  const dropoutsActive =
    (dropouts.mode === 'independent' && dropouts.probability > 0) || dropouts.mode === 'burst';

  return !(platformActive || atmosphereActive || opticsActive || sensorActive || dropoutsActive);
}

/** Parses an untrusted disturbance configuration. */
export function parseDisturbanceConfig(input: unknown): DisturbanceConfig {
  return disturbanceConfigSchema.parse(input);
}
