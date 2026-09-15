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

import { CLEAN_DISTURBANCES, type DisturbanceConfig, disturbanceConfigSchema } from './disturbance';
import type { CodeSymbol } from './code-waveform';
import type { Vec3 } from './geometry';
import { positiveNumber, tagged, unitIntervalNumber, vec3Schema } from './schema';
import {
  type GimbalConfig,
  gimbalConfigSchema,
  servoStepParameter,
  MAX_SERVO_OMEGA_TIMESTEP,
} from './gimbal';
import type { PixelFormat } from './sensors';
import { type TrajectoryConfig, trajectoryConfigSchema } from './trajectory';
import type {
  Hertz,
  Meters,
  MetersPerSecond,
  Normalized,
  Pixels,
  Radians,
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
 * Version 2 (Phase 1) replaced a target's start position and velocity with a
 * trajectory, and gave the platform a boresight. Version 3 (Phase 2) gives the
 * camera a real optical description — field of view, ranges, initial pointing —
 * and replaces a target's bare `beaconPower` with a beacon that has apparent
 * optical properties. Version 4 (Phase 3) replaces the static mount with a
 * dynamic actuator, and consolidates initial pointing — previously declared in
 * three places — into the gimbal's own axis angles. Version 5 (Phase 7) adds
 * the `disturbances` block and drops five placeholder fields that declared
 * effects the simulator never produced.
 *
 * Older documents are rejected rather than migrated, with **one** exception,
 * version 4 to version 5. Guessing a field of view for a config that never
 * specified one would be inventing the instrument. Inserting "no disturbances"
 * into a version-4 document is not a guess: a version-4 simulator could not
 * produce a disturbance, so a version-4 scenario demonstrably ran with none.
 * Recording what was already true is migration; the rejected cases were all
 * inventions. See {@link migrateScenarioDocument}.
 */
export const SIMULATION_CONFIG_SCHEMA_VERSION = 5;

/** The one older version {@link migrateScenarioDocument} can read. */
export const MIGRATABLE_SCENARIO_VERSION = 4;

/**
 * Largest image dimension a scenario may ask for.
 *
 * 8192 is far beyond any sensor this project models and still bounds a single
 * frame to 64 MB, which keeps a typo from turning into an allocation failure.
 */
export const MAX_IMAGE_DIMENSION = 8192;

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
  /** Optical beacon carried by this target, or `null` for a passive target. */
  readonly beacon: BeaconConfig | null;
}

/**
 * A temporal intensity code carried by a beacon.
 *
 * The beacon holds `onIntensity` while sending a 1 and `offIntensity` while
 * sending a 0, both as multipliers on the beacon's own `intensity`. Symbol `k`
 * of the sequence starts at `phaseOffset + k * symbolDuration`.
 *
 * **`offIntensity` is deliberately not required to be zero.** A beacon that
 * switches fully off vanishes from the image for the whole of every zero
 * symbol, and a tracker cannot follow something that is absent a third of the
 * time. A modulation depth — bright and less bright — keeps the source
 * continuously trackable while still carrying the pattern, which is how a
 * beacon that has to be both followed and identified would actually be built.
 * Full on-off keying remains expressible by setting `offIntensity` to zero, and
 * the consequences of doing so are the scenario author's to accept.
 *
 * Symbol duration must be long enough that the camera can resolve the pattern;
 * see docs/BEACON_IDENTITY.md for why that rules out sampling a high-frequency
 * carrier, and `validatedSimulationConfigSchema` for the rule that enforces it.
 */
export interface BeaconIdentityCodeConfig {
  readonly enabled: boolean;
  /** Binary symbols. Non-empty; the pattern, not an identifier. */
  readonly sequence: readonly CodeSymbol[];
  readonly symbolDuration: Seconds;
  /** When symbol 0 begins, in simulated seconds. */
  readonly phaseOffset: Seconds;
  /** Multiplier on the beacon's intensity while sending a 1. */
  readonly onIntensity: Normalized;
  /** Multiplier on the beacon's intensity while sending a 0. */
  readonly offIntensity: Normalized;
  /** Whether the sequence repeats, or is sent once and then held on. */
  readonly repeat: boolean;
}

/**
 * An optical emitter carried by a target.
 *
 * Emission is ideal in every respect except the two the project has since
 * modelled: `intensity` is a fixed apparent peak with no range falloff, and a
 * real link budget would make it a function of `transmitPower`, range and
 * atmosphere. `transmitPower` is declared but unused.
 *
 * Phase 7 gave the *path* a time dependence (attenuation, scintillation).
 * Phase 8 gives the *source* one: `identityCode`, when present and enabled,
 * modulates the emitted intensity in time so that a receiver can tell one
 * source from another by watching it rather than by being told.
 */
export interface BeaconConfig {
  /** Emitted optical power. Declared; no link budget is computed yet. */
  readonly transmitPower: Watts;
  /**
   * Peak apparent intensity in a clean image, on [0, 1] of the format's full
   * range. Constant with range, by design.
   */
  readonly intensity: Normalized;
  /** Standard deviation of the point-spread function, in pixels. */
  readonly psfSigma: Pixels;
  /** Temporal identity code, or `null` for an unmodulated source. */
  readonly identityCode: BeaconIdentityCodeConfig | null;
}

/**
 * How the vertical field of view follows from the horizontal one.
 *
 * `square-pixels` sets `fy = fx`, so the vertical field of view is
 * `2 atan(height / (2 fx))` — the right model for a sensor whose photosites are
 * square, which covers every machine-vision camera this project will meet. It
 * is a named policy rather than an implicit assumption so that a non-square
 * pixel model can be added later without anyone having to guess what the old
 * scenarios meant.
 */
export type VerticalFovPolicy = 'square-pixels';

/** Principal point, in continuous image coordinates. */
export interface PrincipalPointConfig {
  readonly x: Pixels;
  readonly y: Pixels;
}

/** Imaging sensor and optics. */
export interface CameraConfig {
  readonly width: Pixels;
  readonly height: Pixels;
  /**
   * Horizontal field of view. Focal length follows:
   * `fx = width / (2 tan(hfov / 2))`.
   *
   * Declared as an angle rather than a focal length because an angle is what a
   * lens datasheet quotes and what an operator reasons about; a focal length in
   * pixels is meaningless without also knowing the sensor width.
   */
  readonly horizontalFov: Radians;
  readonly verticalFovPolicy: VerticalFovPolicy;
  /**
   * Principal point, or `null` for the image centre.
   *
   * Image coordinates are continuous with pixel centres at half-integers, so
   * the centre of a `width x height` image is `(width / 2, height / 2)`. See
   * docs/SENSOR_MODEL.md.
   */
  readonly principalPoint: PrincipalPointConfig | null;
  /** Nothing closer than this projects. */
  readonly nearRange: Meters;
  /** Nothing further than this projects. */
  readonly farRange: Meters;
  readonly frameRate: Hertz;
  /**
   * Uniform background level on [0, 1], scaled to the format's full range.
   *
   * Phase 2 models an ideal noiseless sensor, so this is a flat pedestal rather
   * than a dark current. Usually zero.
   */
  readonly backgroundLevel: Normalized;
  readonly exposure: Seconds;
  readonly gain: number;
  readonly format: PixelFormat;
}

/** Complete, self-contained description of one experiment. */
export interface SimulationConfig {
  /** Bumped whenever this shape changes, so stored scenarios stay readable. */
  readonly schemaVersion: 5;
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
  /**
   * Physical disturbances acting on this run.
   *
   * Replaces version 4's `atmosphere`, which declared a refractive-index
   * structure constant and a meteorological visibility that nothing read. Those
   * are inputs to a propagation model this project does not run; carrying them
   * implied a fidelity that did not exist. What is here instead are the
   * camera-observable effects that are actually computed.
   */
  readonly disturbances: DisturbanceConfig;
}

// --- Validation -------------------------------------------------------------
//
// Configs arrive from disk and from the Scenario Lab, so they are parsed rather
// than trusted. `z.number()` already rejects NaN and Infinity in Zod 4.

/**
 * Runtime schema for {@link BeaconIdentityCodeConfig}.
 *
 * Bounds are engineering limits rather than taste. A sequence longer than 1024
 * symbols cannot be observed inside any run this project supports; a symbol
 * shorter than a microsecond is not a thing a camera can see; and `offIntensity`
 * below `onIntensity` is what makes the modulation a modulation rather than a
 * constant.
 */
export const beaconIdentityCodeSchema = z
  .strictObject({
    enabled: z.boolean(),
    sequence: z
      .array(z.union([z.literal(0), z.literal(1)]))
      .min(1)
      .max(1024),
    symbolDuration: tagged<Seconds>(z.number().positive().min(1e-6).max(60)),
    phaseOffset: tagged<Seconds>(z.number().finite().min(-3600).max(3600)),
    onIntensity: tagged<Normalized>(unitIntervalNumber),
    offIntensity: tagged<Normalized>(unitIntervalNumber),
    repeat: z.boolean(),
  })
  .refine((code) => code.offIntensity < code.onIntensity, {
    error: 'Beacon offIntensity must be below onIntensity, or the code carries no information.',
    path: ['offIntensity'],
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
  }),

  targets: z
    .array(
      z.strictObject({
        label: z.string().min(1),
        trajectory: trajectoryConfigSchema,
        radius: tagged<Meters>(positiveNumber),
        beacon: z
          .strictObject({
            transmitPower: tagged<Watts>(positiveNumber),
            intensity: tagged<Normalized>(unitIntervalNumber),
            psfSigma: tagged<Pixels>(positiveNumber.max(64)),
            identityCode: beaconIdentityCodeSchema.nullable().default(null),
          })
          .nullable(),
      }),
    )
    .min(1),

  camera: z
    .strictObject({
      // Bounded above as well as below: a scenario asking for a 100,000-pixel
      // image is a typo, and finding that out as an allocation failure is worse
      // than finding it out as a validation error.
      width: tagged<Pixels>(z.number().int().positive().max(MAX_IMAGE_DIMENSION)),
      height: tagged<Pixels>(z.number().int().positive().max(MAX_IMAGE_DIMENSION)),
      horizontalFov: tagged<Radians>(z.number().positive().lt(Math.PI)),
      verticalFovPolicy: z.enum(['square-pixels']),
      principalPoint: z
        .strictObject({
          x: tagged<Pixels>(z.number()),
          y: tagged<Pixels>(z.number()),
        })
        .nullable(),
      nearRange: tagged<Meters>(positiveNumber),
      farRange: tagged<Meters>(positiveNumber),
      frameRate: tagged<Hertz>(positiveNumber),
      backgroundLevel: tagged<Normalized>(unitIntervalNumber),
      exposure: tagged<Seconds>(positiveNumber),
      gain: positiveNumber,
      format: z.enum(['mono8', 'mono16']),
    })
    .refine((camera) => camera.nearRange < camera.farRange, {
      error: 'Camera nearRange must be strictly less than farRange.',
      path: ['nearRange'],
    })
    .refine(
      (camera) =>
        camera.principalPoint === null ||
        (camera.principalPoint.x >= 0 &&
          camera.principalPoint.x <= camera.width &&
          camera.principalPoint.y >= 0 &&
          camera.principalPoint.y <= camera.height),
      {
        error: 'Principal point must lie within the image bounds.',
        path: ['principalPoint'],
      },
    ),

  gimbal: gimbalConfigSchema,

  disturbances: disturbanceConfigSchema,
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
  .refine((config) => config.tickRate >= config.camera.frameRate, {
    error: 'Physics tick rate must be at least the camera frame rate.',
    path: ['tickRate'],
  })
  .refine(
    (config) => servoStepParameter(config.gimbal.pan, config.tickRate) <= MAX_SERVO_OMEGA_TIMESTEP,
    {
      // A servo fast enough to be inaccurate at the configured tick is a
      // configuration error, not something to discover as a wobbling axis.
      error:
        'Pan servo is too fast for the physics tick: 2*pi*naturalFrequency / tickRate must not exceed 0.5.',
      path: ['gimbal', 'pan', 'naturalFrequency'],
    },
  )
  .refine(
    (config) => servoStepParameter(config.gimbal.tilt, config.tickRate) <= MAX_SERVO_OMEGA_TIMESTEP,
    {
      error:
        'Tilt servo is too fast for the physics tick: 2*pi*naturalFrequency / tickRate must not exceed 0.5.',
      path: ['gimbal', 'tilt', 'naturalFrequency'],
    },
  )
  /*
   * A code the camera cannot resolve is not a code.
   *
   * The camera integrates over each exposure and reports one number per frame,
   * so a symbol shorter than two frame periods cannot be recovered from that
   * stream at all — the sampled sequence aliases, and no amount of correlation
   * afterwards puts the information back. This is the rule that stops a
   * scenario declaring a megahertz beacon and a 60 fps camera and quietly
   * pretending the two are compatible.
   *
   * Two frames per symbol is the Nyquist floor. The bundled scenarios use four,
   * because dropped frames and noise eat into the margin; see
   * docs/BEACON_IDENTITY.md.
   */
  .refine(
    (config) =>
      config.targets.every((target) => {
        const code = target.beacon?.identityCode;
        if (code == null || !code.enabled) return true;
        return code.symbolDuration >= 2 / config.camera.frameRate;
      }),
    {
      error:
        'A beacon symbol must last at least two camera frame periods, or the camera cannot resolve the code.',
      path: ['targets'],
    },
  ) satisfies z.ZodType<SimulationConfig, unknown>;

/**
 * Brings a version-4 scenario document up to version 5.
 *
 * Version 4 documents are the ones stored inside every Phase 3 to Phase 6
 * experiment, and those runs must stay re-runnable: a recorded experiment whose
 * scenario can no longer be loaded is no longer reproducible, which is most of
 * what the recording was for.
 *
 * Two things happen, and neither invents anything:
 *
 *  - `disturbances` is set to {@link CLEAN_DISTURBANCES}. A version-4 simulator
 *    had no disturbance model at all, so every version-4 run demonstrably had
 *    none. This records a fact rather than choosing a value.
 *  - Five fields are dropped: `platform.baseDisturbanceRms`,
 *    `platform.baseDisturbanceBandwidth`, `camera.readNoiseElectrons`,
 *    `camera.fullWellElectrons` and `camera.dropoutProbability`, along with the
 *    whole `atmosphere` block. Every one of them was declared and never read.
 *    Carrying them forward next to fields that *are* now modelled would leave
 *    two spellings of the same idea, one of which does nothing — and one of
 *    them, `readNoiseElectrons`, would claim a calibrated electron unit that
 *    this sensor cannot support.
 *
 * Anything that is not version 4 or 5 is returned untouched, so it fails
 * validation with its own version in the error rather than a confusing one.
 *
 * @returns a new document; the input is not modified.
 */
export function migrateScenarioDocument(input: unknown): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return input;

  const document = input as Record<string, unknown>;
  if (document['schemaVersion'] !== MIGRATABLE_SCENARIO_VERSION) return input;

  const migrated: Record<string, unknown> = { ...document };
  migrated['schemaVersion'] = SIMULATION_CONFIG_SCHEMA_VERSION;
  delete migrated['atmosphere'];

  const platform = migrated['platform'];
  if (typeof platform === 'object' && platform !== null) {
    const next = { ...(platform as Record<string, unknown>) };
    delete next['baseDisturbanceRms'];
    delete next['baseDisturbanceBandwidth'];
    migrated['platform'] = next;
  }

  const camera = migrated['camera'];
  if (typeof camera === 'object' && camera !== null) {
    const next = { ...(camera as Record<string, unknown>) };
    delete next['readNoiseElectrons'];
    delete next['fullWellElectrons'];
    delete next['dropoutProbability'];
    migrated['camera'] = next;
  }

  migrated['disturbances'] = CLEAN_DISTURBANCES;
  return migrated;
}

/**
 * Parses an untrusted config, migrating a version-4 document first.
 *
 * @throws {z.ZodError} listing every violated rule, not just the first.
 */
export function parseSimulationConfig(input: unknown): SimulationConfig {
  return validatedSimulationConfigSchema.parse(migrateScenarioDocument(input));
}

/** Non-throwing variant of {@link parseSimulationConfig}. */
export function safeParseSimulationConfig(input: unknown): z.ZodSafeParseResult<SimulationConfig> {
  return validatedSimulationConfigSchema.safeParse(migrateScenarioDocument(input));
}
