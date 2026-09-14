/**
 * What the simulator knows about the mount.
 *
 * **Privileged, and branded as ground truth.** This is the mechanism's interior:
 * where the motor really is, how fast it is really moving, how much of the
 * backlash gap has been taken up, and what the servo demanded before the
 * torque limit clipped it.
 *
 * None of it is observable on real hardware. A controller sees an encoder
 * count; everything else here is the answer key that makes it possible to check
 * whether a future controller is doing what it thinks it is doing.
 *
 * See docs/adr/0011-true-versus-measured-actuator-state.md.
 */

import { brandAsGroundTruth } from '@/core/contracts/ground-truth';
import type { GimbalCommandRecord } from '@/core/contracts/gimbal';
import type { GroundTruthTainted } from '@/core/contracts/isolation';
import type { Seconds } from '@/core/contracts/units';

import type { AxisState } from './axis';
import type { PendingCommand } from './command-queue';

/** One axis, from the inside. */
export interface AxisTruth extends GroundTruthTainted {
  readonly setpoint: number;
  readonly motorAngle: number;
  readonly motorRate: number;
  readonly outputAngle: number;
  readonly outputRate: number;
  readonly commandedAcceleration: number;
  readonly appliedAcceleration: number;
  /**
   * How far the load sits from the motor, in radians.
   *
   * Zero when the gearing is taken up; up to half the backlash width during a
   * reversal. Watching this go to zero and back is watching the play being
   * crossed.
   */
  readonly backlashDisplacement: number;
  /** Reported angle minus true angle. Bounded by half a count. */
  readonly encoderError: number;
  readonly atMinLimit: boolean;
  readonly atMaxLimit: boolean;
  readonly rateSaturated: boolean;
  readonly accelerationSaturated: boolean;
}

/** The whole mount, from the inside, at one instant. */
export interface ActuatorTruth extends GroundTruthTainted {
  readonly time: Seconds;
  readonly pan: AxisTruth;
  readonly tilt: AxisTruth;
  /** Commands issued but not yet due. */
  readonly pendingCommands: readonly PendingCommand[];
  /** The most recently applied command, or `null` before the first. */
  readonly lastApplied: GimbalCommandRecord | null;
}

/** Brands one axis record. */
export function brandAxisTruth(value: Omit<AxisTruth, keyof GroundTruthTainted>): AxisTruth {
  return brandAsGroundTruth(value);
}

/** Brands a whole-mount record. */
export function brandActuatorTruth(
  value: Omit<ActuatorTruth, keyof GroundTruthTainted>,
): ActuatorTruth {
  return brandAsGroundTruth(value);
}

/** Builds an axis truth record from raw axis state. */
export function axisTruthFrom(state: AxisState, encoderError: number): AxisTruth {
  return brandAxisTruth({
    setpoint: state.setpoint,
    motorAngle: state.motorAngle,
    motorRate: state.motorRate,
    outputAngle: state.outputAngle,
    outputRate: state.outputRate,
    commandedAcceleration: state.commandedAcceleration,
    appliedAcceleration: state.appliedAcceleration,
    backlashDisplacement: state.motorAngle - state.outputAngle,
    encoderError,
    atMinLimit: state.flags.atMinLimit,
    atMaxLimit: state.flags.atMaxLimit,
    rateSaturated: state.flags.rateSaturated,
    accelerationSaturated: state.flags.accelerationSaturated,
  });
}
