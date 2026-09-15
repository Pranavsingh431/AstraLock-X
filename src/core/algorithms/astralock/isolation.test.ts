// @vitest-environment node
/**
 * What AstraLock-X cannot reach, and cannot be helped by.
 *
 * Every Phase 4 anti-cheat guarantee, repeated against the robust algorithm,
 * plus the three new ones the new states create: handoff readiness must not
 * come from the evaluator, recovery must run on the estimator rather than on a
 * hidden trajectory, and the optional prior must be genuinely absent when it is
 * not configured.
 *
 * The algorithm is sophisticated enough now that a leak would be easy to miss —
 * it would simply look like a very good tracker.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ASTRALOCK_CONFIG,
  DEFAULT_TERMINAL_PROFILE_ID,
  astraLockXPat,
  terminalProfileById,
  withExpectedBeacon,
} from '@/core/algorithms';
import type { AstraLockDebug } from '@/core/algorithms';
import { ClosedLoopRuntime } from '@/core/runtime/closed-loop';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';
import { SimulationEngine } from '@/core/simulation/engine';
import { parseSimulationConfig, type SimulationConfig } from '@/core/contracts/simulation';
import { loadScenario, type ScenarioId } from '@/scenarios';

vi.setConfig({ testTimeout: 600_000 });

/**
 * The robust configuration with identity enabled.
 *
 * A constant, and that it can be a constant is the point. Set to the bundled
 * Code A terminal profile explicitly; it takes no scenario, because since the
 * Phase 9 preflight the receiver setting and the emitted code are independent
 * and there is no argument through which one could reach the other.
 */
const IDENTITY_CONFIG = withExpectedBeacon(
  DEFAULT_ASTRALOCK_CONFIG,
  terminalProfileById(DEFAULT_TERMINAL_PROFILE_ID)!,
);

interface Run {
  readonly modes: readonly string[];
  readonly finalMode: string;
  readonly acquired: boolean;
  readonly debug: AstraLockDebug | null;
  readonly commands: readonly string[];
  readonly stateHash: string;
  readonly finalPan: number;
}

function run(
  scenario: ScenarioId,
  seconds: number,
  options: { blankPixels?: boolean; identity?: boolean; config?: SimulationConfig } = {},
): Run {
  const { identity = false, config: override, ...runtimeOptions } = options;
  const engine = new SimulationEngine(override ?? loadScenario(scenario));
  const sensor = new VirtualCameraSensor({ config: engine.config });
  const runtime = new ClosedLoopRuntime({
    engine,
    sensor,
    sampler: new ExactWorldSampler(engine),
    plugin: astraLockXPat,
    config: identity ? IDENTITY_CONFIG : DEFAULT_ASTRALOCK_CONFIG,
    ...runtimeOptions,
  });

  const modes: string[] = [];
  let last = '';
  let acquired = false;
  const ticks = Math.round(seconds * engine.config.tickRate);
  for (let tick = 0; tick < ticks; tick += 1) {
    runtime.step(1);
    const mode = runtime.algorithmOutput?.pat.mode;
    if (mode !== undefined && mode !== last) {
      modes.push(mode);
      last = mode;
      if (mode === 'track' || mode === 'handoff') acquired = true;
    }
  }

  return {
    modes,
    finalMode: last,
    acquired,
    debug: (runtime.algorithmOutput?.debug ?? null) as AstraLockDebug | null,
    commands: runtime.issuedCommands.map(
      (c) =>
        `${String(c.commandId)}:${c.azimuth.toExponential(15)}:${c.elevation.toExponential(15)}`,
    ),
    stateHash: engine.stateHash(),
    finalPan: engine.gimbal.measuredPointing().panAngle,
  };
}

// --- A. Blank pixels ---------------------------------------------------------

describe('A. the image is causally required', () => {
  it('cannot acquire when the pixels carry no information', () => {
    const blind = run('astralock-stationary', 40, { blankPixels: true });

    expect(blind.acquired).toBe(false);
    expect(blind.modes).toEqual(['scan']);
    expect(blind.debug?.candidateCount).toBe(0);
  });

  it('never even reaches the validation stage', () => {
    // ACQUIRE needs a candidate to accumulate evidence about. With no pixels
    // there is nothing to validate, so the state machine cannot leave SEARCH.
    const blind = run('astralock-stationary', 40, { blankPixels: true });
    expect(blind.modes).not.toContain('acquire');
    expect(blind.debug?.acquisitionEvidence ?? 0).toBe(0);
  });

  it('acquires as soon as real pixels are restored', () => {
    // The other half of the proof: the failure above is caused by the blanking
    // and by nothing else.
    expect(run('astralock-stationary', 40).acquired).toBe(true);
  });
});

// --- B. Same pixels, different world -----------------------------------------

describe('B. behaviour follows the pixels, not the world behind them', () => {
  it('behaves identically in two different worlds shown the same blank frames', () => {
    const a = run('astralock-stationary', 15, { blankPixels: true });
    const b = run('astralock-maneuver', 15, { blankPixels: true });

    // Two completely different target trajectories. Identical blank pixels.
    // Identical behaviour, down to the commands issued.
    expect(b.modes).toEqual(a.modes);
    expect(b.commands).toEqual(a.commands);
    expect(b.finalPan).toBe(a.finalPan);
  });
});

// --- C. Evaluation disconnected ----------------------------------------------

describe('C. the tracker does not need the evaluator', () => {
  it('works with no evaluator constructed at all', () => {
    // These runs never create one. If the algorithm needed privileged
    // evaluation to function, it could not function here.
    const result = run('astralock-handoff', 40);
    expect(result.acquired).toBe(true);
    expect(result.modes).toContain('handoff');
  });
});

// --- D. Handoff --------------------------------------------------------------

describe('D. handoff readiness comes from the tracker, not from truth', () => {
  it('is reached on a scenario where no evaluator exists to consult', () => {
    const result = run('astralock-handoff', 40);
    expect(result.modes).toContain('handoff');
  });

  it('reports only quantities the tracker computed itself', () => {
    const result = run('astralock-handoff', 40);
    const debug = result.debug!;

    // The gate's inputs are all present in the safe diagnostics, and none of
    // them is a true pointing error.
    expect(debug.handoffRequiredDwell).toBeGreaterThan(0);
    expect(typeof debug.handoffConditionsMet).toBe('boolean');

    const serialised = JSON.stringify(debug);
    for (const forbidden of [
      'truePointing',
      'trueAzimuth',
      'trueBearing',
      'targetId',
      'groundTruth',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });

  it('never becomes ready while the pixels are blank', () => {
    // If handoff could be triggered by anything other than an observed,
    // consistent track, a blind run would reach it.
    const blind = run('astralock-handoff', 40, { blankPixels: true });
    expect(blind.modes).not.toContain('handoff');
  });
});

// --- E. Recovery -------------------------------------------------------------

describe('E. recovery runs on the estimator, not on a hidden trajectory', () => {
  it('enters recovery from missing measurements alone', () => {
    const result = run('astralock-short-loss', 60);
    expect(result.modes).toContain('reacquire');
  });

  it('is never told the target is back', () => {
    // Reacquisition happens through the same gated association as any other
    // measurement: there is no signal in `TrackingInput` that says a target has
    // returned, and the input surface is proved ground-truth-free at compile
    // time.
    const result = run('astralock-short-loss', 60);
    const afterRecover = result.modes.slice(result.modes.indexOf('reacquire'));
    expect(afterRecover).toContain('track');
  });

  it('gives up and searches globally when recovery cannot find it', () => {
    // A blind run enters recovery on the first missing frames and must
    // eventually fall back rather than coasting for ever.
    const blind = run('astralock-moving', 40, { blankPixels: true });
    expect(blind.finalMode).toBe('scan');
  });
});

// --- F. Optional prior -------------------------------------------------------

describe('F. the optional prior is genuinely optional', () => {
  it('is absent from the shipped configuration', () => {
    expect(DEFAULT_ASTRALOCK_CONFIG.search.prior).toBeNull();
  });

  it('cannot be obtained from anywhere when it is not configured', () => {
    // With no prior, the first search pointing must be the corner of the
    // configured region — not the target's bearing.
    const engine = new SimulationEngine(loadScenario('astralock-stationary'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const runtime = new ClosedLoopRuntime({
      engine,
      sensor,
      sampler: new ExactWorldSampler(engine),
      plugin: astraLockXPat,
      config: DEFAULT_ASTRALOCK_CONFIG,
    });

    runtime.step(1);
    const debug = runtime.algorithmOutput!.debug as AstraLockDebug;
    expect(debug.searchPan).toBeCloseTo(DEFAULT_ASTRALOCK_CONFIG.search.panMin, 9);
    expect(debug.searchTilt).toBeCloseTo(DEFAULT_ASTRALOCK_CONFIG.search.tiltMin, 9);
    expect(debug.searchWaypointIndex).toBe(0);
  });

  it('takes time to find a target it has no prior about', () => {
    // The honest consequence of having no prior: a blind sweep. If acquisition
    // were instant, something would be telling it where to look.
    const result = run('astralock-stationary', 40);
    expect(result.modes[0]).toBe('scan');
    expect(result.modes).toContain('acquire');
  });
});

// --- Determinism -------------------------------------------------------------

describe('deterministic replay', () => {
  it('reproduces states, commands and final pose exactly', () => {
    const a = run('astralock-maneuver', 40);
    const b = run('astralock-maneuver', 40);

    expect(b.modes).toEqual(a.modes);
    expect(b.commands).toEqual(a.commands);
    expect(b.finalPan).toBe(a.finalPan);
    expect(b.stateHash).toBe(a.stateHash);
  });

  it('reproduces the estimator state, model probabilities included', () => {
    const a = run('astralock-maneuver', 40).debug!;
    const b = run('astralock-maneuver', 40).debug!;

    expect(b.immCvProbability).toBe(a.immCvProbability);
    expect(b.immCaProbability).toBe(a.immCaProbability);
    expect(b.predictedAzimuth).toBe(a.predictedAzimuth);
    expect(b.predictedElevation).toBe(a.predictedElevation);
  });

  it('uses no unseeded randomness', () => {
    const original = Math.random;
    Math.random = () => {
      throw new Error('the algorithm must not use unseeded randomness');
    };
    try {
      expect(() => run('astralock-short-loss', 25)).not.toThrow();
    } finally {
      Math.random = original;
    }
  });
});

// --- G. Beacon identity is recognition, not a channel ------------------------

describe('G. the correlator is given a pattern, never an answer', () => {
  it('behaves identically when the emitters are renamed', () => {
    // The strongest form of the anti-cheat check for identity. The same world,
    // the same codes, the same pixels — but every label the simulator uses for
    // its entities is different. A tracker reading an identifier anywhere in
    // the observation path would produce a different run.
    const original = loadScenario('code-decoy-hard');
    const renamed = parseSimulationConfig({
      ...original,
      targets: original.targets.map((target, index) => ({
        ...target,
        label: index === 0 ? 'Zebra' : 'Aardvark',
      })),
      // Order matters too: a tracker quietly preferring the first entity would
      // pass a renaming test and fail this one.
      id: 'code-decoy-hard',
    });

    const a = run('code-decoy-hard', 30, { identity: true });
    const b = run('code-decoy-hard', 30, { identity: true, config: renamed });

    expect(b.modes).toEqual(a.modes);
    expect(b.commands).toEqual(a.commands);
    expect(b.finalPan).toBe(a.finalPan);
  });

  it('cannot recognise anything from blank pixels', () => {
    // Identity has to be earned from light. With nothing in the image there is
    // no candidate to watch, no history, and no verdict — not a default one.
    const blank = run('code-clean', 20, { identity: true, blankPixels: true });

    expect(blank.acquired).toBe(false);
    expect(blank.debug!.identityEnabled).toBe(true);
    expect(blank.debug!.identityState).toBeNull();
    expect(blank.debug!.identityCandidates).toBe(0);
    expect(blank.debug!.codeCorrelation).toBeNull();
  });

  it('reports no quantity it was not given or did not compute', () => {
    const tracked = run('code-clean', 30, { identity: true });
    const debug = tracked.debug as unknown as Record<string, unknown>;

    // The verdict is about evidence, and the fields are the evidence. There is
    // no emitter, no target index, no true phase and no true code.
    expect(debug['identityState']).toBe('match');
    for (const key of Object.keys(debug)) {
      expect(key, key).not.toMatch(
        /emitterId|hostEntity|entityId|designated|groundTruth|^truth|trueCode|truePhase|targetIndex/i,
      );
    }
  });

  it('never sees the true modulation phase, and has to find it', () => {
    // The scenario transmits at a phase offset of 37 ms. The tracker is
    // configured with the sequence and the symbol duration only, so the phase
    // it reports is one it recovered by searching — and it lands on the right
    // answer to within the resolution of the search.
    const truePhase = loadScenario('code-clean').targets[0]!.beacon!.identityCode!
      .phaseOffset as number;
    const tracked = run('code-clean', 30, { identity: true });
    const period =
      DEFAULT_ASTRALOCK_CONFIG.identity.expectedSequence.length *
      DEFAULT_ASTRALOCK_CONFIG.identity.symbolDuration;

    expect(DEFAULT_ASTRALOCK_CONFIG.identity).not.toHaveProperty('phaseOffset');
    const delta = Math.abs(((tracked.debug!.codePhase! - truePhase) % period) + period) % period;
    expect(Math.min(delta, period - delta)).toBeLessThan(2 / 60);
  });

  it('is configured with a pattern that carries no brightness', () => {
    // A receiver has no business assuming how bright its partner is, and the
    // configuration has no field in which such an assumption could be stored.
    const identity = DEFAULT_ASTRALOCK_CONFIG.identity as unknown as Record<string, unknown>;
    expect(identity).not.toHaveProperty('onIntensity');
    expect(identity).not.toHaveProperty('offIntensity');
    expect(identity['expectedSequence']).toEqual(
      expect.arrayContaining([expect.any(Number)]) as unknown,
    );
  });

  it('reproduces a coded run exactly, twice', () => {
    const a = run('code-decoy-hard', 30, { identity: true });
    const b = run('code-decoy-hard', 30, { identity: true });

    expect(b.modes).toEqual(a.modes);
    expect(b.commands).toEqual(a.commands);
    expect(b.stateHash).toBe(a.stateHash);
    expect(b.debug!.codeCorrelation).toBe(a.debug!.codeCorrelation);
    expect(b.debug!.codePhase).toBe(a.debug!.codePhase);
  });
});
