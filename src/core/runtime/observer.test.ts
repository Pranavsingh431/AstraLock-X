// @vitest-environment node
/**
 * Watching the loop without touching it.
 *
 * The recorder is one observer; these tests are about the seam itself. An
 * observer can be attached and detached mid-run without disturbing the
 * algorithm, it hears about every applied command exactly once with the
 * instant the mount actually applied it, and the host timings it is handed
 * partition the work honestly.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_BASELINE_PAT_CONFIG, baselineKfPidPat } from '@/core/algorithms';
import type { StageProfiler } from '@/core/contracts/algorithm-plugin';
import { UNPROFILED } from '@/core/contracts/algorithm-plugin';
import { SimulationEngine } from '@/core/simulation/engine';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';
import { loadScenario } from '@/scenarios';

import type { AppliedCommandObservation, LoopObservation, LoopObserver } from './closed-loop';
import { ClosedLoopRuntime } from './closed-loop';

vi.setConfig({ testTimeout: 120_000 });

function rig(observer?: LoopObserver) {
  const engine = new SimulationEngine(loadScenario('pat-stationary-outside-fov'));
  const runtime = new ClosedLoopRuntime({
    engine,
    sensor: new VirtualCameraSensor({ config: engine.config }),
    sampler: new ExactWorldSampler(engine),
    plugin: baselineKfPidPat,
    config: DEFAULT_BASELINE_PAT_CONFIG,
    ...(observer === undefined ? {} : { observer }),
  });
  return { engine, runtime };
}

class Collector implements LoopObserver {
  public readonly frames: LoopObservation[] = [];
  public readonly applied: AppliedCommandObservation[] = [];
  public sensorFrames = 0;
  public onFrameProcessed(observation: LoopObservation): void {
    this.frames.push(observation);
  }
  public onSensorFrame(): void {
    this.sensorFrames += 1;
  }
  public onCommandApplied(applied: AppliedCommandObservation): void {
    this.applied.push(applied);
  }
}

/** Steps a rig, appending each mode change to `modes`, and returns the engineering state. */
const trace = (r: ReturnType<typeof rig>, ticks: number, modes: string[] = []) => {
  for (let tick = 0; tick < ticks; tick += 1) {
    r.runtime.step(1);
    const mode = `${r.runtime.algorithmOutput?.pat.mode ?? ''}`;
    if (modes[modes.length - 1]?.split('@')[0] !== mode)
      modes.push(`${mode}@${String(r.engine.tick)}`);
  }
  return { modes, hash: r.engine.stateHash() };
};

describe('attaching and detaching an observer', () => {
  it('changes nothing about the run, even mid-acquisition', () => {
    const plain = rig();
    const watched = rig();
    const collector = new Collector();

    const reference = trace(plain, 20 * 200);

    // Attach at 5 s, detach at 13 s — during search and through acquisition.
    const modes: string[] = [];
    trace(watched, 5 * 200, modes);
    watched.runtime.observe(collector);
    trace(watched, 8 * 200, modes);
    watched.runtime.observe(null);
    const after = trace(watched, 7 * 200, modes);

    expect(modes).toEqual(reference.modes);
    expect(modes.some((m) => m.startsWith('track'))).toBe(true);
    expect(watched.runtime.issuedCommands).toEqual(plain.runtime.issuedCommands);
    expect(watched.engine.gimbal.measuredPointing()).toEqual(
      plain.engine.gimbal.measuredPointing(),
    );
    expect(after.hash).toBe(reference.hash);
    expect(collector.frames.length).toBe(8 * 60);
  });
});

describe('applied commands', () => {
  it('are reported once each, in order, with the instant the mount applied them', () => {
    const collector = new Collector();
    const r = rig(collector);
    trace(r, 10 * 200);

    const latency = r.engine.config.gimbal.commandLatency;
    const issued = new Map(
      collector.frames.flatMap((f) => (f.command === null ? [] : [[f.command.commandId, f]])),
    );

    expect(collector.applied.length).toBeGreaterThan(500);
    const ids = collector.applied.map((a) => a.commandId);
    expect(new Set(ids).size).toBe(ids.length);
    for (let i = 1; i < ids.length; i += 1) expect(ids[i]!).toBeGreaterThan(ids[i - 1]!);

    for (const applied of collector.applied) {
      const origin = issued.get(applied.commandId)!;
      expect(applied.frameId).toBe(origin.frame.frameId);
      expect(applied.captureTime).toBe(origin.frame.captureTime);
      expect(applied.issuedAt).toBe(origin.command!.issuedAt);
      // The mount applies commands at their exact due time.
      expect(applied.appliedAt).toBe(applied.dueAt);
      expect(applied.dueAt - applied.issuedAt).toBeCloseTo(latency, 12);
    }
  });

  it('reports a command the runtime did not issue without inventing its frame', () => {
    const collector = new Collector();
    const r = rig(collector);
    r.engine.gimbal.commandPosition(0.1, 0.05);
    trace(r, 20);
    const external = collector.applied.find((a) => a.frameId === null);
    expect(external).toBeDefined();
    expect(external!.captureTime).toBeNull();
  });
});

describe('the gimbal applied-command log', () => {
  it('returns exactly the commands applied since a count, and refuses a gap', () => {
    const engine = new SimulationEngine(loadScenario('gimbal-latency'));
    const gimbal = engine.gimbal;
    expect(gimbal.appliedCommandCount).toBe(0);

    for (let i = 0; i < 3; i += 1) gimbal.commandPosition(0.01 * i, 0);
    engine.step(20);
    expect(gimbal.appliedCommandCount).toBe(3);
    expect(gimbal.appliedCommandsSince(1).map((r) => r.command.commandId)).toEqual([1, 2]);
    expect(gimbal.appliedCommandsSince(3)).toEqual([]);

    for (let i = 0; i < 70; i += 1) gimbal.commandPosition(0.001 * i, 0);
    engine.step(20);
    // The log is bounded; asking for records it no longer holds is an error,
    // never a silently shorter list.
    expect(() => gimbal.appliedCommandsSince(0)).toThrow(RangeError);

    gimbal.reset();
    expect(gimbal.appliedCommandCount).toBe(0);
    expect(gimbal.appliedCommandsSince(0)).toEqual([]);
  });
});

describe('host timings handed to an observer', () => {
  it('partition each iteration into non-negative parts, with stages absent when they did not run', () => {
    const collector = new Collector();
    const r = rig(collector);
    trace(r, 20 * 200);

    let searchedWithoutEstimator = false;
    let trackedWithEstimator = false;
    for (const { timings, output } of collector.frames) {
      for (const value of [
        timings.worldStepMs,
        timings.sensorFrameMs,
        timings.algorithmMs,
        timings.orchestrationMs,
      ]) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(Number.isFinite(value)).toBe(true);
      }
      expect(timings.stages.detector).not.toBeNull();
      if (output.pat.mode === 'scan' && timings.stages.estimator === null) {
        searchedWithoutEstimator = true;
      }
      if (output.pat.mode === 'track' && timings.stages.estimator !== null) {
        trackedWithEstimator = true;
      }
    }
    expect(searchedWithoutEstimator).toBe(true);
    expect(trackedWithEstimator).toBe(true);
    expect(collector.sensorFrames).toBe(collector.frames.length);
  });
});

describe('the stage profiler handed to an algorithm', () => {
  it('returns the work result and never a duration', () => {
    let captured: StageProfiler | null = null;
    const spy = {
      ...baselineKfPidPat,
      create: (init: Parameters<typeof baselineKfPidPat.create>[0]) => {
        captured = init.profiler ?? null;
        return baselineKfPidPat.create(init);
      },
    };
    const engine = new SimulationEngine(loadScenario('pat-stationary-outside-fov'));
    new ClosedLoopRuntime({
      engine,
      sensor: new VirtualCameraSensor({ config: engine.config }),
      sampler: new ExactWorldSampler(engine),
      plugin: spy,
      config: DEFAULT_BASELINE_PAT_CONFIG,
    });

    expect(captured).not.toBeNull();
    const profiler = captured! as StageProfiler & Record<string, unknown>;
    expect(profiler.time('detector', () => 42)).toBe(42);
    // Nothing on the object but the one write-only method.
    expect(Object.keys(profiler)).toEqual(['time']);
    expect(profiler['totals']).toBeUndefined();
  });

  it('does not change what the algorithm computes', () => {
    // The same closed loop twice: once with the runtime's host profiler, once
    // with the algorithm handed a profiler that measures nothing. Timing must
    // be invisible to the result.
    const unprofiled = {
      ...baselineKfPidPat,
      create: (init: Parameters<typeof baselineKfPidPat.create>[0]) =>
        baselineKfPidPat.create({ ...init, profiler: UNPROFILED }),
    };
    const build = (plugin: typeof baselineKfPidPat) => {
      const engine = new SimulationEngine(loadScenario('pat-moving-target'));
      return {
        engine,
        runtime: new ClosedLoopRuntime({
          engine,
          sensor: new VirtualCameraSensor({ config: engine.config }),
          sampler: new ExactWorldSampler(engine),
          plugin,
          config: DEFAULT_BASELINE_PAT_CONFIG,
        }),
      };
    };
    const profiled = build(baselineKfPidPat);
    const plain = build(unprofiled);
    const a = trace(profiled, 35 * 200);
    const b = trace(plain, 35 * 200);

    expect(a.modes).toEqual(b.modes);
    expect(profiled.runtime.issuedCommands).toEqual(plain.runtime.issuedCommands);
    expect(a.hash).toBe(b.hash);
  });
});
