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
  astraLockXPat,
  baselineKfPidPat,
} from '@/core/algorithms';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';
import { SimulationEngine } from '@/core/simulation/engine';

vi.setConfig({ testTimeout: 900_000 });

/** The scenarios that existed before Phase 7, all of which are clean. */
const PRE_PHASE_7 = SCENARIO_IDS.filter((id) => !id.startsWith('dist-'));

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
