/**
 * AstraLock-X Reference PAT.
 *
 * The robust reference algorithm. It sits alongside the Phase 4 baseline rather
 * than replacing it: the baseline is now a scientific control, and a comparison
 * needs both arms to exist.
 *
 * Same barrier as every other algorithm directory — no ground truth, no
 * simulator, no mount, no runtime, no scenarios, no evaluator.
 */

export * from './config';
export * from './controller';
export * from './evidence';
export * from './imm';
export * from './plugin';
export * from './search';
