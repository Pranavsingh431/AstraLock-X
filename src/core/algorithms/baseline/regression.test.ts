// @vitest-environment node
/**
 * The Phase-4 baseline, pinned.
 *
 * From Phase 6 onward the baseline is a scientific control: every claim made
 * for the robust algorithm is a comparison against it, on identical physics. A
 * control that quietly drifts as the codebase changes invalidates every such
 * comparison retrospectively, and the drift would be invisible — the baseline
 * would still track, still look reasonable, and simply be a different
 * experiment from the one the earlier numbers came from.
 *
 * So these tests fix its behaviour on the three scenarios it was built against.
 * They are deliberately a nuisance to update: if a change moves these numbers,
 * the control has changed, and either the change does not belong or every
 * published comparison needs rerunning.
 *
 * What is pinned is behaviour that survives a change of machine — the state
 * sequence, when each transition happened, how many frames were processed, and
 * where the mount ended up. The end-state hash is checked for equality between
 * two runs *on this machine* instead of against a stored constant, because
 * `sin`, `cos` and `exp` are not required to be bit-identical across platforms
 * and a stored hash would fail on Linux or Windows for reasons that have
 * nothing to do with the tracker.
 */

import { describe, expect, it, vi } from 'vitest';

import { buildRig, drive } from '@/core/experiments/rig.node';
import type { ScenarioId } from '@/scenarios';

vi.setConfig({ testTimeout: 900_000 });

/** A mode change, as the runtime recorded it. */
interface Transition {
  readonly mode: string;
  readonly time: number;
}

const transitions = (modes: readonly string[]): Transition[] =>
  modes.map((entry) => {
    const [mode, at] = entry.split('@');
    return { mode: mode!, time: Number(at) };
  });

/** Seconds a transition may move before the control is considered changed. */
const TIME_TOLERANCE = 0.05;
/** Radians the final pointing may move. About 200 µrad — a fifth of a pixel. */
const POINTING_TOLERANCE = 2e-4;

interface Expectation {
  readonly scenario: ScenarioId;
  readonly seconds: number;
  readonly modes: readonly Transition[];
  readonly framesProcessed: number;
  readonly finalMeasuredPan: number;
  readonly finalMeasuredTilt: number;
  readonly commands: number;
}

const EXPECTED: readonly Expectation[] = [
  {
    scenario: 'pat-stationary-outside-fov',
    seconds: 40,
    // Straight from scan to track: the baseline has no acquisition validation,
    // which is precisely the difference the robust algorithm was built around.
    modes: [
      { mode: 'scan', time: 0 },
      { mode: 'track', time: 11.92 },
    ],
    framesProcessed: 2401,
    finalMeasuredPan: 0.436681566,
    finalMeasuredTilt: 0.050090971,
    commands: 2401,
  },
  {
    scenario: 'pat-moving-target',
    seconds: 40,
    modes: [
      { mode: 'scan', time: 0 },
      { mode: 'track', time: 25.92 },
    ],
    framesProcessed: 2401,
    finalMeasuredPan: -0.272969612,
    finalMeasuredTilt: 0.053407098,
    commands: 2401,
  },
  {
    scenario: 'pat-loss',
    seconds: 60,
    // The baseline's known failure: it loses the target and restarts a global
    // sweep rather than predicting where the target went. It never recovers
    // within the run. This is the behaviour the robust algorithm is measured
    // against, so it must stay exactly this bad.
    modes: [
      { mode: 'scan', time: 0 },
      { mode: 'track', time: 0.02 },
      { mode: 'lost', time: 6.27 },
      { mode: 'scan', time: 6.77 },
    ],
    framesProcessed: 3601,
    finalMeasuredPan: 0.37699128,
    finalMeasuredTilt: 0.145211456,
    commands: 3570,
  },
];

describe('the baseline as a scientific control', () => {
  for (const expected of EXPECTED) {
    describe(expected.scenario, () => {
      const run = () =>
        drive(buildRig({ scenario: expected.scenario, storage: null }), expected.seconds);

      it('passes through the same states at the same times', () => {
        const actual = transitions(run().modes);

        expect(actual.map((t) => t.mode)).toEqual(expected.modes.map((t) => t.mode));
        for (const [index, transition] of actual.entries()) {
          expect(transition.time).toBeCloseTo(expected.modes[index]!.time, 2);
          expect(Math.abs(transition.time - expected.modes[index]!.time)).toBeLessThan(
            TIME_TOLERANCE,
          );
        }
      });

      it('processes the same frames and issues the same commands', () => {
        const trace = run();
        expect(trace.framesProcessed).toBe(expected.framesProcessed);
        expect(trace.commands.length).toBe(expected.commands);
      });

      it('leaves the mount where it did', () => {
        const trace = run();
        expect(Math.abs(trace.finalMeasuredPan - expected.finalMeasuredPan)).toBeLessThan(
          POINTING_TOLERANCE,
        );
        expect(Math.abs(trace.finalMeasuredTilt - expected.finalMeasuredTilt)).toBeLessThan(
          POINTING_TOLERANCE,
        );
      });

      it('is bit-for-bit reproducible on this machine', () => {
        expect(run().stateHash).toBe(run().stateHash);
      });

      it('never enters a state that belongs to the robust algorithm', () => {
        const modes = new Set(transitions(run().modes).map((t) => t.mode));
        for (const robustOnly of ['acquire', 'reacquire', 'handoff']) {
          expect(modes.has(robustOnly)).toBe(false);
        }
      });
    });
  }
});
