// @vitest-environment node
/**
 * Clean mode is Phase 6, exactly.
 *
 * Phase 7 adds a second image-formation path. The guarantee that makes that
 * safe is that a scenario with no disturbances takes the **original** path, not
 * a general one that happens to reduce to it: "almost the same pixels" would
 * have quietly invalidated every result recorded before this phase, and the
 * difference would be invisible in any picture.
 *
 * These tests hold both algorithms and the sensor to their pre-Phase-7
 * behaviour on the scenarios that were pinned to it.
 */

import { describe, expect, it, vi } from 'vitest';

import { CLEAN_DISTURBANCES, isCleanDisturbance } from '@/core/contracts/disturbance';
import { loadScenario, SCENARIO_IDS } from '@/scenarios';
import { buildRig, drive } from '@/core/experiments/rig.node';
import {
  DEFAULT_ASTRALOCK_CONFIG,
  DEFAULT_BASELINE_PAT_CONFIG,
  DEFAULT_TERMINAL_PROFILE_ID,
  astraLockXPat,
  baselineKfPidPat,
  terminalProfileById,
  withExpectedBeacon,
} from '@/core/algorithms';
import { ClosedLoopRuntime } from '@/core/runtime/closed-loop';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';
import { SimulationEngine } from '@/core/simulation/engine';

vi.setConfig({ testTimeout: 900_000 });

/**
 * The scenarios that existed before Phase 7, all of which are clean.
 *
 * `code-frame-loss` is excluded for the same reason the `dist-` set is: it is a
 * later scenario that deliberately configures a disturbance. Every other coded
 * scenario is clean and stays in the set, so the coded beacons are held to the
 * same "clean means exactly clean" guarantee as everything before them.
 */
const PRE_PHASE_7 = SCENARIO_IDS.filter(
  (id) => !id.startsWith('dist-') && id !== 'code-frame-loss',
);

describe('the scenarios that predate this phase', () => {
  it('are all clean, so none of them changed physics when disturbances arrived', () => {
    for (const id of PRE_PHASE_7) {
      expect(isCleanDisturbance(loadScenario(id).disturbances), id).toBe(true);
    }
  });

  it('declare the clean preset rather than leaving it unstated', () => {
    for (const id of PRE_PHASE_7) {
      expect(loadScenario(id).disturbances.preset, id).toBe('CLEAN');
    }
  });
});

describe('the sensor in clean mode', () => {
  /** Renders a frame and returns its pixels. */
  function frame(scenario: (typeof SCENARIO_IDS)[number], index: number): Uint8Array {
    const config = loadScenario(scenario);
    const engine = new SimulationEngine(config);
    const sensor = new VirtualCameraSensor({ config });
    const capture = sensor.captureFrame(new ExactWorldSampler(engine), index);
    const pixels = new Uint8Array(capture.frame.data as Uint8Array);
    capture.release();
    return pixels;
  }

  it('takes the pre-Phase-7 path, which is what makes clean mean exactly clean', () => {
    const config = loadScenario('astralock-moving');
    const sensor = new VirtualCameraSensor({ config });
    expect(sensor.hasDisturbances).toBe(false);
  });

  it('never reports a dropped frame', () => {
    const config = loadScenario('astralock-moving');
    const engine = new SimulationEngine(config);
    const sensor = new VirtualCameraSensor({ config });
    let delivered = 0;
    sensor.captureRange(new ExactWorldSampler(engine), -1, 2, () => {
      delivered += 1;
    });
    expect(sensor.framesDropped).toBe(0);
    expect(delivered).toBe(sensor.framesScheduled);
  });

  it('carries no disturbance realization on the truth record', () => {
    const config = loadScenario('astralock-moving');
    const engine = new SimulationEngine(config);
    const sensor = new VirtualCameraSensor({ config });
    const capture = sensor.captureFrame(new ExactWorldSampler(engine), 5);
    expect(capture.truth.disturbance).toBeNull();
    capture.release();
  });

  it('renders the same pixels twice, on every bundled clean scenario', () => {
    for (const id of PRE_PHASE_7) {
      expect([...frame(id, 7)], id).toEqual([...frame(id, 7)]);
    }
  });

  // The clean configuration is not merely "all zeroes": the renderer branches on
  // it, and a configuration wrongly judged dirty would silently change pixels
  // that a dozen regression tests are pinned to.
  it('is judged clean for an explicitly clean configuration', () => {
    expect(isCleanDisturbance(CLEAN_DISTURBANCES)).toBe(true);
  });
});

describe('both algorithms in clean mode', () => {
  const arm = (scenario: (typeof SCENARIO_IDS)[number], robust: boolean, seconds: number) =>
    drive(
      buildRig({
        scenario,
        storage: null,
        plugin: robust ? astraLockXPat : baselineKfPidPat,
        algorithmConfig: robust ? DEFAULT_ASTRALOCK_CONFIG : DEFAULT_BASELINE_PAT_CONFIG,
      }),
      seconds,
    );

  // These are the Phase-4 baseline's own scenarios, with the transition times
  // Phase 6 pinned them to. If Phase 7 had changed clean physics at all, these
  // would move.
  it.each([
    ['pat-stationary-outside-fov', ['scan', 'track'], 11.92],
    ['pat-moving-target', ['scan', 'track'], 25.92],
  ] as const)('leaves the baseline on %s unchanged', (scenario, modes, trackAt) => {
    const trace = arm(scenario, false, 40);
    const transitions = trace.modes.map((entry) => entry.split('@'));

    expect(transitions.map(([mode]) => mode)).toEqual(modes);
    expect(Number(transitions[1]![1])).toBeCloseTo(trackAt, 2);
  });

  it('leaves the baseline losing the target on pat-loss, exactly as before', () => {
    const trace = arm('pat-loss', false, 60);
    expect(trace.modes.map((entry) => entry.split('@')[0])).toEqual([
      'scan',
      'track',
      'lost',
      'scan',
    ]);
  });

  it('leaves AstraLock-X validating before it commits', () => {
    const trace = arm('astralock-stationary', true, 20);
    const modes = trace.modes.map((entry) => entry.split('@')[0]);
    expect(modes.slice(0, 3)).toEqual(['scan', 'acquire', 'track']);
  });

  it('is bit-for-bit reproducible for both arms on this machine', () => {
    for (const robust of [false, true]) {
      expect(arm('astralock-moving', robust, 15).stateHash).toBe(
        arm('astralock-moving', robust, 15).stateHash,
      );
    }
  });

  // Disturbances are physics, so they must not be able to reach the algorithm
  // even indirectly: on a clean run the two arms must process exactly the
  // frames the camera scheduled.
  it('processes every scheduled frame, because none can be dropped', () => {
    for (const robust of [false, true]) {
      const trace = arm('astralock-moving', robust, 10);
      expect(trace.framesProcessed).toBeGreaterThan(500);
    }
  });
});

describe('a coded scenario with identity switched off', () => {
  /** One run's observable behaviour: modes, commands and the world it left. */
  const behaviour = (identity: boolean) => {
    const engine = new SimulationEngine(loadScenario('code-clean'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const runtime = new ClosedLoopRuntime({
      engine,
      sensor,
      sampler: new ExactWorldSampler(engine),
      plugin: astraLockXPat,
      config: identity
        ? withExpectedBeacon(
            DEFAULT_ASTRALOCK_CONFIG,
            terminalProfileById(DEFAULT_TERMINAL_PROFILE_ID)!,
          )
        : DEFAULT_ASTRALOCK_CONFIG,
    });

    const modes: string[] = [];
    let last = '';
    for (let tick = 0; tick < 30 * engine.config.tickRate; tick += 1) {
      runtime.step(1);
      const mode = runtime.algorithmOutput?.pat.mode;
      if (mode !== undefined && mode !== last) {
        modes.push(mode);
        last = mode;
      }
    }
    return {
      modes,
      commands: runtime.issuedCommands.map((c) => `${c.azimuth.toExponential(15)}`),
      hash: engine.stateHash(),
      debug: runtime.algorithmOutput?.debug as Record<string, unknown>,
    };
  };

  it('is Phase 7, exactly', () => {
    // The control arm has to be a *control*. If switching identity off left any
    // trace — a different association, a different command, a different pixel —
    // then the ON/OFF comparison would be measuring two changes rather than one.
    const off = behaviour(false);

    expect(off.debug['identityEnabled']).toBe(false);
    expect(off.debug['identityState']).toBeNull();
    expect(off.debug['identityCandidates']).toBe(0);
    expect(off.debug['codeCorrelation']).toBeNull();
    // No correlator was built, so no history was kept and nothing was measured.
    expect(off.debug['identitySamples']).toBeNull();
  });

  it('differs from the identity arm only where identity had something to say', () => {
    // Both arms acquire and track the same single source, so the state
    // sequence is identical; what differs is the verdict reported alongside it.
    const off = behaviour(false);
    const on = behaviour(true);

    expect(on.modes).toEqual(off.modes);
    expect(on.commands).toEqual(off.commands);
    expect(on.hash).toBe(off.hash);
    expect(on.debug['identityState']).toBe('match');
  });
});
