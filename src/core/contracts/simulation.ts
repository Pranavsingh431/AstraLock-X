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
import type { GimbalAxisLimits, PixelFormat } from './sensors';
import type {
  AnyQuantity,
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

/** Motion and disturbance of the platform carrying the gimbal. */
export interface PlatformConfig {
  readonly initialPosition: Vec3<Meters>;
  readonly initialVelocity: Vec3<MetersPerSecond>;
  /** RMS angular disturbance injected at the gimbal base, per axis. */
  readonly baseDisturbanceRms: RadiansPerSecond;
  /** Corner frequency of the disturbance spectrum. */
  readonly baseDisturbanceBandwidth: Hertz;
}

/** One target in the scenario. */
export interface TargetConfig {
  /** Human-readable label for the UI. Not visible to a tracker. */
  readonly label: string;
  readonly initialPosition: Vec3<Meters>;
  readonly initialVelocity: Vec3<MetersPerSecond>;
  /** Physical radius, which sets the target's apparent size against range. */
  readonly radius: Meters;
  /** Optical beacon power, or `null` for a passive target. */
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
  readonly schemaVersion: 1;
  readonly id: string;
  readonly name: string;
  readonly seed: SimulationSeed;
  /** Simulated duration of the run. */
  readonly duration: Seconds;
  /** Physics tick rate. Usually a multiple of the camera frame rate. */
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

const tagged = <Q extends AnyQuantity>(base: z.ZodNumber) => base.transform((value) => value as Q);

const positive = z.number().positive();
const nonNegative = z.number().nonnegative();
const unitInterval = z.number().min(0).max(1);

const vec3 = <Q extends AnyQuantity>(): z.ZodType<Vec3<Q>> =>
  z.strictObject({
    x: tagged<Q>(z.number()),
    y: tagged<Q>(z.number()),
    z: tagged<Q>(z.number()),
  });

const axisLimitsSchema = z.strictObject({
  minAngle: tagged<Radians>(z.number()),
  maxAngle: tagged<Radians>(z.number()),
  maxRate: tagged<RadiansPerSecond>(positive),
  maxAcceleration: positive,
});

/** Runtime schema for {@link SimulationConfig}. */
export const simulationConfigSchema = z.strictObject({
  schemaVersion: z.literal(1),
  id: z.string().min(1),
  name: z.string().min(1),
  seed: z
    .number()
    .int()
    .min(0)
    .max(MAX_SIMULATION_SEED)
    .transform((v) => v as SimulationSeed),
  duration: tagged<Seconds>(positive),
  tickRate: tagged<Hertz>(positive),

  platform: z.strictObject({
    initialPosition: vec3<Meters>(),
    initialVelocity: vec3<MetersPerSecond>(),
    baseDisturbanceRms: tagged<RadiansPerSecond>(nonNegative),
    baseDisturbanceBandwidth: tagged<Hertz>(positive),
  }),

  targets: z
    .array(
      z.strictObject({
        label: z.string().min(1),
        initialPosition: vec3<Meters>(),
        initialVelocity: vec3<MetersPerSecond>(),
        radius: tagged<Meters>(positive),
        beaconPower: tagged<Watts>(positive).nullable(),
      }),
    )
    .min(1),

  camera: z.strictObject({
    width: tagged<Pixels>(z.number().int().positive()),
    height: tagged<Pixels>(z.number().int().positive()),
    focalLength: tagged<Pixels>(positive),
    frameRate: tagged<Hertz>(positive),
    exposure: tagged<Seconds>(positive),
    gain: positive,
    format: z.enum(['mono8', 'mono16']),
    readNoiseElectrons: nonNegative,
    fullWellElectrons: positive,
    dropoutProbability: tagged<Normalized>(unitInterval),
  }),

  gimbal: z.strictObject({
    azimuthLimits: axisLimitsSchema,
    elevationLimits: axisLimitsSchema,
    encoderResolution: tagged<Radians>(positive),
    encoderBias: tagged<Radians>(z.number()),
    reportingLatency: tagged<Seconds>(nonNegative),
    servoBandwidth: tagged<Hertz>(positive),
  }),

  atmosphere: z.strictObject({
    refractiveIndexStructure: nonNegative,
    visibility: tagged<Meters>(positive),
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
