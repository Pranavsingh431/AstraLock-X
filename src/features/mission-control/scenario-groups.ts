/**
 * The bundled scenarios, grouped by what they exercise.
 *
 * Grouping only. Every entry is a scenario that already exists, under its own
 * name, with its own physics — there is no preset here whose configuration is
 * not on disk, and no "easier" variant of a hard case. Thirty-five scenarios in
 * one flat list is a list nobody reads; the same thirty-five under six headings
 * is a menu.
 *
 * The order within a group runs from the simplest case to the one that breaks
 * something, because that is the order someone demonstrating the system wants.
 */

import { SCENARIO_IDS, type ScenarioId } from '@/scenarios';

export interface ScenarioGroup {
  readonly label: string;
  readonly ids: readonly ScenarioId[];
}

export const SCENARIO_GROUPS: readonly ScenarioGroup[] = [
  {
    label: 'PAT — clean',
    ids: [
      'astralock-stationary',
      'astralock-moving',
      'pat-stationary-outside-fov',
      'pat-moving-target',
    ],
  },
  {
    label: 'PAT — motion, recovery, handoff',
    ids: ['astralock-maneuver', 'astralock-short-loss', 'astralock-handoff', 'pat-loss'],
  },
  {
    label: 'Disturbance',
    ids: [
      'dist-vibration',
      'dist-vibration-extreme',
      'dist-low-contrast',
      'dist-frame-loss',
      'dist-combined',
    ],
  },
  {
    label: 'False source',
    ids: ['dist-decoy-easy', 'dist-decoy-hard'],
  },
  {
    label: 'Coded identity',
    ids: [
      'code-clean',
      'code-decoy-easy',
      'code-decoy-uncoded',
      'code-decoy-wrong',
      'code-decoy-hard',
      'code-ambiguous',
      'code-identical',
      'code-insufficient',
      'code-frame-loss',
    ],
  },
  {
    label: 'Simulator and mount',
    ids: [
      'stationary',
      'linear-pass',
      'circular',
      'sinusoidal',
      'waypoints',
      'seeded-maneuver',
      'camera-boresight',
      'camera-target-outside-fov',
      'gimbal-step-response',
      'gimbal-latency',
      'gimbal-backlash',
    ],
  },
];

/**
 * What each scenario is for, in one line.
 *
 * Derived from the scenario's actual purpose rather than its name, because
 * "dist-decoy-hard" does not tell a reader that the decoy crosses inside the
 * track gate — which is the whole point of loading it.
 */
export const SCENARIO_PURPOSE: Partial<Record<ScenarioId, string>> = {
  'astralock-stationary': 'A stationary beacon outside the field of view: the mount must search.',
  'astralock-moving': 'A constant-velocity pass. Neither tracker should struggle.',
  'astralock-maneuver': 'Sustained angular acceleration, which exercises IMM model switching.',
  'astralock-short-loss': 'The beacon disappears briefly and returns near the prediction.',
  'astralock-handoff': 'A target steady enough to justify a coarse-to-fine handoff claim.',
  'pat-stationary-outside-fov': 'The Phase 4 baseline case: acquisition by scan.',
  'pat-moving-target': 'A gentle crossing target for the baseline tracker.',
  'pat-loss': 'A target that outruns the baseline and is lost.',
  'dist-vibration': 'Platform base attitude the encoder cannot see.',
  'dist-vibration-extreme': 'Vibration beyond what the mount can follow.',
  'dist-low-contrast': 'A dim beacon against shot and read noise.',
  'dist-frame-loss': 'Bursty transport loss: frames that never arrive.',
  'dist-combined': 'Vibration, attenuation, noise and dropout together.',
  'dist-decoy-easy': 'A bright source well off the predicted bearing. Gating should reject it.',
  'dist-decoy-hard':
    'A comparable source crossing inside the track gate. Phase 7 false-locks here.',
  'code-clean': 'A coded beacon, alone. Identity should reach MATCH and hold.',
  'code-decoy-easy': 'An obvious uncoded decoy well off the path.',
  'code-decoy-uncoded': 'A brighter intruder carrying no pattern at all.',
  'code-decoy-wrong': 'An intruder sending a different code: separable by what it transmits.',
  'code-decoy-hard': 'The hard decoy with both sources coded. The headline identity case.',
  'code-ambiguous': "An intruder replaying a rotation of the beacon's own code.",
  'code-identical':
    'An intruder sending the identical code at the identical phase. No receiver can separate these.',
  'code-insufficient': 'The beacon stops signalling twenty seconds in.',
  'code-frame-loss': 'A coded beacon through bursty frame loss.',
  'gimbal-step-response': 'A commanded step, for reading servo rise and overshoot.',
  'gimbal-latency': 'Command transport delay, isolated.',
  'gimbal-backlash': 'Reversal backlash and coarse encoder quantisation.',
};

/**
 * Every bundled scenario appears in exactly one group.
 *
 * Checked by test rather than by care: a scenario added later and not grouped
 * would otherwise vanish from the selector rather than fail anything.
 */
export function ungroupedScenarios(): readonly ScenarioId[] {
  const grouped = new Set(SCENARIO_GROUPS.flatMap((group) => group.ids));
  return SCENARIO_IDS.filter((id) => !grouped.has(id));
}
