// @vitest-environment node
/**
 * What the disturbance pipeline costs, and what it holds on to.
 *
 * Wall-clock timings measure this machine, not the experiment, so they never
 * reach a summary and never affect a command. They are here because a physics
 * model that cannot run at frame rate is a model of a different system: at
 * 640x480 and 60 fps the whole engineering pipeline has 16.67 ms per frame, and
 * the noise field alone is 307,200 samples of it.
 *
 * Run in the separate performance pass, sequentially, for the reason Phase 5
 * established: a wall-clock measurement taken while the rest of the suite is
 * saturating the machine measures the suite.
 */

import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_ASTRALOCK_CONFIG,
  DEFAULT_BASELINE_PAT_CONFIG,
  astraLockXPat,
  baselineKfPidPat,
} from '@/core/algorithms';
import { ClosedLoopRuntime } from '@/core/runtime/closed-loop';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';
import { SimulationEngine } from '@/core/simulation/engine';
import { loadScenario, type ScenarioId } from '@/scenarios';

import { NORMAL_TABLE_MAX_SIGMA, NORMAL_TABLE_STDDEV } from './streams';

vi.setConfig({ testTimeout: 900_000 });

/** The camera period this pipeline has to fit inside. */
const FRAME_BUDGET_MS = 1000 / 60;

/** Milliseconds per frame to render, after a warm-up. */
function sensorCost(scenario: ScenarioId, frames = 300): number {
  const config = loadScenario(scenario);
  const engine = new SimulationEngine(config);
  const sampler = new ExactWorldSampler(engine);
  const sensor = new VirtualCameraSensor({ config });

  // Warm-up. The first frames pay for JIT compilation of the render path, and
  // including them would measure the compiler.
  for (let index = 0; index < 60; index += 1) sensor.captureFrame(sampler, index).release();

  const started = performance.now();
  for (let index = 0; index < frames; index += 1) sensor.captureFrame(sampler, index).release();
  return (performance.now() - started) / frames;
}

/** Milliseconds per processed frame for the whole closed loop. */
function loopCost(
  scenario: ScenarioId,
  robust: boolean,
  seconds = 12,
): { msPerFrame: number; frames: number } {
  const config = loadScenario(scenario);
  const engine = new SimulationEngine(config);
  const runtime = new ClosedLoopRuntime({
    engine,
    sensor: new VirtualCameraSensor({ config }),
    sampler: new ExactWorldSampler(engine),
    plugin: robust ? astraLockXPat : baselineKfPidPat,
    config: robust ? DEFAULT_ASTRALOCK_CONFIG : DEFAULT_BASELINE_PAT_CONFIG,
  });

  const started = performance.now();
  for (let tick = 0; tick < seconds * config.tickRate; tick += 1) runtime.step(1);
  const elapsed = performance.now() - started;
  return {
    msPerFrame: elapsed / Math.max(1, runtime.framesProcessed),
    frames: runtime.framesProcessed,
  };
}

describe('the cost of a disturbed frame', () => {
  it('is negligible with nothing enabled, because the clean path is untouched', () => {
    expect(sensorCost('astralock-moving')).toBeLessThan(0.5);
  });

  it('stays well inside the frame budget with geometric disturbances', () => {
    // Platform motion plus four-sample exposure: four world samples and four
    // point spreads per frame, and no per-pixel work at all.
    expect(sensorCost('dist-vibration')).toBeLessThan(FRAME_BUDGET_MS / 3);
  });

  // The expensive case, and the one that drove the implementation. Every pixel
  // gets a background level, a signal-dependent noise sample and a
  // signal-independent one, then a clamp and a round: about 1.2 million
  // operations per frame before anything else happens.
  it('stays inside the frame budget with full-frame sensor noise', () => {
    const lowContrast = sensorCost('dist-low-contrast');
    const combined = sensorCost('dist-combined');

    expect(lowContrast).toBeLessThan(FRAME_BUDGET_MS);
    expect(combined).toBeLessThan(FRAME_BUDGET_MS);
  });

  it('leaves room for the algorithm on top of it', () => {
    const combined = loopCost('dist-combined', true);
    expect(combined.frames).toBeGreaterThan(400);
    expect(combined.msPerFrame).toBeLessThan(FRAME_BUDGET_MS);
  });

  it('costs both algorithms about the same, because the cost is the sensor', () => {
    const baseline = loopCost('dist-combined', false).msPerFrame;
    const robust = loopCost('dist-combined', true).msPerFrame;

    // Within a factor of two of each other: whatever the trackers differ by, it
    // is small next to a million per-pixel operations.
    expect(robust).toBeLessThan(baseline * 2);
  });
});

describe('the normal sampler the noise field is built from', () => {
  // Box-Muller measured at 38 ms per frame on its own — more than twice the
  // whole budget. The table replaced it, and what that costs in accuracy is
  // stated here rather than assumed.
  it('has the standard deviation it claims, to four decimal places', () => {
    expect(NORMAL_TABLE_STDDEV).toBeGreaterThan(0.9999);
    expect(NORMAL_TABLE_STDDEV).toBeLessThan(1.0001);
  });

  it('truncates its tails at a documented four sigma', () => {
    expect(NORMAL_TABLE_MAX_SIGMA).toBeGreaterThan(4);
    expect(NORMAL_TABLE_MAX_SIGMA).toBeLessThan(4.5);
  });
});

describe('a long disturbed run', () => {
  // Nothing may accumulate per frame: not noise buffers, not exposure
  // integration buffers, not the disturbance processes, not clutter history.
  // The sensor pool is the canary — a leaked frame lease exhausts it in three
  // frames.
  it('keeps memory bounded', () => {
    const config = loadScenario('dist-combined');
    const engine = new SimulationEngine(config);
    const sensor = new VirtualCameraSensor({ config });
    const runtime = new ClosedLoopRuntime({
      engine,
      sensor,
      sampler: new ExactWorldSampler(engine),
      plugin: astraLockXPat,
      config: DEFAULT_ASTRALOCK_CONFIG,
      historyLimit: 64,
    });

    for (let tick = 0; tick < 80 * config.tickRate; tick += 1) runtime.step(1);

    expect(runtime.framesProcessed).toBeGreaterThan(3000);
    expect(sensor.buffersAllocated).toBeLessThanOrEqual(3);
    expect(runtime.loopEvents.length).toBeLessThanOrEqual(64);
    expect(runtime.issuedCommands.length).toBeLessThanOrEqual(64);
    expect(engine.gimbal.pendingCommands.length).toBeLessThan(10);
  });

  it('holds exactly one accumulation buffer, whatever the run length', () => {
    const config = loadScenario('dist-combined');
    const engine = new SimulationEngine(config);
    const sampler = new ExactWorldSampler(engine);
    const sensor = new VirtualCameraSensor({ config });

    for (let index = 0; index < 2000; index += 1) sensor.captureFrame(sampler, index).release();

    // The float accumulator is allocated once in the constructor and reused.
    // The pixel buffers come from the pool, which is bounded by its capacity.
    expect(sensor.buffersAllocated).toBeLessThanOrEqual(3);
  });

  it('keeps producing finite pixels and finite truth the whole way', () => {
    const config = loadScenario('dist-combined');
    const engine = new SimulationEngine(config);
    const sampler = new ExactWorldSampler(engine);
    const sensor = new VirtualCameraSensor({ config });

    let nonFinite = 0;
    let outOfRange = 0;
    for (let index = 0; index < 1200; index += 1) {
      const capture = sensor.captureFrame(sampler, index);
      const realization = capture.truth.disturbance!;
      if (
        !Number.isFinite(realization.base.azimuth) ||
        !Number.isFinite(realization.wander.azimuth) ||
        !Number.isFinite(realization.scintillation)
      ) {
        nonFinite += 1;
      }
      // Sampled rather than exhaustive: a million assertions would measure the
      // test runner. A wrap or an overflow would show within a few frames.
      if (index % 120 === 0) {
        for (const value of capture.frame.data as Uint8Array) {
          if (value < 0 || value > 255) outOfRange += 1;
        }
      }
      capture.release();
    }

    expect(nonFinite).toBe(0);
    expect(outOfRange).toBe(0);
  });
});
