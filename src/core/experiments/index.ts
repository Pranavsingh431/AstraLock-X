/**
 * Experiment recording, metrics and reporting.
 *
 * **Privileged.** The evaluator reads ground truth, so this directory is
 * unreachable from `src/core/algorithms/**` by the same lint barrier that
 * guards the simulator and the mount. Metrics describe a tracker from the
 * outside; a tracker that could reach them would be reading its own score.
 */

export * from './evaluation';
export * from './fingerprint';
export * from './metrics';
export * from './performance-log';
export * from './recompute';
export * from './recorder';
export * from './report';
export * from './schema';
export * from './serialisation';
export * from './storage';
export * from './tauri-storage';
