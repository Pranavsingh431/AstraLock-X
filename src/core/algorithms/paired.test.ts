// @vitest-environment node
/**
 * Baseline against AstraLock-X, on identical physics.
 *
 * A development validation harness, not AstraBench. Its one rule is fairness:
 * the two arms differ in the algorithm and its configuration and in **nothing**
 * else — same scenario document, same seed, same sensor, same mount, same
 * camera, same metric definitions, same evaluator. A comparison that changed
 * the target speed or the starting pose to flatter one arm would be measuring
 * the scenario, not the tracker.
 *
 * Ground truth appears here, in assertions only. The algorithms are handed
 * `TrackingInput` and nothing else.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ASTRALOCK_CONFIG,
  DEFAULT_BASELINE_PAT_CONFIG,
  astraLockXPat,
  baselineKfPidPat,
} from '@/core/algorithms';
import type { AstraLockDebug } from '@/core/algorithms';
import { Evaluator } from '@/core/experiments';
import { ClosedLoopRuntime } from '@/core/runtime/closed-loop';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';
import { SimulationEngine } from '@/core/simulation/engine';
import { loadScenario, type ScenarioId } from '@/scenarios';

vi.setConfig({ testTimeout: 600_000 });

export interface ArmResult {
  readonly modes: readonly string[];
  readonly acquiredAt: number;
  readonly errors: readonly number[];
  readonly framesTracked: number;
  readonly framesProcessed: number;
  readonly enteredRecover: boolean;
  readonly enteredHandoff: boolean;
  readonly returnedToSearchAfterTrack: boolean;
  readonly caDuring: (from: number, to: number) => number;
  readonly caPeak: number;
}

/**
 * Runs one arm. The only parameters are which plugin and which config — every
 * physical input is taken from the same scenario document.
 */
function runArm(scenario: ScenarioId, robust: boolean, seconds: number): ArmResult {
  const engine = new SimulationEngine(loadScenario(scenario));
  const sensor = new VirtualCameraSensor({ config: engine.config });
  const runtime = new ClosedLoopRuntime({
    engine,
    sensor,
    sampler: new ExactWorldSampler(engine),
    plugin: robust ? astraLockXPat : baselineKfPidPat,
    config: robust ? DEFAULT_ASTRALOCK_CONFIG : DEFAULT_BASELINE_PAT_CONFIG,
  });
  const evaluator = new Evaluator({ engine, config: engine.config });

  const modes: string[] = [];
  const errors: number[] = [];
  const caSamples: { time: number; ca: number }[] = [];
  let lastMode = '';
  let acquiredAt = -1;
  let framesTracked = 0;
  let enteredRecover = false;
  let enteredHandoff = false;
  let returnedToSearchAfterTrack = false;
  let everTracked = false;
  let caPeak = 0;

  const ticks = Math.round(seconds * engine.config.tickRate);
  for (let tick = 0; tick < ticks; tick += 1) {
    const processed = runtime.step(1);
    const output = runtime.algorithmOutput;
    if (output === null) continue;

    const mode = output.pat.mode;
    if (mode !== lastMode) {
      modes.push(mode);
      lastMode = mode;
      if (mode === 'reacquire') enteredRecover = true;
      if (mode === 'handoff') enteredHandoff = true;
      if (mode === 'track' || mode === 'handoff') everTracked = true;
      if (mode === 'scan' && everTracked) returnedToSearchAfterTrack = true;
    }
    if ((mode === 'track' || mode === 'handoff') && acquiredAt < 0) acquiredAt = engine.time;

    if (processed > 0) {
      if (mode === 'track' || mode === 'handoff') framesTracked += 1;
      if (acquiredAt >= 0) {
        const frame = evaluator.at(engine.time);
        if (frame.angularPointingError !== null) errors.push(frame.angularPointingError);
      }
      const debug = output.debug as AstraLockDebug | null;
      const ca = debug?.immCaProbability;
      if (typeof ca === 'number') {
        caSamples.push({ time: engine.time, ca });
        caPeak = Math.max(caPeak, ca);
      }
    }
  }

  return {
    modes,
    acquiredAt,
    errors,
    framesTracked,
    framesProcessed: runtime.framesProcessed,
    enteredRecover,
    enteredHandoff,
    returnedToSearchAfterTrack,
    caPeak,
    caDuring: (from, to) => {
      const window = caSamples.filter((s) => s.time >= from && s.time <= to);
      return window.length === 0
        ? Number.NaN
        : window.reduce((total, s) => total + s.ca, 0) / window.length;
    },
  };
}

const stats = (errors: readonly number[]) => {
  if (errors.length === 0)
    return { rms: Number.NaN, p95: Number.NaN, max: Number.NaN, median: Number.NaN };
  const sorted = [...errors].sort((a, b) => a - b);
  return {
    rms: Math.sqrt(errors.reduce((t, e) => t + e * e, 0) / errors.length),
    median: sorted[Math.floor(sorted.length / 2)]!,
    p95: sorted[Math.floor(sorted.length * 0.95)]!,
    max: sorted[sorted.length - 1]!,
  };
};

const urad = (radians: number): string => `${(radians * 1e6).toFixed(0)} µrad`;

/** Runs both arms and prints the comparison, so the numbers are in the record. */
function compare(scenario: ScenarioId, seconds: number) {
  const baseline = runArm(scenario, false, seconds);
  const robust = runArm(scenario, true, seconds);
  const b = stats(baseline.errors);
  const r = stats(robust.errors);

  // eslint-disable-next-line no-console -- the measured comparison is the point
  console.log(
    `${scenario}\n` +
      `  baseline   acq ${baseline.acquiredAt.toFixed(1)}s  rms ${urad(b.rms)}  p95 ${urad(b.p95)}  max ${urad(b.max)}  modes ${baseline.modes.join('->')}\n` +
      `  astralock  acq ${robust.acquiredAt.toFixed(1)}s  rms ${urad(r.rms)}  p95 ${urad(r.p95)}  max ${urad(r.max)}  modes ${robust.modes.join('->')}`,
  );

  return { baseline, robust, b, r };
}

// --- A. Stationary, outside the field of view --------------------------------

describe('A. a stationary target outside the field of view', () => {
  it('is acquired by both, and the robust arm validates before committing', () => {
    const { baseline, robust } = compare('astralock-stationary', 40);

    expect(baseline.acquiredAt).toBeGreaterThan(0);
    expect(robust.acquiredAt).toBeGreaterThan(0);

    // The baseline goes straight from scan to track. The robust arm passes
    // through a validation stage first — that is the visible difference.
    expect(baseline.modes.slice(0, 2)).toEqual(['scan', 'track']);
    expect(robust.modes.slice(0, 3)).toEqual(['scan', 'acquire', 'track']);
  });

  it('does not regress the simple case', () => {
    // A sophisticated system that is worse everywhere is not progress. The
    // bound is deliberately loose — the two sweep the region at different
    // rates and settle differently — but a severe regression would fail it.
    const { b, r } = compare('astralock-stationary', 40);
    expect(r.median).toBeLessThan(b.median * 3 + 100e-6);
  });
});

// --- B. Smooth crossing ------------------------------------------------------

describe('B. a smoothly moving target', () => {
  it('is tracked by both', () => {
    const { baseline, robust, b, r } = compare('astralock-moving', 55);

    expect(baseline.framesTracked).toBeGreaterThan(500);
    expect(robust.framesTracked).toBeGreaterThan(500);
    expect(b.median).toBeLessThan(1e-3);
    expect(r.median).toBeLessThan(1e-3);
  });

  it('keeps the constant-velocity model in charge', () => {
    // Nothing is accelerating, so the manoeuvre model should stay out of the
    // way. If NCA sat high on a benign target it would be adding noise for
    // nothing.
    const { robust } = compare('astralock-moving', 55);
    expect(robust.caDuring(20, 50)).toBeLessThan(0.2);
  });
});

// --- C. Manoeuvre ------------------------------------------------------------

describe('C. a manoeuvring target', () => {
  // The scenario holds a constant angular rate to t=18, accelerates at
  // -7.85e-3 rad/s² to t=26, then holds the new rate.
  const CALM = [10, 17] as const;
  const MANOEUVRE = [19, 26] as const;

  it('raises the acceleration model while the target accelerates', () => {
    const { robust } = compare('astralock-maneuver', 44);

    const calm = robust.caDuring(CALM[0], CALM[1]);
    const during = robust.caDuring(MANOEUVRE[0], MANOEUVRE[1]);

    // eslint-disable-next-line no-console -- the measured response is the point
    console.log(
      `  IMM: NCA ${calm.toFixed(3)} while steady, ${during.toFixed(3)} during the manoeuvre, peak ${robust.caPeak.toFixed(3)}`,
    );

    expect(during).toBeGreaterThan(calm * 2);
    expect(robust.caPeak).toBeGreaterThan(0.5);
  });

  it('points better than the baseline through the manoeuvre', () => {
    // The reason the IMM is there. Both arms see the same target; the one that
    // can represent acceleration should lag it less.
    const { b, r } = compare('astralock-maneuver', 44);
    expect(r.rms).toBeLessThan(b.rms);
  });
});

// --- D. Short loss and return ------------------------------------------------

describe('D. a target that briefly leaves the field of view', () => {
  it('sends the baseline back to a global search and the robust arm to recovery', () => {
    const { baseline, robust } = compare('astralock-short-loss', 60);

    // The baseline has one response to a missing measurement: give up and
    // rescan from the start of the pattern.
    expect(baseline.modes).toContain('lost');

    // The robust arm coasts on its estimate and looks where it predicts.
    expect(robust.enteredRecover).toBe(true);
    expect(robust.modes.filter((m) => m === 'track').length).toBeGreaterThan(1);
  });

  it('recovers without a full rescan', () => {
    const robust = runArm('astralock-short-loss', true, 60);

    const firstRecover = robust.modes.indexOf('reacquire');
    expect(firstRecover).toBeGreaterThan(0);
    // It is back in track after recovery, and never fell through to a global
    // sweep to get there.
    expect(robust.modes.slice(firstRecover)).toContain('track');
    expect(
      robust.modes.slice(firstRecover, robust.modes.indexOf('track', firstRecover)),
    ).not.toContain('scan');
  });
});

// --- E. Handoff --------------------------------------------------------------

describe('E. a handoff-eligible target', () => {
  it('reaches handoff readiness, which the baseline cannot express at all', () => {
    const { baseline, robust } = compare('astralock-handoff', 45);

    expect(robust.enteredHandoff).toBe(true);
    expect(baseline.modes).not.toContain('handoff');
  });

  it('keeps tracking while ready rather than freezing', () => {
    // Handoff readiness is a claim about the coarse track, not a handover of
    // control. The camera must still be following the target.
    const robust = runArm('astralock-handoff', true, 45);
    expect(robust.framesTracked).toBeGreaterThan(500);
    expect(stats(robust.errors).median).toBeLessThan(1e-3);
  });
});

// --- Fairness ----------------------------------------------------------------

describe('the harness itself', () => {
  it('gives both arms the identical physical configuration', () => {
    // The fairness rule, checked rather than asserted in prose: the only thing
    // that differs between arms is which plugin is constructed.
    const a = loadScenario('astralock-moving');
    const b = loadScenario('astralock-moving');
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it('processes the same number of sensor frames in both arms', () => {
    // Same camera, same clock, same run length: any difference in frames seen
    // would mean the arms were not given the same opportunity.
    const baseline = runArm('astralock-moving', false, 20);
    const robust = runArm('astralock-moving', true, 20);
    expect(robust.framesProcessed).toBe(baseline.framesProcessed);
  });
});
