/**
 * Pan/tilt actuator configuration and commands.
 *
 * These types are algorithm-safe. A configuration describes the *instrument* —
 * what it is capable of — and a command describes what software asked it to do.
 * Neither is ground truth: a real controller knows both, because it wrote one
 * and was given the other. What a controller does **not** get is the actuator's
 * internal mechanical state, which lives behind the ground-truth barrier in
 * `core/gimbal/actuator-truth.ts`.
 *
 * Angles are radians throughout, following the world convention: pan is
 * azimuth, clockwise from North; tilt is elevation, positive upward (ADR-0006).
 * Degrees appear at configuration boundaries and in the interface only.
 *
 * See docs/GIMBAL_MODEL.md and ADR-0011.
 */

import { z } from 'zod';

import { nonNegativeNumber, positiveNumber, tagged } from './schema';
import type { Hertz, Radians, RadiansPerSecond, RadiansPerSecondSquared, Seconds } from './units';

/**
 * One axis of the mount.
 *
 * Every field is a property of the hardware, and every one of them is something
 * a real datasheet quotes or a real mechanism exhibits. None of them is a
 * tuning knob for making the simulation behave.
 */
export interface GimbalAxisConfig {
  /** Where the axis sits at the start of a run. */
  readonly initialAngle: Radians;
  /** Hard mechanical stop, low side. */
  readonly minAngle: Radians;
  /** Hard mechanical stop, high side. */
  readonly maxAngle: Radians;
  /** Slew ceiling. */
  readonly maxRate: RadiansPerSecond;
  /** Torque ceiling, expressed as the acceleration it produces. */
  readonly maxAcceleration: RadiansPerSecondSquared;
  /**
   * Closed-loop natural frequency of the position servo.
   *
   * With the damping ratio this fixes the second-order response: how quickly
   * the axis converges on a new setpoint and how much it overshoots.
   */
  readonly naturalFrequency: Hertz;
  /**
   * Damping ratio. Below 1 overshoots, 1 is critical, above 1 crawls in.
   *
   * A real position loop is usually tuned slightly under critical.
   */
  readonly dampingRatio: number;
  /**
   * Position error the servo ignores.
   *
   * Without one, a servo chases the last bit of numerical error forever and
   * the axis never sits still — visible as a permanently jittering image.
   */
  readonly deadband: Radians;
  /**
   * Total mechanical play between motor and load, as an angle.
   *
   * Zero means direct coupling. A real geared mount has a gap that the motor
   * crosses on every reversal before the camera starts to follow.
   */
  readonly backlash: Radians;
  /** Encoder quantisation step. The measured angle is a multiple of this. */
  readonly encoderResolution: Radians;
}

/** The whole mount. */
export interface GimbalConfig {
  /** Azimuth axis, clockwise from North. */
  readonly pan: GimbalAxisConfig;
  /** Elevation axis, positive upward. */
  readonly tilt: GimbalAxisConfig;
  /**
   * Delay between a command being issued and the servo acting on it.
   *
   * Bus transport, controller scheduling and drive processing, lumped into one
   * number. Applied in simulated time at its exact value, not rounded to a
   * physics tick.
   */
  readonly commandLatency: Seconds;
}

// --- Commands ---------------------------------------------------------------

declare const commandIdBrand: unique symbol;

/** Identity of one issued command. Monotonic within a run. */
export type GimbalCommandId = number & { readonly [commandIdBrand]: 'GimbalCommandId' };

/**
 * A position setpoint for both axes.
 *
 * Phase 3 offers position mode only. A rate mode would be a second command
 * kind on this union, which is why `kind` is present on a union of one.
 */
export interface GimbalPositionCommand {
  readonly kind: 'position';
  readonly commandId: GimbalCommandId;
  /** Simulated time the command was issued. */
  readonly issuedAt: Seconds;
  readonly requestedPan: Radians;
  readonly requestedTilt: Radians;
}

export type GimbalCommand = GimbalPositionCommand;

/** What the mount did with a command once it became due. */
export interface GimbalCommandRecord {
  readonly command: GimbalCommand;
  /** `issuedAt + commandLatency`. */
  readonly dueAt: Seconds;
  /** Simulated time the setpoint actually changed. Equals `dueAt`. */
  readonly appliedAt: Seconds;
  /** Setpoint after clamping to the mechanical limits. */
  readonly acceptedPan: Radians;
  readonly acceptedTilt: Radians;
  /** True when the request lay outside an axis's travel and was clamped. */
  readonly panClamped: boolean;
  readonly tiltClamped: boolean;
}

// --- Validation -------------------------------------------------------------

/**
 * Widest damping ratio worth accepting.
 *
 * Zero is an undamped oscillator that never settles; ten is so sluggish the
 * axis would take minutes to arrive. Neither describes a mount anyone builds,
 * and both look like a typo.
 */
const MIN_DAMPING_RATIO = 0.05;
const MAX_DAMPING_RATIO = 10;

const axisSchema = z
  .strictObject({
    initialAngle: tagged<Radians>(z.number()),
    minAngle: tagged<Radians>(z.number()),
    maxAngle: tagged<Radians>(z.number()),
    maxRate: tagged<RadiansPerSecond>(positiveNumber),
    maxAcceleration: tagged<RadiansPerSecondSquared>(positiveNumber),
    naturalFrequency: tagged<Hertz>(positiveNumber),
    dampingRatio: z.number().min(MIN_DAMPING_RATIO).max(MAX_DAMPING_RATIO),
    deadband: tagged<Radians>(nonNegativeNumber),
    backlash: tagged<Radians>(nonNegativeNumber),
    // Positive rather than optional-zero: "perfect encoder" would need its own
    // documented meaning, and a zero step read as a divisor is a silent NaN.
    encoderResolution: tagged<Radians>(positiveNumber),
  })
  .refine((axis) => axis.minAngle < axis.maxAngle, {
    error: 'Axis minAngle must be strictly less than maxAngle.',
    path: ['minAngle'],
  })
  .refine((axis) => axis.initialAngle >= axis.minAngle && axis.initialAngle <= axis.maxAngle, {
    error: 'Axis initialAngle must lie within its travel limits.',
    path: ['initialAngle'],
  })
  .refine((axis) => axis.backlash <= axis.maxAngle - axis.minAngle, {
    error: 'Axis backlash cannot exceed its total travel.',
    path: ['backlash'],
  });

/** Runtime schema for {@link GimbalConfig}. */
export const gimbalConfigSchema = z.strictObject({
  pan: axisSchema,
  tilt: axisSchema,
  commandLatency: tagged<Seconds>(nonNegativeNumber),
}) satisfies z.ZodType<GimbalConfig, unknown>;

/**
 * Largest `omega_n * dt` the integrator is allowed to run at.
 *
 * Semi-implicit Euler on a damped oscillator is stable up to roughly
 * `omega_n * dt < 2`; this is four times inside that, which is an **accuracy**
 * bound rather than a stability one. At 0.5 the discrete response tracks the
 * continuous one to well under a percent (measured in the numerical validation
 * test), and the margin means no configuration that validates can be marginal.
 *
 * See docs/GIMBAL_MODEL.md.
 */
export const MAX_SERVO_OMEGA_TIMESTEP = 0.5;

/** `omega_n * dt` for an axis at a given physics tick rate. */
export const servoStepParameter = (axis: GimbalAxisConfig, tickRateHz: number): number =>
  (2 * Math.PI * axis.naturalFrequency) / tickRateHz;
