/**
 * The things a scenario contains.
 *
 * Identity is assigned deterministically from position in the config —
 * `target-0`, `target-1` — rather than from a counter, a UUID or a hash of
 * mutable state. Two runs of the same scenario must produce the same ids, or a
 * stored result could not be matched back to the entity it described.
 */

import type { TargetId } from '@/core/contracts/ground-truth';

/** Identity of the observer platform. There is exactly one per scenario. */
export const PLATFORM_ENTITY_ID = 'platform-0';

/** Deterministic id for the target at `index` in the config's target list. */
export function targetIdAt(index: number): TargetId {
  return `target-${String(index)}` as TargetId;
}

/** Deterministic id for the beacon carried by the target at `index`. */
export function beaconIdAt(index: number): string {
  return `beacon-${String(index)}`;
}

/** What kind of thing an entity is, for the observer view's legend. */
export type EntityKind = 'target' | 'beacon' | 'platform';
