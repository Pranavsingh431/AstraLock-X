/**
 * Configuration for AstraLock-X Reference PAT.
 *
 * Entirely separate from `SimulationConfig`: a scenario describes the world, and
 * this describes how one tracker attacks it. Everything a controller "knows"
 * about its hardware — the mount's command latency and servo lag, the search
 * region, an optional coarse prior — is stated here as the tracker's own belief,
 * recorded and fingerprinted with every experiment. None of it is read from the
 * simulator.
 *
 * Versioned, strict, and validated: non-finite and physically nonsensical values
 * are rejected rather than clamped.
 *
 * See docs/ASTRALOCK_PAT.md.
 */

import { z } from 'zod';

import { baselineDetectorConfigSchema } from '../baseline/config';

export const ASTRALOCK_CONFIG_SCHEMA_VERSION = 1;

const finite = z.number().finite();
const positive = finite.positive();
const nonNegative = finite.nonnegative();
const probability = finite.gt(0).lt(1);
const DEG = Math.PI / 180;

export const acquisitionConfigSchema = z.strictObject({
  /** Detector score a candidate needs before it is considered at all. */
  minCandidateScore: finite.min(0).max(1),
  /** Supporting observations, including the first, before TRACK. */
  minSupportingObservations: z.number().int().min(2),
  /** Time from first to latest support before TRACK, seconds. */
  minPersistence: nonNegative,
  /** Consecutive frames without a supporting observation before ACQUIRE gives up. */
  maxConsecutiveMisses: z.number().int().nonnegative(),
  /** Largest bearing jump from the prediction a support may make, radians. */
  maxBearingDisplacement: positive.max(0.5),
  /** Chi-square gate for supporting observations (2 dof). */
  gateChi2: positive,
  /** Mean NIS of the supports must not exceed this. */
  maxMeanNis: positive,
});

export const immConfigSchema = z.strictObject({
  measurementNoiseStdDev: positive,
  ncvAccelerationSpectralDensity: positive,
  ncvAccelerationStateVariance: positive,
  ncaJerkSpectralDensity: positive,
  stayNcv: probability,
  stayNca: probability,
  transitionReferenceInterval: positive,
  initialNcvProbability: probability,
  initialAngleVariance: positive,
  initialRateVariance: positive,
  initialAccelerationVariance: positive,
  maxPredictStep: positive.max(1),
});

export const gatingConfigSchema = z.strictObject({
  /** Chi-square gate while tracking (2 dof; 13.82 ≈ 99.9 %). */
  trackGateChi2: positive,
  /** The gate in angle never exceeds this while tracking, radians. */
  trackMaxGateRadius: positive,
  /** Chi-square gate while recovering. */
  recoverGateChi2: positive,
  /** Upper bound on the recovery gate in angle, radians. */
  recoverMaxGateRadius: positive,
});

const axisControllerSchema = z.strictObject({
  kp: nonNegative,
  ki: nonNegative,
  kd: nonNegative,
  derivativeFilterTau: nonNegative,
  /** Cap on the integral term's own contribution, radians. */
  integralLimit: nonNegative,
  /** Largest total correction (feedback + feed-forward) per command, radians. */
  correctionLimit: positive,
});

export const controllerConfigSchema = z.strictObject({
  pan: axisControllerSchema,
  tilt: axisControllerSchema,
  /**
   * The mount's command transport latency as the controller believes it,
   * seconds — a datasheet figure, not a value read from the simulator.
   */
  commandLatency: nonNegative.max(1),
  /**
   * Effective lag of the mount's position servo to a ramp, seconds (≈ 2ζ/ωₙ for a
   * second-order servo), as the controller believes it.
   */
  servoLag: nonNegative.max(1),
  /** Whether to add the predicted-motion feed-forward term. */
  feedforward: z.boolean(),
});

export const searchPriorSchema = z.strictObject({
  centreAzimuth: finite.min(-Math.PI).max(Math.PI),
  centreElevation: finite.min(-Math.PI / 2).max(Math.PI / 2),
  sigmaAzimuth: positive,
  sigmaElevation: positive,
  /** Where the prior came from: an operator estimate, ephemeris, a previous run… */
  source: z.string().min(1),
});
export type SearchPrior = z.infer<typeof searchPriorSchema>;

export const searchConfigSchema = z
  .strictObject({
    panMin: finite,
    panMax: finite,
    tiltMin: finite,
    tiltMax: finite,
    /** Fraction of the field of view adjacent pointings overlap by, on each axis. */
    overlapFraction: finite.min(0.05).max(0.9),
    settleTolerance: positive,
    measuredRateTolerance: positive,
    dwellTime: nonNegative,
    waypointTimeout: positive,
    /** Optional coarse pointing prior. `null` means no prior information at all. */
    prior: searchPriorSchema.nullable(),
    /** A prior-guided search covers out to this many sigmas before the full region. */
    priorSigmaExtent: positive.max(10),
  })
  .refine((c) => c.panMin < c.panMax, { message: 'panMin must be below panMax', path: ['panMin'] })
  .refine((c) => c.tiltMin < c.tiltMax, {
    message: 'tiltMin must be below tiltMax',
    path: ['tiltMin'],
  })
  .refine((c) => c.waypointTimeout > c.dwellTime, {
    message: 'waypointTimeout must exceed dwellTime',
    path: ['waypointTimeout'],
  });

export const recoveryConfigSchema = z
  .strictObject({
    /** Consecutive frames without an associated measurement before TRACK enters RECOVER. */
    missesBeforeRecover: z.number().int().positive(),
    /** Coast on the prediction alone for this long before local search, seconds. */
    localSearchDelay: nonNegative,
    /** Local search radius is this many angular sigmas. */
    localSearchSigmaMultiple: positive,
    localSearchMinRadius: positive,
    localSearchMaxRadius: positive,
    /** Time at each local search pointing, seconds. */
    localSearchDwell: positive,
    /** Give up and return to global SEARCH after this long, seconds. */
    maxDuration: positive,
    /** …or once the angular sigma exceeds this, radians. */
    maxAngularSigma: positive,
  })
  .refine((c) => c.localSearchMinRadius <= c.localSearchMaxRadius, {
    message: 'localSearchMinRadius must not exceed localSearchMaxRadius',
    path: ['localSearchMinRadius'],
  });

export const handoffConfigSchema = z.strictObject({
  enabled: z.boolean(),
  /** Measured boresight residual of the current detection, per axis, radians. */
  maxResidualAzimuth: positive,
  maxResidualElevation: positive,
  /** Estimator angular sigma, radians. */
  maxAngularSigma: positive,
  /** Estimated angular rate magnitude, rad/s. */
  maxAngularRate: positive,
  minTrackQuality: finite.min(0).max(1),
  /** All conditions must hold continuously for this long, seconds. */
  dwell: nonNegative,
  /** Once ready, thresholds are relaxed by this factor before readiness clears. */
  exitHysteresis: finite.min(1).max(5),
});

export const trackQualityConfigSchema = z.strictObject({
  /** Candidate score that counts as full strength. */
  scoreReference: positive.max(1),
  /** Angular sigma at which certainty reaches zero, radians. */
  sigmaReference: positive,
  /** Frames the persistence component looks back over. */
  persistenceWindow: z.number().int().min(1).max(600),
  /** Smoothing factor for the NIS consistency component, per frame. */
  nisSmoothing: probability,
});

export const astraLockConfigSchema = z.strictObject({
  schemaVersion: z.literal(ASTRALOCK_CONFIG_SCHEMA_VERSION),
  detector: baselineDetectorConfigSchema,
  acquisition: acquisitionConfigSchema,
  imm: immConfigSchema,
  gating: gatingConfigSchema,
  controller: controllerConfigSchema,
  search: searchConfigSchema,
  recovery: recoveryConfigSchema,
  handoff: handoffConfigSchema,
  trackQuality: trackQualityConfigSchema,
});

export type AstraLockConfig = z.infer<typeof astraLockConfigSchema>;

export const parseAstraLockConfig = (raw: unknown): AstraLockConfig =>
  astraLockConfigSchema.parse(raw);

/**
 * The shipped default. Reasoning in docs/ASTRALOCK_PAT.md; the same values are
 * used for every bundled scenario.
 */
export const DEFAULT_ASTRALOCK_CONFIG: AstraLockConfig = astraLockConfigSchema.parse({
  schemaVersion: ASTRALOCK_CONFIG_SCHEMA_VERSION,
  // The baseline's detector, unchanged: the robust algorithm differs in what it
  // does with detections, not in how it finds them.
  detector: {
    threshold: 40,
    minArea: 3,
    maxArea: 4000,
    minPeak: 70,
    minIntegratedIntensity: 150,
  },
  acquisition: {
    minCandidateScore: 0.1,
    minSupportingObservations: 6,
    minPersistence: 0.08,
    maxConsecutiveMisses: 3,
    maxBearingDisplacement: 1 * DEG,
    gateChi2: 18.42,
    maxMeanNis: 8,
  },
  imm: {
    measurementNoiseStdDev: 1.5e-4,
    // Measured, not guessed. A sweep over both densities against a 7.85e-3
    // rad/s² manoeuvre at the bundled 60 fps and 150 µrad measurement noise
    // gave the separation below; the previous jerk density of 2e-2 made the NCA
    // likelihood so flat that the model could never win, and the estimator sat
    // at the transition matrix's stationary distribution whatever the target
    // did. See docs/ASTRALOCK_PAT.md.
    //
    //   constant velocity  ->  NCV 0.82
    //   during a manoeuvre ->  NCA peaks at 0.68
    //
    // A tight NCV is deliberate: letting it absorb acceleration is exactly what
    // removes the IMM's ability to tell the two apart. Catching the manoeuvre
    // is the NCA model's job.
    ncvAccelerationSpectralDensity: 2e-7,
    ncvAccelerationStateVariance: 1e-3,
    ncaJerkSpectralDensity: 2e-4,
    stayNcv: 0.98,
    stayNca: 0.95,
    transitionReferenceInterval: 1 / 60,
    initialNcvProbability: 0.9,
    initialAngleVariance: 1e-6,
    initialRateVariance: 1e-2,
    initialAccelerationVariance: 1e-2,
    maxPredictStep: 0.05,
  },
  gating: {
    trackGateChi2: 13.82,
    trackMaxGateRadius: 1.5 * DEG,
    recoverGateChi2: 13.82,
    recoverMaxGateRadius: 6 * DEG,
  },
  controller: {
    pan: {
      kp: 0.55,
      ki: 0.35,
      kd: 0.02,
      derivativeFilterTau: 0.08,
      integralLimit: 2 * DEG,
      correctionLimit: 12 * DEG,
    },
    tilt: {
      kp: 0.55,
      ki: 0.35,
      kd: 0.02,
      derivativeFilterTau: 0.08,
      integralLimit: 2 * DEG,
      correctionLimit: 12 * DEG,
    },
    commandLatency: 0.023,
    servoLag: 0.035,
    feedforward: true,
  },
  search: {
    panMin: -30 * DEG,
    panMax: 30 * DEG,
    tiltMin: -5 * DEG,
    tiltMax: 15 * DEG,
    overlapFraction: 0.25,
    settleTolerance: 0.5 * DEG,
    measuredRateTolerance: 1.5 * DEG,
    dwellTime: 0.05,
    waypointTimeout: 1.5,
    prior: null,
    priorSigmaExtent: 3,
  },
  recovery: {
    missesBeforeRecover: 3,
    localSearchDelay: 0.3,
    localSearchSigmaMultiple: 3,
    localSearchMinRadius: 0.5 * DEG,
    localSearchMaxRadius: 8 * DEG,
    localSearchDwell: 0.15,
    maxDuration: 4,
    maxAngularSigma: 10 * DEG,
  },
  handoff: {
    enabled: true,
    maxResidualAzimuth: 1e-3,
    maxResidualElevation: 1e-3,
    maxAngularSigma: 3e-4,
    maxAngularRate: 5e-3,
    minTrackQuality: 0.6,
    dwell: 1,
    exitHysteresis: 1.5,
  },
  trackQuality: {
    scoreReference: 0.3,
    sigmaReference: 1e-3,
    persistenceWindow: 30,
    nisSmoothing: 0.1,
  },
});
