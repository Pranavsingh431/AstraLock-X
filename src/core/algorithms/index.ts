/**
 * The algorithm registry.
 *
 * Plugins are listed here so the interface and AstraBench can enumerate what is
 * available without importing each one by path.
 *
 * ## Registration is a source change, on purpose
 *
 * Every entry is imported statically and compiled in. There is no path that
 * loads a plugin from a URL, a downloaded bundle, or a string of JavaScript, and
 * that is a deliberate limit rather than an unfinished feature: a benchmark host
 * that executed arbitrary code on the operator's machine would be a much larger
 * security question than a benchmark deserves. Adding an algorithm means adding
 * a file and a line here, which is a reviewable act.
 *
 * What the contract buys instead is that adding one requires **no change to the
 * simulator**. `example/plugin.ts` is the proof: it imports the contracts
 * directory and nothing else. See docs/ALGORITHM_PLUGIN.md.
 */

import type { AlgorithmPlugin } from '@/core/contracts/algorithm-plugin';

import { astraLockXPat } from './astralock';
import { baselineKfPidPat } from './baseline';
import { exampleScanPat } from './example';

/**
 * How an entry is meant to be used.
 *
 * `tracker` is a real algorithm; `reference` is a worked example of the plugin
 * contract that does not track. The distinction is recorded rather than left to
 * a reader's judgement, because a benchmark that put a non-tracker in a headline
 * comparison would produce a number that flatters the tracker and measures
 * nothing.
 */
export type AlgorithmKind = 'tracker' | 'reference';

export interface AlgorithmRegistration {
  readonly plugin: AlgorithmPlugin<unknown, unknown>;
  readonly kind: AlgorithmKind;
}

/**
 * Every algorithm shipped with the application.
 *
 * `unknown` rather than a concrete pair: the registry is heterogeneous by
 * definition — each plugin has its own config and debug types — and its job is
 * to hold them side by side. A consumer that needs a plugin's real types
 * imports that plugin directly.
 */
export const ALGORITHM_REGISTRY: readonly AlgorithmRegistration[] = [
  { plugin: baselineKfPidPat, kind: 'tracker' },
  { plugin: astraLockXPat, kind: 'tracker' },
  { plugin: exampleScanPat, kind: 'reference' },
];

/** Every registered plugin, in registration order. */
export const ALGORITHMS: readonly AlgorithmPlugin<unknown, unknown>[] = ALGORITHM_REGISTRY.map(
  (entry) => entry.plugin,
);

/** The plugins that actually track, which is what a comparison may contain. */
export const TRACKER_ALGORITHMS: readonly AlgorithmPlugin<unknown, unknown>[] =
  ALGORITHM_REGISTRY.filter((entry) => entry.kind === 'tracker').map((entry) => entry.plugin);

/** Looks a plugin up by its manifest id. */
export const algorithmById = (id: string): AlgorithmPlugin<unknown, unknown> | undefined =>
  ALGORITHMS.find((plugin) => plugin.manifest.id === id);

/** How a registered plugin is meant to be used, or `undefined` if unregistered. */
export const algorithmKindOf = (id: string): AlgorithmKind | undefined =>
  ALGORITHM_REGISTRY.find((entry) => entry.plugin.manifest.id === id)?.kind;

export const DEFAULT_ALGORITHM_ID = baselineKfPidPat.manifest.id;

export { astraLockXPat, baselineKfPidPat, exampleScanPat };
export type { BaselineDebug, BaselineState } from './baseline';
export type { AstraLockDebug, AstraLockState } from './astralock';
export { DEFAULT_ASTRALOCK_CONFIG, type AstraLockConfig } from './astralock';
export { DEFAULT_BASELINE_PAT_CONFIG, type BaselinePatConfig } from './baseline';
export {
  DEFAULT_EXAMPLE_SCAN_CONFIG,
  type ExampleScanConfig,
  type ExampleScanDebug,
} from './example';
export {
  DEFAULT_TERMINAL_PROFILE_ID,
  TERMINAL_BEACON_PROFILES,
  expectedBeaconProfileOf,
  terminalProfileById,
  withExpectedBeacon,
  type TerminalBeaconProfile,
} from './astralock';
