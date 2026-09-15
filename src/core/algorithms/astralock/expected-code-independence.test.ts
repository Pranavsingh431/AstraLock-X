// @vitest-environment node
/**
 * The expected code is a terminal setting, not a fact the receiver can learn.
 *
 * ## What this is guarding against
 *
 * Phase 8 shipped a coupling that these tests exist to make impossible. The
 * application read the designated emitter's `identityCode` out of the loaded
 * scenario and copied it into the tracker's configuration when the runtime was
 * built. Every measured result was still honest — the algorithm itself never
 * saw the scenario, and the anti-cheat suite proved it — but the *benchmark*
 * that Phase 9 builds on top would not have been. Change what the target
 * transmits and the receiver silently followed, so no arrangement of scenario
 * and algorithm could ever have produced a genuine identity failure, and a
 * comparison in which one arm cannot lose is not a comparison.
 *
 * The correction is structural rather than careful: `sessionAlgorithmConfig`
 * takes no `SimulationConfig` at all, so there is no argument through which a
 * scenario could reach a receiver setting. These tests hold that line from the
 * outside, by checking the behaviour it produces.
 *
 * ## What a test is allowed to know
 *
 * These tests read the scenario's emitted code, and that is fine: a test may
 * know the answer it is checking against. What is being checked is that the
 * *tracker* did not, and that the only way to point a receiver at a pattern is
 * to configure it with one.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ASTRALOCK_CONFIG,
  TERMINAL_BEACON_PROFILES,
  astraLockXPat,
  terminalProfileById,
  withExpectedBeacon,
} from '@/core/algorithms';
import type { AstraLockDebug } from '@/core/algorithms';
import { CODE_B } from '@/core/contracts/code-library';
import { parseSimulationConfig, type SimulationConfig } from '@/core/contracts/simulation';
import { buildRig, trace } from '@/core/experiments/rig.node';
import { MemoryStorage } from '@/core/experiments/storage';
import { loadScenario } from '@/scenarios';

vi.setConfig({ testTimeout: 900_000 });

const CODE_A_PROFILE = terminalProfileById('code-a-15-66ms')!;
const CODE_B_PROFILE = terminalProfileById('code-b-15-66ms')!;

/**
 * `code-clean`, with the designated beacon transmitting code B instead of A.
 *
 * Built here rather than bundled as a scenario, because it is physically the
 * same world as `code-clean` and the scenario set should not carry two
 * identical geometries under different names. Only the transmitted sequence
 * differs; the phase, timing, levels, geometry and seed are untouched.
 */
function transmittingCodeB(): SimulationConfig {
  const base = loadScenario('code-clean');
  return parseSimulationConfig({
    ...base,
    targets: base.targets.map((target) => ({
      ...target,
      beacon:
        target.beacon === null
          ? null
          : {
              ...target.beacon,
              identityCode:
                target.beacon.identityCode === null
                  ? null
                  : { ...target.beacon.identityCode, sequence: [...CODE_B] },
            },
    })),
  });
}

/** Relabels every entity without touching a single photon of physics. */
function relabelled(config: SimulationConfig): SimulationConfig {
  return parseSimulationConfig({
    ...config,
    targets: config.targets.map((target, index) => ({
      ...target,
      label: `Relabelled entity ${String(index)}`,
    })),
  });
}

interface Run {
  /** The evaluator's own verdict on whether a lock was ever established. */
  readonly outcome: string;
  readonly retention: number;
  readonly rmsUrad: number | null;
  /** Fraction of judged frames the receiver called a match. */
  readonly matchFraction: number;
  readonly states: readonly string[];
  readonly modes: readonly string[];
  readonly commands: readonly string[];
  readonly stateHash: string;
}

/**
 * Flies a configuration and reports what the tracker did and what the evaluator
 * made of it.
 *
 * The evaluator's `acquisitionOutcome` is used rather than "did the state
 * machine ever enter TRACK", and the difference matters here. A receiver
 * expecting the wrong code does enter TRACK for a moment: on a history of
 * twenty-odd samples an unmatched code can correlate above the threshold by
 * accident, which is the trap Phase 8's evidence rule exists for. What it
 * cannot do is *hold*, and a confirmed coarse lock requires dwell — so the
 * evaluator says no acquisition while a transient mode reading would say yes.
 */
async function fly(
  scenario: SimulationConfig,
  algorithmConfig: unknown,
  seconds: number,
  runId: string,
): Promise<Run> {
  const rig = buildRig({
    scenario,
    storage: new MemoryStorage(),
    runId,
    plugin: astraLockXPat,
    algorithmConfig,
  });
  await rig.recorder!.start({ autonomyActive: true });

  const states = new Set<string>();
  let judged = 0;
  let matched = 0;
  const ticks = Math.round(seconds * (scenario.tickRate as number));
  for (let tick = 0; tick < ticks; tick += 1) {
    rig.runtime.step(1);
    const state = (rig.runtime.algorithmOutput?.debug as AstraLockDebug | undefined)?.identityState;
    if (typeof state === 'string') {
      states.add(state);
      judged += 1;
      if (state === 'match') matched += 1;
    }
  }
  const summary = await rig.recorder!.complete();
  const engineering = trace(rig);

  return {
    outcome: summary.acquisitionOutcome,
    retention: summary.lockRetentionRate.value ?? 0,
    rmsUrad:
      summary.angularPointingError.postAcquisition.rms.value === null
        ? null
        : summary.angularPointingError.postAcquisition.rms.value * 1e6,
    matchFraction: judged === 0 ? 0 : matched / judged,
    states: [...states],
    modes: engineering.modes,
    commands: engineering.commands,
    stateHash: engineering.stateHash,
  };
}

describe('a receiver expecting the wrong code', () => {
  it('does not adapt to what the beacon is actually sending', async () => {
    // The mandatory regression. The target transmits code B; the terminal is
    // set to code A. Under the Phase 8 coupling this arrangement could not
    // exist — the receiver was configured from the emitter and always agreed
    // with it — so no benchmark could ever have produced an identity failure.
    //
    // Now it can, and it ends the way a misconfigured real terminal ends: the
    // receiver keeps looking for the pattern it was told to expect, does not
    // converge on the one being sent, and never establishes a lock.
    const run = await fly(
      transmittingCodeB(),
      withExpectedBeacon(DEFAULT_ASTRALOCK_CONFIG, CODE_A_PROFILE),
      40,
      'independence-b-transmits-a-expects',
    );

    expect(run.outcome).toBe('no-acquisition');
    expect(run.retention).toBe(0);
    // It is watching and judging, not idle — and it mostly does not recognise
    // what it sees. Measured at 0.13; the matched terminal below reaches 0.99.
    expect(run.matchFraction).toBeLessThan(0.3);
    expect(run.states).toContain('unconfirmed');
  });

  it('recognises the same beacon once the terminal is set to the code it sends', async () => {
    // The other half of the same statement. Nothing about the world changed
    // between this run and the one above — same scenario, same seed, same
    // photons. What changed is a receiver setting, which is a configuration act
    // with a record in `algorithm.json`.
    const run = await fly(
      transmittingCodeB(),
      withExpectedBeacon(DEFAULT_ASTRALOCK_CONFIG, CODE_B_PROFILE),
      40,
      'independence-b-transmits-b-expects',
    );

    expect(run.outcome).toBe('acquired');
    expect(run.retention).toBeGreaterThan(0.9);
    expect(run.matchFraction).toBeGreaterThan(0.9);
  });

  it('fails the same way on the bundled code-A beacon when set to code B', async () => {
    // Symmetric, so the result above is a property of the mismatch rather than
    // of code B.
    const run = await fly(
      loadScenario('code-clean'),
      withExpectedBeacon(DEFAULT_ASTRALOCK_CONFIG, CODE_B_PROFILE),
      40,
      'independence-a-transmits-b-expects',
    );

    expect(run.outcome).toBe('no-acquisition');
    expect(run.retention).toBe(0);
    expect(run.matchFraction).toBeLessThan(0.3);
  });

  it('shows a brief accidental match in both cases, which is why dwell is required', async () => {
    // Worth asserting rather than leaving as a footnote. A short history can
    // correlate perfectly with the wrong code — a handful of samples inside one
    // symbol fit almost any pattern — so `match` appearing at all is not
    // evidence. What separates the two configurations is how much of the run
    // the verdict holds for, and whether a lock survives the evaluator's dwell
    // requirement.
    const mismatched = await fly(
      transmittingCodeB(),
      withExpectedBeacon(DEFAULT_ASTRALOCK_CONFIG, CODE_A_PROFILE),
      40,
      'independence-transient',
    );
    expect(mismatched.states).toContain('match');
    expect(mismatched.outcome).toBe('no-acquisition');
  });
});

describe('the emitted code and the expected code are separate settings', () => {
  it('is structurally impossible for a scenario to choose the receiver setting', async () => {
    // The store's algorithm-configuration function is the exact place the
    // Phase 8 coupling lived. It now takes an algorithm id and two operator
    // choices, and no simulation configuration at all — so the coupling cannot
    // be reintroduced by passing the wrong thing, only by changing the
    // signature, which is a visible act.
    const { sessionAlgorithmConfig } = await import('@/stores/simulation-store');
    expect(sessionAlgorithmConfig).toHaveLength(3);

    const a = sessionAlgorithmConfig('astralock-x', true, 'code-a-15-66ms');
    const b = sessionAlgorithmConfig('astralock-x', true, 'code-b-15-66ms');
    expect(
      (a as { identity: { expectedSequence: number[] } }).identity.expectedSequence,
    ).not.toEqual((b as { identity: { expectedSequence: number[] } }).identity.expectedSequence);
  });

  it('offers the operator a profile to choose, not a scenario to inherit from', () => {
    // Two length-15 m-sequences exist and both are offered. A profile carries a
    // sequence and a symbol duration — what a mission card would carry — and
    // nothing that names an emitter, a target index or a phase.
    expect(TERMINAL_BEACON_PROFILES.length).toBeGreaterThanOrEqual(2);
    for (const profile of TERMINAL_BEACON_PROFILES) {
      expect(Object.keys(profile).sort()).toEqual([
        'description',
        'id',
        'label',
        'sequence',
        'symbolDuration',
      ]);
      expect(profile.symbolDuration).toBeGreaterThan(0);
      for (const symbol of profile.sequence) expect([0, 1]).toContain(symbol);
    }
  });
});

describe('hidden entity identity', () => {
  it('changes nothing when the emitters are renamed and the pixels are the same', async () => {
    // The anti-cheat statement, restated for the configuration path rather than
    // the algorithm path: a terminal set to a profile behaves identically in two
    // worlds that differ only in what the simulator calls its entities.
    const config = withExpectedBeacon(DEFAULT_ASTRALOCK_CONFIG, CODE_A_PROFILE);
    const plain = await fly(loadScenario('code-clean'), config, 30, 'independence-plain');
    const renamed = await fly(
      relabelled(loadScenario('code-clean')),
      config,
      30,
      'independence-renamed',
    );

    expect(renamed.modes).toEqual(plain.modes);
    expect(renamed.commands).toEqual(plain.commands);
    expect(renamed.stateHash).toBe(plain.stateHash);
    expect(renamed.outcome).toBe(plain.outcome);
    expect(renamed.matchFraction).toBe(plain.matchFraction);
  });
});
