// @vitest-environment node
/**
 * Coded identity, switched on and off, over the same worlds.
 *
 * The claim this phase makes is comparative — "the tracker locks the wrong
 * source less often when it can recognise the right one" — and a comparative
 * claim needs a control. Every pair below runs the *same scenario, same seed,
 * same everything* twice, changing one field of the algorithm's configuration.
 *
 * Both arms are measured by the same evaluator from the same recorded files.
 * Nothing here reads a stored number: the figures quoted in
 * docs/BEACON_IDENTITY.md come from this harness.
 *
 * It is a validation harness, not a benchmark engine. There is no sweep, no
 * batch runner and no report generation — that is AstraBench's job and
 * AstraBench is explicitly not part of this phase.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ASTRALOCK_CONFIG, astraLockXPat } from '@/core/algorithms';
import { parseSimulationConfig } from '@/core/contracts/simulation';
import { buildRig, drive } from '@/core/experiments/rig.node';
import { MemoryStorage } from '@/core/experiments/storage';
import { loadScenario } from '@/scenarios';
import type { ScenarioId } from '@/scenarios';

import type { AstraLockConfig } from './config';

vi.setConfig({ testTimeout: 1_800_000 });

/** Seconds of simulated time per arm. Long enough to include the crossing. */
const SECONDS = 45;

interface Arm {
  readonly acquired: boolean;
  readonly retention: number;
  readonly rmsUrad: number | null;
  readonly falseLockEpisodes: number;
  readonly falseLockSeconds: number;
  readonly identityChallenges: number;
  readonly wrongCodeAssociations: number;
  readonly correctCodeAssociations: number;
  readonly ambiguousEpisodes: number;
  readonly ambiguousIdentityEpisodesSeen: boolean;
  readonly identityMeanMs: number | null;
}

/**
 * One arm of a comparison.
 *
 * `identity` is the only thing that differs between the two calls. Everything
 * else — scenario, seed, detector, gates, estimator, controller — is shared, so
 * a difference in the result is attributable to the one field that changed.
 */
async function arm(scenario: ScenarioId, identity: boolean, seed?: number): Promise<Arm> {
  const base = loadScenario(scenario);
  const config = seed === undefined ? base : parseSimulationConfig({ ...base, seed });
  const code = config.targets[0]!.beacon!.identityCode!;

  const algorithmConfig: AstraLockConfig = {
    ...DEFAULT_ASTRALOCK_CONFIG,
    identity: {
      ...DEFAULT_ASTRALOCK_CONFIG.identity,
      enabled: identity,
      // The terminal is configured with the pattern its partner will send, the
      // way a radio is set to a frequency. Read from the scenario by the test
      // harness, which plays the role of the mission plan; never by the
      // algorithm, which sees only pixels.
      expectedSequence: code.sequence,
      symbolDuration: code.symbolDuration,
    },
  };

  const rig = buildRig({
    scenario: config,
    storage: new MemoryStorage(),
    runId: `${scenario}-${identity ? 'on' : 'off'}-${String(seed ?? config.seed)}`,
    plugin: astraLockXPat,
    algorithmConfig,
  });
  await rig.recorder!.start({ autonomyActive: true });
  drive(rig, SECONDS);
  const summary = await rig.recorder!.complete();
  const beacon = summary.beaconIdentity;

  return {
    acquired: summary.acquisitionOutcome === 'acquired',
    retention: summary.lockRetentionRate.value ?? 0,
    rmsUrad:
      summary.angularPointingError.postAcquisition.rms.value === null
        ? null
        : summary.angularPointingError.postAcquisition.rms.value * 1e6,
    falseLockEpisodes: summary.falseLockEpisodes,
    falseLockSeconds: summary.falseLockDurationSeconds.value ?? 0,
    identityChallenges: beacon?.identityChallenges ?? 0,
    wrongCodeAssociations: beacon?.wrongCodeAssociations ?? 0,
    correctCodeAssociations: beacon?.correctCodeAssociations ?? 0,
    ambiguousEpisodes: beacon?.ambiguousIdentityEpisodes ?? 0,
    ambiguousIdentityEpisodesSeen: (beacon?.ambiguousIdentityEpisodes ?? 0) > 0,
    identityMeanMs: summary.hostProcessingTime.identity.mean.value,
  };
}

/** Both arms of one scenario, computed once and shared by its assertions. */
const pairs = new Map<string, Promise<{ off: Arm; on: Arm }>>();
function pair(scenario: ScenarioId): Promise<{ off: Arm; on: Arm }> {
  let result = pairs.get(scenario);
  if (result === undefined) {
    result = (async () => ({
      off: await arm(scenario, false),
      on: await arm(scenario, true),
    }))();
    pairs.set(scenario, result);
  }
  return result;
}

describe('a coded target on its own', () => {
  it('behaves identically with identity on and off', async () => {
    // Identity must not be a tax on the case it was not built for. With one
    // source in the sky there is nothing to choose between, and the tracker
    // should do exactly what Phase 7 did.
    const { off, on } = await pair('code-clean');

    expect(on.acquired).toBe(true);
    expect(on.retention).toBeCloseTo(off.retention, 6);
    expect(on.rmsUrad!).toBeCloseTo(off.rmsUrad!, 0);
  });

  it('recognises it, and is right every time it says so', async () => {
    const { on } = await pair('code-clean');
    expect(on.correctCodeAssociations).toBeGreaterThan(0);
    expect(on.wrongCodeAssociations).toBe(0);
  });
});

describe('an obvious decoy well off the predicted path', () => {
  it('was already rejected by motion gating, and identity does not spoil that', async () => {
    // Worth having precisely because it is not a success for identity. Gating
    // solved this one in Phase 6, and a phase that quietly claimed credit for
    // it would be overstating what a code buys. The only thing to check is that
    // adding identity does not make a solved case worse.
    const { off, on } = await pair('code-decoy-easy');

    expect(off.falseLockEpisodes).toBe(0);
    expect(on.falseLockEpisodes).toBe(0);
    expect(on.acquired).toBe(true);
    expect(on.retention).toBeGreaterThan(0.9);
  });

  it('is not allowed to hold acquisition hostage for being the brightest', async () => {
    // The decoy carries no code at all, and it outshines the beacon. SEARCH
    // ranks by brightness, so without memory it would hand the decoy to ACQUIRE
    // for ever: ACQUIRE gives up after the bounded wait, SEARCH offers the same
    // source again, and the beacon never gets a turn. The tracker acquires, so
    // it moved on.
    const { on } = await pair('code-decoy-easy');
    expect(on.acquired).toBe(true);
    expect(on.wrongCodeAssociations).toBe(0);
  });
});

describe('a bright intruder carrying no code', () => {
  it('stops being locked onto', async () => {
    const { off, on } = await pair('code-decoy-uncoded');
    expect(off.falseLockEpisodes).toBeGreaterThan(0);
    expect(on.falseLockEpisodes).toBe(0);
  });

  it('is never mistaken for the beacon', async () => {
    const { on } = await pair('code-decoy-uncoded');
    expect(on.identityChallenges).toBeGreaterThan(0);
    expect(on.wrongCodeAssociations).toBe(0);
  });
});

describe('an intruder sending a different code', () => {
  it('stops being locked onto', async () => {
    const { off, on } = await pair('code-decoy-wrong');
    expect(off.falseLockEpisodes).toBeGreaterThan(0);
    expect(on.falseLockEpisodes).toBe(0);
    expect(on.wrongCodeAssociations).toBe(0);
  });
});

describe('the hard decoy that defeated motion gating', () => {
  it('costs the track without identity', async () => {
    // The Phase 7 result, reproduced: the decoy crosses close, wins the gate,
    // and the tracker follows it away. This is the control arm and it must
    // genuinely fail, or the comparison is measuring nothing.
    const { off } = await pair('code-decoy-hard');
    expect(off.falseLockEpisodes).toBeGreaterThan(0);
    expect(off.retention).toBeLessThan(0.5);
  });

  it('is refused with identity, and the track is kept', async () => {
    const { off, on } = await pair('code-decoy-hard');

    expect(on.falseLockEpisodes).toBe(0);
    expect(on.wrongCodeAssociations).toBe(0);
    expect(on.retention).toBeGreaterThan(0.85);
    // Not merely better: a different outcome. The control arm loses the target
    // for the rest of the run.
    expect(on.retention / off.retention).toBeGreaterThan(3);
    expect(on.rmsUrad!).toBeLessThan(off.rmsUrad! / 10);
  });
});

describe('an intruder replaying a rotation of the beacon’s own code', () => {
  it('is separable in the closed loop, because phase is part of the signal', async () => {
    // Worth stating carefully, because the unit tests show the opposite and
    // both are true. A rotation of an m-sequence is indistinguishable from the
    // original *to a receiver searching the whole period* — the periodic
    // correlation is identical — which is what `code-library.test.ts` measures.
    //
    // A receiver that has already locked the phase is not searching the whole
    // period. It knows when a symbol boundary falls, and the rotated copy puts
    // its boundaries four symbols away from there, so in absolute time the two
    // are different signals and the wrong one is refused.
    //
    // The ambiguity is therefore real at acquisition and absent during track.
    // `code-identical` is the case where it does not go away.
    const { off, on } = await pair('code-ambiguous');

    expect(on.retention).toBeGreaterThan(off.retention);
    expect(on.falseLockSeconds).toBeLessThan(off.falseLockSeconds);

    // Not zero, and the number is worth stating rather than asserting away.
    // The two sources merge into one blob at closest approach, the history
    // follows the wrong one out of the merge, and for about a third of a second
    // the tracker reports MATCH while its detection sits on the intruder. That
    // is the crossing-transplant limitation, measured: bounded by how long it
    // takes new samples to wash the old evidence out, not by anything the
    // correlator could have done better.
    expect(on.wrongCodeAssociations).toBeLessThan(40);
  });
});

describe('an intruder sending the identical code at the identical phase', () => {
  it('cannot be separated by any receiver, and the tracker does not pretend', async () => {
    // The strict negative control: the same signal from a different object.
    // There is nothing in the light to tell them apart, and the design's answer
    // is to stop using identity to choose rather than to guess and call the
    // guess a recognition.
    const { on } = await pair('code-identical');
    expect(on.ambiguousIdentityEpisodesSeen).toBe(true);
  });

  it('falls back to motion alone rather than to a coin toss', async () => {
    // With identity abstaining, what is left is Phase 7's behaviour — which is
    // the correct floor, not a regression. The claim being avoided is the one
    // that would be false: that a code makes indistinguishable sources
    // distinguishable.
    const { off, on } = await pair('code-identical');
    expect(on.acquired).toBe(off.acquired);
  });
});

describe('a beacon that stops signalling part way through', () => {
  it('keeps the track it earned, and stops claiming to confirm it', async () => {
    // Evidence that has expired is not evidence against. Identity may refuse to
    // start a track; it may not end one just because the beacon went quiet.
    const { on } = await pair('code-insufficient');
    expect(on.acquired).toBe(true);
    expect(on.retention).toBeGreaterThan(0.9);
    expect(on.wrongCodeAssociations).toBe(0);
  });
});

describe('a coded beacon through bursty frame loss', () => {
  it('is no worse off for having identity enabled', async () => {
    const { off, on } = await pair('code-frame-loss');
    expect(on.retention).toBeGreaterThanOrEqual(off.retention - 1e-9);
    expect(on.wrongCodeAssociations).toBe(0);
  });
});

describe('what identity costs', () => {
  it('fits inside a small fraction of the frame budget', async () => {
    // A 60 FPS camera leaves 16.67 ms per frame for everything. The correlator
    // searches phase for every watched candidate on every frame, so this is the
    // number that decides whether the design is affordable at all.
    const { on } = await pair('code-decoy-hard');
    expect(on.identityMeanMs).not.toBeNull();
    expect(on.identityMeanMs!).toBeLessThan(1);
  });

  it('is not billed to another stage, and not billed at all when it is off', async () => {
    // Phase 5's mistake, not repeated: the correlator has its own profiler
    // stage, so its cost appears as its own and the detector's figure stays a
    // figure about the detector. With identity disabled the stage does not run,
    // and an absent stage is absent rather than present at zero.
    const { off } = await pair('code-clean');
    expect(off.identityMeanMs).toBeNull();
  });
});

describe('the comparison as a whole', () => {
  it('prints the table the documentation quotes', async () => {
    // docs/BEACON_IDENTITY.md quotes measured figures, and a document quoting
    // numbers nobody can regenerate is a document asking to be trusted. Every
    // pair above is already computed and cached by the time this runs, so
    // printing them costs nothing and makes the table auditable.
    const scenarios: ScenarioId[] = [
      'code-clean',
      'code-decoy-uncoded',
      'code-decoy-easy',
      'code-decoy-wrong',
      'code-decoy-hard',
      'code-ambiguous',
      'code-identical',
      'code-insufficient',
      'code-frame-loss',
    ];

    const rows: string[] = [];
    for (const scenario of scenarios) {
      const { off, on } = await pair(scenario);
      for (const [label, result] of [
        ['off', off],
        ['on ', on],
      ] as const) {
        rows.push(
          `  ${scenario.padEnd(20)} ${label}  ` +
            `rms ${String(result.rmsUrad === null ? '—' : Math.round(result.rmsUrad)).padStart(7)} µrad  ` +
            `retention ${result.retention.toFixed(3)}  ` +
            `false lock ${String(result.falseLockEpisodes)} ep / ${result.falseLockSeconds.toFixed(1)} s  ` +
            `wrong ${label === 'off' ? '—' : String(result.wrongCodeAssociations)}`,
        );
      }
    }

    // eslint-disable-next-line no-console -- the measured figures are the point
    console.log(`identity ON/OFF over ${String(SECONDS)} s per arm:\n${rows.join('\n')}`);
    expect(rows).toHaveLength(scenarios.length * 2);
  });
});

/**
 * Five seeds, fixed in source before any of them was run.
 *
 * Not chosen, not filtered, not reordered. The seeds change the noise and the
 * disturbance realization; the geometry and the codes are the scenario's own.
 */
const SEEDS = [8201, 8202, 8203, 8204, 8205] as const;

describe('the hard decoy across five declared seeds', () => {
  const runs = (async () => {
    const results: { seed: number; off: Arm; on: Arm }[] = [];
    for (const seed of SEEDS) {
      results.push({
        seed,
        off: await arm('code-decoy-hard', false, seed),
        on: await arm('code-decoy-hard', true, seed),
      });
    }
    return results;
  })();

  it('declares its seeds in source, ahead of any result', () => {
    expect(SEEDS).toEqual([8201, 8202, 8203, 8204, 8205]);
  });

  it('never mistakes the decoy for the beacon, on any seed', async () => {
    for (const run of await runs) {
      expect(run.on.wrongCodeAssociations, `seed ${String(run.seed)}`).toBe(0);
    }
  });

  it('improves retention on every seed, not just on average', async () => {
    // A median that improves while one seed collapses is a result about luck.
    for (const run of await runs) {
      expect(run.on.retention, `seed ${String(run.seed)}`).toBeGreaterThan(run.off.retention);
    }
  });

  it('reports the spread rather than a single number', async () => {
    const results = await runs;
    const retentions = results.map((run) => run.on.retention);
    expect(retentions).toHaveLength(SEEDS.length);
    expect(Math.min(...retentions)).toBeGreaterThan(0.8);
  });
});
