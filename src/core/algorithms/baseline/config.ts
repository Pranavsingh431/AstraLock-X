/**
 * Tuning for the baseline PAT algorithm.
 *
 * Kept entirely separate from `SimulationConfig`. A scenario describes the
 * *world* — where the target goes, what the optics are, how the mount behaves —
 * and an algorithm config describes how one particular tracker chooses to
 * attack it. Mixing them would make it impossible to run two algorithms against
 * an identical scenario, which is the whole point of the comparison AstraBench
 * will eventually do, and it would let a scenario author tune the tracker.
 *
 * Versioned for the same reason the scenario schema is: a stored config that no
 * longer means what it meant is worse than one that is rejected.
 */

import { z } from 'zod';

export const BASELINE_PAT_SCHEMA_VERSION = 1;

const finite = z.number().finite();
const positive = finite.positive();
const nonNegative = finite.nonnegative();

export const baselineDetectorConfigSchema = z
  .strictObject({
    threshold: finite.min(0).max(65535),
    minArea: z.number().int().positive(),
    maxArea: z.number().int().positive(),
    minPeak: finite.min(0).max(65535),
    minIntegratedIntensity: nonNegative,
  })
  .refine((c) => c.minArea <= c.maxArea, {
    message: 'minArea must not exceed maxArea',
    path: ['minArea'],
  })
  .refine((c) => c.minPeak >= c.threshold, {
    message: 'minPeak below the threshold can never reject anything, which is a mistake',
    path: ['minPeak'],
  });

export const kalmanConfigSchema = z.strictObject({
  processNoiseSpectralDensity: positive,
  measurementNoiseStdDev: positive,
  initialAngleVariance: positive,
  initialRateVariance: positive,
  maxPredictStep: positive.max(1),
});

export const pidConfigSchema = z.strictObject({
  kp: finite,
  ki: finite,
  kd: finite,
  outputLimit: positive,
  integralLimit: nonNegative,
  derivativeFilterTau: nonNegative,
});

export const searchConfigSchema = z
  .strictObject({
    panMin: finite,
    panMax: finite,
    tiltMin: finite,
    tiltMax: finite,
    horizontalStep: positive,
    verticalStep: positive,
    settleTolerance: positive,
    measuredRateTolerance: positive,
    dwellTime: nonNegative,
    waypointTimeout: positive,
    loop: z.boolean(),
  })
  .refine((c) => c.panMin < c.panMax, {
    message: 'panMin must be below panMax',
    path: ['panMin'],
  })
  .refine((c) => c.tiltMin < c.tiltMax, {
    message: 'tiltMin must be below tiltMax',
    path: ['tiltMin'],
  })
  .refine((c) => c.waypointTimeout > c.dwellTime, {
    message: 'waypointTimeout must exceed dwellTime or every waypoint times out before it dwells',
    path: ['waypointTimeout'],
  });

export const baselinePatConfigSchema = z.strictObject({
  schemaVersion: z.literal(BASELINE_PAT_SCHEMA_VERSION),
  detector: baselineDetectorConfigSchema,
  kalman: kalmanConfigSchema,
  panPid: pidConfigSchema,
  tiltPid: pidConfigSchema,
  search: searchConfigSchema,
  /** Consecutive frames with no valid candidate before TRACK gives up. */
  missesBeforeLost: z.number().int().positive(),
  /** How long LOST holds before restarting the scan, seconds. */
  lostHoldTime: nonNegative,
  /**
   * Frames with a valid candidate before SEARCH commits to TRACK.
   *
   * One frame is enough to see something; it is not enough to believe it. A
   * small confirmation count costs a few frames of acquisition time and stops
   * the scan being derailed by a single hot pixel.
   */
  detectionsBeforeTrack: z.number().int().positive(),
});

export type BaselinePatConfig = z.infer<typeof baselinePatConfigSchema>;

export const parseBaselinePatConfig = (raw: unknown): BaselinePatConfig =>
  baselinePatConfigSchema.parse(raw);

const DEG = Math.PI / 180;

/**
 * The shipped default.
 *
 * Tuned against the clean Phase 2/3 sensor on more than one scenario, not
 * fitted to any single one. The reasoning behind each group:
 *
 * **Detector.** The bundled scenarios use a zero or near-zero background and a
 * beacon that saturates near the centre of its point spread, so a threshold of
 * 40/255 sits far above any skirt and far below the core. Area bounds of 3 and
 * 4000 px accept a point spread from a couple of pixels across up to a badly
 * defocused blob while rejecting single hot pixels and whole-frame glare.
 *
 * **Kalman.** Measurement noise of 100 µrad is roughly a third of a pixel at
 * the bundled 800 px focal length, plus the coarse-encoder contribution. The
 * process noise allows a few hundred µrad/s² of unmodelled angular
 * acceleration, which covers the bundled crossing passes without making the
 * filter chase noise on a stationary target.
 *
 * **PID.** Deliberately gentle. `kp = 0.55` means each correction closes just
 * over half the observed error, which lets the inner position servo settle
 * between outer-loop steps instead of fighting it. A small integral removes the
 * steady lag on a constant-velocity target; the derivative is small and
 * filtered because the error signal is quantised by the encoder.
 *
 * **Search.** The bundled cameras have a 12.0° × 9.0° field of view. Steps of
 * 5° in pan and 3.5° in tilt are comfortably inside that, so consecutive
 * waypoints overlap by more than half a field and a target cannot fall between
 * them even allowing for the settle tolerance and the mount's backlash. The
 * region is wide enough to contain a target the operator has no prior about,
 * and is the one quantity here that a deployment would genuinely re-specify.
 *
 * These are defaults, not fitted constants: the same values are used for every
 * bundled PAT scenario, and the acceptance tests run all of them unchanged.
 */
export const DEFAULT_BASELINE_PAT_CONFIG: BaselinePatConfig = baselinePatConfigSchema.parse({
  schemaVersion: BASELINE_PAT_SCHEMA_VERSION,
  detector: {
    threshold: 40,
    minArea: 3,
    maxArea: 4000,
    minPeak: 70,
    minIntegratedIntensity: 150,
  },
  kalman: {
    processNoiseSpectralDensity: 2e-4,
    measurementNoiseStdDev: 1e-4,
    initialAngleVariance: 1e-2,
    initialRateVariance: 1e-1,
    maxPredictStep: 0.05,
  },
  panPid: {
    kp: 0.55,
    ki: 0.35,
    kd: 0.02,
    outputLimit: 12 * DEG,
    integralLimit: 2 * DEG,
    derivativeFilterTau: 0.08,
  },
  tiltPid: {
    kp: 0.55,
    ki: 0.35,
    kd: 0.02,
    outputLimit: 12 * DEG,
    integralLimit: 2 * DEG,
    derivativeFilterTau: 0.08,
  },
  search: {
    panMin: -30 * DEG,
    panMax: 30 * DEG,
    tiltMin: -5 * DEG,
    tiltMax: 15 * DEG,
    horizontalStep: 5 * DEG,
    verticalStep: 3.5 * DEG,
    settleTolerance: 0.6 * DEG,
    measuredRateTolerance: 1.5 * DEG,
    dwellTime: 0.05,
    waypointTimeout: 1.5,
    loop: true,
  },
  missesBeforeLost: 12,
  lostHoldTime: 0.5,
  detectionsBeforeTrack: 2,
});
