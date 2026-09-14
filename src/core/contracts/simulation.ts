/**
 * Experiment definition: the inputs that fully determine a run.
 *
 * A `SimulationConfig` plus a `SimulationSeed` is the complete description of
 * an experiment. Two runs from the same config must produce identical output,
 * so nothing that affects the world may live outside this type — no ambient
 * clock, no unseeded randomness, no machine-dependent defaults.
 *
 * See docs/adr/0004-deterministic-seeded-experiments.md.
 */

import { z } from 'zod';

import type { Vec3 } from './geometry';
import {
  nonNegativeNumber,
  positiveNumber,
  tagged,
  unitIntervalNumber,
  vec3Schema,
} from './schema';
import type { GimbalAxisLimits, PixelFormat } from './sensors';
import { type TrajectoryConfig, trajectoryConfigSchema } from './trajectory';
import type {
  Hertz,
  Meters,
  MetersPerSecond,
  Normalized,
  Pixels,
  Radians,
  RadiansPerSecond,
  Seconds,
  Watts,
} from './units';

declare const seedBrand: unique symbol;

/**
 * Root seed of a run, as an unsigned 32-bit integer.
 *
 * One root seed per experiment; each stochastic subsystem derives its own
 * independent stream from it, so adding a noise source to one subsystem cannot
 * shift the draws another subsystem makes. The derivation itself arrives with
 * the simulator in Phase 1.
 */
export type SimulationSeed = number & { readonly [seedBrand]: 'SimulationSeed' };

/** Largest valid {@link SimulationSeed}. */
export const MAX_SIMULATION_SEED = 0xffff_ffff;

/**
 * Current scenario schema version.
 *
 * Bumped from 1 in Phase 1: targets now declare a trajectory instead of a start
 * position and velocity, and the platform declares a boresight. A version 1
 * document is rejected rather than migrated, because guessing a trajectory for
 * a config that never specified one would be inventing the experiment.
 */
export const SIMULATION_CONFIG_SCHEMA_VERSION = 2;

/**
 * Validates and tags a root seed.
 *
 * @throws {RangeError} when the value is not an integer in [0, 2^32).
 */
export function simulationSeed(value: number): SimulationSeed {
  if (!Number.isInteger(value) || value < 0 || value > MAX_SIMULATION_SEED) {
    throw new RangeError(
      `Simulation seed must be an integer in [0, ${String(MAX_SIMULATION_SEED)}], received ${String(value)}`,
    );
  }
  return value as SimulationSeed;
}

/**
 * Fixed pointing direction of the observer platform.
 *
 * A static reference direction, not a servo: Phase 1 models no gimbal control
 * loop, so this is where the mount is aimed and it stays there. Azimuth is
 * clockwise from North, elevation is positive upward.
 */
export interface BoresightConfig {
  readonly azimuth: Radians;
  readonly elevation: Radians;
}

/** Motion and disturbance of the platform carrying the gimbal. */
export interface PlatformConfig {
  readonly initialPosition: Vec3<Meters>;
  readonly initialVelocity: Vec3<MetersPerSecond>;
  /** Where the mount points. See {@link BoresightConfig}. */
  readonly boresight: BoresightConfig;
  /**
   * RMS angular disturbance injected at the gimbal base, per axis.
   *
   * Declared here but **not modelled in Phase 1**: base motion belongs with the
   * gimbal and sensor models. See docs/SIMULATION.md.
   */
  readonly baseDisturbanceRms: RadiansPerSecond;
  /** Corner frequency of the disturbance spectrum. Not modelled in Phase 1. */
  readonly baseDisturbanceBandwidth: Hertz;
}

/** One target in the scenario. */
export interface TargetConfig {
  /** Human-readable label for the UI. Not visible to a tracker. */
  readonly label: string;
  /**
   * How the target moves. Replaces the start position and velocity a Phase 0
   * config carried: with a trajectory those are part of the motion definition,
   * and keeping both would leave two sources of truth that could disagree.
   */
  readonly trajectory: TrajectoryConfig;
  /** Physical radius, which sets the target's apparent size against range. */
  readonly radius: Meters;
  /**
   * Beacon transmit power, or `null` for a passive target.
   *
   * Declared here, but Phase 1 computes no link budget, so no received power is
   * reported anywhere. See docs/SIMULATION.md.
   */
  readonly beaconPower: Watts | null;
}

/** Imaging sensor and optics. */
export interface CameraConfig {
  readonly width: Pixels;
  readonly height: Pixels;
  /** Focal length in pixels; with sensor size this fixes the field of view. */
  readonly focalLength: Pixels;
  readonly frameRate: Hertz;
  readonly exposure: Seconds;
  readonly gain: number;
  readonly format: PixelFormat;
  /** RMS read noise in electrons. */
  readonly readNoiseElectrons: number;
  /** Full-well capacity in electrons, which sets where the sensor saturates. */
  readonly fullWellElectrons: number;
  /** Per-frame probability that the sensor drops a frame entirely. */
  readonly dropoutProbability: Normalized;
}

/** Gimbal mechanics and encoder behaviour. */
export interface GimbalConfig {
  readonly azimuthLimits: GimbalAxisLimits;
  readonly elevationLimits: GimbalAxisLimits;
  /** Encoder quantisation step. */
  readonly encoderResolution: Radians;
  /** Fixed encoder bias, which calibration is meant to find. */
  readonly encoderBias: Radians;
  /** Delay between a physical angle and its appearance in `GimbalState`. */
  readonly reportingLatency: Seconds;
  /** Closed-loop bandwidth of the servo. */
  readonly servoBandwidth: Hertz;
}

/** Propagation conditions along the optical path. */
export interface AtmosphereConfig {
  /**
   * Refractive-index structure constant Cn^2, in m^(-2/3). Sets scintillation
   * depth and angle-of-arrival jitter; typical daytime near-ground values are
   * around 1e-14.
   */
  readonly refractiveIndexStructure: number;
  /** Meteorological visibility, which drives atmospheric attenuation. */
  readonly visibility: Meters;
}

/** Complete, self-contained description of one experiment. */
export interface SimulationConfig {
  /** Bumped whenever this shape changes, so stored scenarios stay readable. */
  readonly schemaVersion: 2;
  readonly id: string;
  readonly name: string;
  readonly seed: SimulationSeed;
  /** Simulated duration of the run. */
  readonly duration: Seconds;
  /**
   * Physics tick rate. Usually a multiple of the camera frame rate.
   *
   * The fixed timestep is `1 / tickRate`; simulated time is `tick / tickRate`
   * rather than an accumulated sum. See ADR-0008.
   */
  readonly tickRate: Hertz;
  readonly platform: PlatformConfig;
  readonly targets: readonly TargetConfig[];
  readonly camera: CameraConfig;
  readonly gimbal: GimbalConfig;
  readonly atmosphere: AtmosphereConfig;
}

// --- Validation -------------------------------------------------------------
//
// Configs arrive from disk and from the Scenario Lab, so they are parsed rather
// than trusted. `z.number()` already rejects NaN and Infinity in Zod 4.

const axisLimitsSchema = z.strictObject({
  minAngle: tagged<Radians>(z.number()),
  maxAngle: tagged<Radians>(z.number()),
  maxRate: tagged<RadiansPerSecond>(positiveNumber),
  maxAcceleration: positiveNumber,
});

/** Runtime schema for {@link SimulationConfig}. */
export const simulationConfigSchema = z.strictObject({
  schemaVersion: z.literal(SIMULATION_CONFIG_SCHEMA_VERSION),
  id: z.string().min(1),
  name: z.string().min(1),
  seed: z
    .number()
    .int()
    .min(0)
    .max(MAX_SIMULATION_SEED)
    .transform((v) => v as SimulationSeed),
  duration: tagged<Seconds>(positiveNumber),
  tickRate: tagged<Hertz>(positiveNumber),

  platform: z.strictObject({
    initialPosition: vec3Schema<Meters>(),
    initialVelocity: vec3Schema<MetersPerSecond>(),
    boresight: z.strictObject({
      azimuth: tagged<Radians>(z.number()),
      elevation: tagged<Radians>(z.number()),
    }),
    baseDisturbanceRms: tagged<RadiansPerSecond>(nonNegativeNumber),
    baseDisturbanceBandwidth: tagged<Hertz>(positiveNumber),
  }),

  targets: z
    .array(
      z.strictObject({
        label: z.string().min(1),
        trajectory: trajectoryConfigSchema,
        radius: tagged<Meters>(positiveNumber),
        beaconPower: tagged<Watts>(positiveNumber).nullable(),
      }),
    )
    .min(1),

  camera: z.strictObject({
    width: tagged<Pixels>(z.number().int().positive()),
    height: tagged<Pixels>(z.number().int().positive()),
    focalLength: tagged<Pixels>(positiveNumber),
    frameRate: tagged<Hertz>(positiveNumber),
    exposure: tagged<Seconds>(positiveNumber),
    gain: positiveNumber,
    format: z.enum(['mono8', 'mono16']),
    readNoiseElectrons: nonNegativeNumber,
    fullWellElectrons: positiveNumber,
    dropoutProbability: tagged<Normalized>(unitIntervalNumber),
  }),

  gimbal: z.strictObject({
    azimuthLimits: axisLimitsSchema,
    elevationLimits: axisLimitsSchema,
    encoderResolution: tagged<Radians>(positiveNumber),
    encoderBias: tagged<Radians>(z.number()),
    reportingLatency: tagged<Seconds>(nonNegativeNumber),
    servoBandwidth: tagged<Hertz>(positiveNumber),
  }),

  atmosphere: z.strictObject({
    refractiveIndexStructure: nonNegativeNumber,
    visibility: tagged<Meters>(positiveNumber),
  }),
});

/**
 * Cross-field rules that a per-field schema cannot express.
 *
 * Exposure longer than the frame period and inverted axis limits are both
 * physically impossible, and both would otherwise surface much later as
 * confusing simulator behaviour.
 */
export const validatedSimulationConfigSchema = simulationConfigSchema
  .refine((config) => config.camera.exposure <= 1 / config.camera.frameRate, {
    error: 'Camera exposure must not exceed the frame period (1 / frameRate).',
    path: ['camera', 'exposure'],
  })
  .refine((config) => config.gimbal.azimuthLimits.minAngle < config.gimbal.azimuthLimits.maxAngle, {
    error: 'Azimuth minAngle must be strictly less than maxAngle.',
    path: ['gimbal', 'azimuthLimits'],
  })
  .refine(
    (config) => config.gimbal.elevationLimits.minAngle < config.gimbal.elevationLimits.maxAngle,
    {
      error: 'Elevation minAngle must be strictly less than maxAngle.',
      path: ['gimbal', 'elevationLimits'],
    },
  )
  .refine((config) => config.tickRate >= config.camera.frameRate, {
    error: 'Physics tick rate must be at least the camera frame rate.',
    path: ['tickRate'],
  }) satisfies z.ZodType<SimulationConfig, unknown>;

/**
 * Parses an untrusted config.
 *
 * @throws {z.ZodError} listing every violated rule, not just the first.
 */
export function parseSimulationConfig(input: unknown): SimulationConfig {
  return validatedSimulationConfigSchema.parse(input);
}

/** Non-throwing variant of {@link parseSimulationConfig}. */
export function safeParseSimulationConfig(input: unknown): z.ZodSafeParseResult<SimulationConfig> {
  return validatedSimulationConfigSchema.safeParse(input);
}
