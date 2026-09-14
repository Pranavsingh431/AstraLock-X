/**
 * Public contract surface.
 *
 * Everything re-exported here is safe for any part of the application to
 * import, including tracking algorithms.
 *
 * `ground-truth.ts` is deliberately absent. Obtaining `GroundTruthState`,
 * `WorldState` or `TargetId` requires naming that module directly, which keeps
 * every privileged dependency visible in review and lets the lint barrier in
 * eslint.config.js block it from the tracking side outright.
 *
 * See docs/adr/0003-ground-truth-isolation.md.
 */

export * from './units';
export * from './geometry';
export * from './isolation';
export * from './sensors';
export * from './perception';
export * from './estimation';
export * from './control';
export * from './pat';
export * from './telemetry';
export * from './simulation';
export * from './experiments';
export * from './algorithm-plugin';
