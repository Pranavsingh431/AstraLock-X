/**
 * The simulation core's public surface.
 *
 * Privileged: this module produces and exposes ground truth, so the lint
 * barrier stops tracking-side code importing any of it (ADR-0002, ADR-0003).
 * Legitimate consumers are the experiment runner, evaluation, and debug views
 * explicitly labelled as showing ground truth.
 */

export * from './clock';
export * from './coordinates';
export * from './engine';
export * from './entities';
export * from './observer-view';
export * from './rng';
export * from './trajectory';
export * from './vector';
export * from './world';
