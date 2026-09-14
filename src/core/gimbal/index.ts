/**
 * The pan/tilt actuator subsystem.
 *
 * **Privileged.** The barrel exposes the mount's true mechanical state, so the
 * lint barrier stops tracking-side code importing any of it. A controller
 * issues `GimbalCommand`s — which live in `core/contracts/gimbal` and carry no
 * truth — and reads the measured pose off the camera frame.
 */

export * from './actuator-truth';
export * from './axis';
export * from './command-queue';
export * from './command-script';
export * from './dynamic-gimbal';
export * from './encoder';
