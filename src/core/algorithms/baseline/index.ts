/**
 * The baseline PAT algorithm.
 *
 * Everything exported here is algorithm-side: it consumes `TrackingInput` and
 * produces a command intent. Nothing in this directory may import the
 * simulator, the sensor implementation, the mount implementation, evaluation,
 * or the ground-truth module — enforced by the lint barrier and by the
 * compile-time admission check in `defineAlgorithm`.
 */

export * from './angles';
export * from './bearing';
export * from './config';
export * from './detector';
export * from './kalman';
export * from './pid';
export * from './plugin';
export * from './search';
