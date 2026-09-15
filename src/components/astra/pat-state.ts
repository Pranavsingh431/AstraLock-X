/**
 * How each PAT state is presented, in one place.
 *
 * The state appears in at least four places — the title bar, the sensor feed,
 * the timeline, the benchmark tables — and they must agree. A state that is
 * amber in one panel and green in another is worse than no colour at all,
 * because a reader who has learned the palette is then being actively misled.
 *
 * Every entry carries a word as well as a colour. Nothing in this application
 * may be distinguishable only by hue: a grayscale screenshot, a projector with
 * a blue cast, and a reader with deuteranopia all have to get the same answer.
 *
 * The three words that are not the state's internal name are deliberate:
 *
 *   scan       → SEARCH    "scan" reads as a sensor mode rather than a phase
 *   reacquire  → RECOVER   shorter, and what it is doing rather than its goal
 *   handoff    → HANDOFF READY  it is a claim of readiness, not of fine
 *                          pointing; no fine-pointing actuator exists
 */

import type { PATMode } from '@/core/contracts/pat';

import type { Status } from './readout';

export interface PatStatePresentation {
  readonly label: string;
  readonly status: Status;
  /** Reserved for states an operator must not miss. */
  readonly pulse?: boolean;
}

export const PAT_STATE: Record<PATMode, PatStatePresentation> = {
  idle: { label: 'Idle', status: 'idle' },
  scan: { label: 'Search', status: 'active' },
  acquire: { label: 'Acquire', status: 'active' },
  track: { label: 'Track', status: 'nominal' },
  handoff: { label: 'Handoff ready', status: 'nominal' },
  reacquire: { label: 'Recover', status: 'recovering', pulse: true },
  lost: { label: 'Lost', status: 'fault', pulse: true },
  fault: { label: 'Fault', status: 'fault', pulse: true },
};
