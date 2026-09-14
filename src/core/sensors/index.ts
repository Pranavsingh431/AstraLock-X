/**
 * The sensor subsystem's public surface.
 *
 * **Privileged.** The barrel re-exports the virtual camera and its evaluation
 * truth, both of which consume or contain ground truth, so the lint barrier
 * stops tracking-side code importing any of it. A tracker receives a
 * `CameraSensorFrame` — which lives in `core/contracts` and carries no truth —
 * from the harness, and never constructs one.
 */

export * from './camera-clock';
export * from './emitters';
export * from './frame-pool';
export * from './pinhole';
export * from './psf';
export * from './sensor-truth';
export * from './virtual-camera';
export * from './world-sampler';
