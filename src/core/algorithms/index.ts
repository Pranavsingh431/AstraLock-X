/**
 * The algorithm registry.
 *
 * Plugins are listed here so the UI and, later, AstraBench can enumerate what
 * is available without importing each one by path.
 */

import type { AlgorithmPlugin } from '@/core/contracts/algorithm-plugin';

import { baselineKfPidPat } from './baseline';

/**
 * Every algorithm shipped with the application.
 *
 * `unknown` rather than a concrete pair: the registry is heterogeneous by
 * definition — each plugin has its own config and debug types — and its job is
 * to hold them side by side so the UI can list them. A consumer that needs a
 * plugin's real types imports that plugin directly.
 */
export const ALGORITHMS: readonly AlgorithmPlugin<unknown, unknown>[] = [baselineKfPidPat];

export const DEFAULT_ALGORITHM_ID = baselineKfPidPat.manifest.id;

export { baselineKfPidPat };
export type { BaselineDebug, BaselineState } from './baseline';
export { DEFAULT_BASELINE_PAT_CONFIG, type BaselinePatConfig } from './baseline';
