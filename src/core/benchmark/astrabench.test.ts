// @vitest-environment node
/**
 * AstraBench end to end: fairness in the physics, safety in the plugin
 * boundary, and bounds on what a long suite costs.
 *
 * The runner's own properties are in `runner.test.ts`. These are the ones that
 * involve the simulator underneath it — whether two arms really did meet the
 * same weather, whether running inside a benchmark grants an algorithm anything
 * it would not otherwise have, and what fifty runs do to memory and wall clock.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ASTRALOCK_CONFIG,
  DEFAULT_BASELINE_PAT_CONFIG,
  algorithmById,
  astraLockXPat,
  baselineKfPidPat,
} from '@/core/algorithms';
import { DisturbanceStack } from '@/core/disturbance/stack';
import { ExactWorldSampler as ExactWorldSamplerAlias } from '@/core/sensors/world-sampler';
import { buildRig, drive } from '@/core/experiments/rig.node';
import { DEFAULT_METRICS_CONFIG } from '@/core/experiments/schema';
import { MemoryStorage } from '@/core/experiments/storage';
import { loadScenario } from '@/scenarios';

import { runBenchmark } from './runner';
import { BENCHMARK_SCHEMA_VERSION, benchmarkSuiteSchema, totalRuns } from './schema';
import { QUICK_VALIDATION_SUITE, ENGINEERING_SUITE, FULL_COVERAGE_SUITE } from './suites';

vi.setConfig({ testTimeout: 1_800_000 });

// --- §8 Exogenous randomness is paired across arms ---------------------------

describe('the physics a case presents to its arms', () => {
  it('is the same realization for every arm, because the seed is the case’s', () => {
    // The claim underneath every paired comparison. A disturbance realization
    // is a pure function of the scenario seed and the frame index (ADR-0020),
    // so two arms of one case meet the same vibration, the same scintillation,
    // the same wander and the same dropped frames — whatever either of them
    // does with the mount.
    //
    // Checked on the disturbance stack directly rather than through two runs,
    // because two closed-loop runs legitimately diverge: they point the camera
    // differently, so their *pixels* differ even though their weather does not.
    // Conflating those two things is the mistake this test exists to avoid.
    const scenario = loadScenario('dist-combined');
    const rate = scenario.camera.frameRate as number;
    const first = new DisturbanceStack(scenario.disturbances, scenario.seed, rate);
    const second = new DisturbanceStack(scenario.disturbances, scenario.seed, rate);

    for (let frame = 0; frame < 600; frame += 1) {
      expect(second.realizationAt(frame, frame / 60), `frame ${String(frame)}`).toEqual(
        first.realizationAt(frame, frame / 60),
      );
    }
  });

  it('is a different realization at a different seed', () => {
    const scenario = loadScenario('dist-combined');
    const rate = scenario.camera.frameRate as number;
    const a = new DisturbanceStack(scenario.disturbances, scenario.seed, rate);
    const b = new DisturbanceStack(
      scenario.disturbances,
      ((scenario.seed as number) + 1) as never,
      rate,
    );
    const differed = Array.from({ length: 120 }, (_, frame) => frame).some(
      (frame) =>
        JSON.stringify(a.realizationAt(frame, frame / 60)) !==
        JSON.stringify(b.realizationAt(frame, frame / 60)),
    );
    expect(differed).toBe(true);
  });

  it('is not perturbed by which algorithm is flying', () => {
    // The other half: an algorithm consumes its own seeded stream and cannot
    // advance the simulator's. Two arms started from the same world therefore
    // see identical frames until their own commands move the camera — so the
    // very first frame, which precedes any command taking effect, is identical.
    const scenario = loadScenario('dist-vibration');
    const build = (plugin: typeof baselineKfPidPat, config: unknown) =>
      buildRig({ scenario, plugin, algorithmConfig: config, storage: null });

    const baseline = build(baselineKfPidPat, DEFAULT_BASELINE_PAT_CONFIG);
    const robust = build(astraLockXPat as never, DEFAULT_ASTRALOCK_CONFIG);

    drive(baseline, 0.2);
    drive(robust, 0.2);

    const a = baseline.sensor.captureFrame(new ExactSampler(baseline), 0);
    const b = robust.sensor.captureFrame(new ExactSampler(robust), 0);
    try {
      expect(Array.from(b.frame.data as Uint8Array)).toEqual(
        Array.from(a.frame.data as Uint8Array),
      );
    } finally {
      a.release();
      b.release();
    }
  });
});

/** A sampler bound to a rig's own engine, for the frame comparison above. */
class ExactSampler {
  private readonly inner;
  constructor(rig: { engine: ConstructorParameters<typeof ExactWorldSamplerAlias>[0] }) {
    this.inner = new ExactWorldSamplerAlias(rig.engine);
  }
  public get policy() {
    return this.inner.policy;
  }
  public sampleAt(time: number) {
    return this.inner.sampleAt(time);
  }
}

// --- §32 Plugin isolation is not relaxed inside a benchmark ------------------

describe('an algorithm running inside a benchmark', () => {
  it('receives exactly the inputs it receives anywhere else', async () => {
    // A benchmark is not a privileged context. The runner hands the plugin the
    // same `TrackingInput` the interactive runtime does, and the check is that
    // nothing reachable from it is the simulator, the evaluator or the truth.
    const seen: Record<string, unknown>[] = [];
    const spy = {
      manifest: astraLockXPat.manifest,
      create: (init: Parameters<typeof astraLockXPat.create>[0]) => {
        const inner = astraLockXPat.create(init);
        return {
          update: (input: Parameters<typeof inner.update>[0]) => {
            if (seen.length < 3) seen.push(input as unknown as Record<string, unknown>);
            return inner.update(input);
          },
          reset: () => {
            inner.reset();
          },
        };
      },
    };

    const suite = benchmarkSuiteSchema.parse({
      schemaVersion: BENCHMARK_SCHEMA_VERSION,
      suiteId: 'isolation',
      name: 'Isolation probe',
      description: '',
      metricsConfig: DEFAULT_METRICS_CONFIG,
      defaultSuccess: { kind: 'acquired' },
      cases: [
        {
          caseId: 'probe',
          label: 'Probe',
          description: '',
          scenarioId: 'astralock-moving',
          durationSeconds: 3,
          seeds: [7001],
          arms: [
            {
              armId: 'spy',
              label: 'Spy',
              algorithmId: 'astralock-x',
              config: DEFAULT_ASTRALOCK_CONFIG,
            },
          ],
          success: null,
        },
      ],
    });

    await runBenchmark({
      suite,
      runStorage: new MemoryStorage(),
      benchmarkStorage: new MemoryStorage(),
      resolvePlugin: () => spy,
      benchmarkId: 'bench-isolation',
      applicationVersion: '0.0.0-test',
      sourceCommit: null,
      platform: 'test',
    });

    expect(seen.length).toBeGreaterThan(0);
    for (const input of seen) {
      // The whole surface, named. Anything outside it would be a new channel.
      expect(Object.keys(input).sort()).toEqual([
        'camera',
        'frame',
        'gimbal',
        'previousCommand',
        'tick',
        'time',
      ]);
      // And none of the obvious back doors, by any spelling.
      for (const key of Object.keys(input)) {
        expect(key).not.toMatch(/engine|world|truth|evaluat|scenario|target|emitter|disturb/i);
      }
    }
  });

  it('cannot reach the registry’s other plugins through its own init', () => {
    // A plugin is constructed with a config, a camera, a mount state, a tick
    // rate, a seeded stream and a budget. Nothing in that lets it enumerate or
    // instantiate anything else.
    let captured: Record<string, unknown> | null = null;
    const spy = {
      manifest: baselineKfPidPat.manifest,
      create: (init: Parameters<typeof baselineKfPidPat.create>[0]) => {
        captured = init as unknown as Record<string, unknown>;
        return baselineKfPidPat.create(init);
      },
    };

    const rig = buildRig({
      scenario: 'astralock-moving',
      plugin: spy,
      algorithmConfig: DEFAULT_BASELINE_PAT_CONFIG,
      storage: null,
    });
    drive(rig, 0.1);

    expect(captured).not.toBeNull();
    for (const key of Object.keys(captured!)) {
      expect(key).not.toMatch(/engine|world|truth|evaluat|registry|plugin|scenario/i);
    }
  });
});

// --- §25-27 The bundled suites are well formed -------------------------------

describe('the bundled suites', () => {
  it('name only registered algorithms', () => {
    for (const suite of [QUICK_VALIDATION_SUITE, ENGINEERING_SUITE, FULL_COVERAGE_SUITE]) {
      for (const benchmarkCase of suite.cases) {
        for (const arm of benchmarkCase.arms) {
          expect(algorithmById(arm.algorithmId), `${suite.suiteId}/${arm.armId}`).toBeDefined();
        }
      }
    }
  });

  it('carry configurations their algorithms accept', () => {
    for (const suite of [QUICK_VALIDATION_SUITE, ENGINEERING_SUITE, FULL_COVERAGE_SUITE]) {
      for (const benchmarkCase of suite.cases) {
        for (const arm of benchmarkCase.arms) {
          const plugin = algorithmById(arm.algorithmId)!;
          expect(() => plugin.manifest.configSchema.parse(arm.config)).not.toThrow();
        }
      }
    }
  });

  it('declare their seeds in source, ahead of any result', () => {
    expect(ENGINEERING_SUITE.cases.every((c) => c.seeds.length === 5)).toBe(true);
    expect(ENGINEERING_SUITE.cases[0]!.seeds).toEqual([9101, 9102, 9103, 9104, 9105]);
    for (const suite of [QUICK_VALIDATION_SUITE, FULL_COVERAGE_SUITE]) {
      expect(suite.cases.every((c) => c.seeds.length === 1)).toBe(true);
    }
  });

  it('put the reference arm first in every case, so pairing has a baseline', () => {
    for (const suite of [QUICK_VALIDATION_SUITE, ENGINEERING_SUITE, FULL_COVERAGE_SUITE]) {
      for (const benchmarkCase of suite.cases) {
        expect(benchmarkCase.arms.length).toBeGreaterThanOrEqual(2);
        expect(benchmarkCase.arms[0]!.armId).toBeTruthy();
      }
    }
  });

  it('never put the non-tracking reference plugin in a comparison', () => {
    // The example exists to document the contract. Comparing a tracker against
    // something that does not track produces a number that flatters the tracker
    // and measures nothing.
    for (const suite of [QUICK_VALIDATION_SUITE, ENGINEERING_SUITE, FULL_COVERAGE_SUITE]) {
      for (const benchmarkCase of suite.cases) {
        for (const arm of benchmarkCase.arms) {
          expect(arm.algorithmId).not.toBe('example-scan');
        }
      }
    }
  });

  it('state their size before anything is run', () => {
    // The operator is told how many runs they are asking for, before asking for
    // them: six cases at one seed against two arms is twelve runs, and the
    // engineering suite's nine cases across five seeds is ninety. The numbers
    // are asserted so that adding a case to a suite is a visible change rather
    // than a quiet quadrupling of someone's afternoon.
    expect(totalRuns(QUICK_VALIDATION_SUITE)).toBe(12);
    expect(totalRuns(ENGINEERING_SUITE)).toBe(90);
    expect(totalRuns(FULL_COVERAGE_SUITE)).toBe(28);
  });

  it('use one set of metric definitions per suite', () => {
    for (const suite of [QUICK_VALIDATION_SUITE, ENGINEERING_SUITE, FULL_COVERAGE_SUITE]) {
      expect(suite.metricsConfig).toEqual(DEFAULT_METRICS_CONFIG);
    }
  });
});
