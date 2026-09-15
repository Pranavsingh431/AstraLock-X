// @vitest-environment node
/**
 * What the robust algorithm costs, and what it holds on to.
 *
 * The baseline sat at about 1.1 ms per frame, almost all of it in the detector.
 * AstraLock-X adds an interacting-multiple-model estimator, gated association
 * and a latency-aware controller on top of the same detector, so the question
 * is whether that arithmetic is material next to the image work. The budget is
 * the camera's 16.67 ms frame period.
 *
 * Figures are measured and printed. The bounds are regression guards against
 * something accidentally quadratic, set well above the measurement so a machine
 * several times slower still passes.
 */

import { describe, expect, it, vi } from 'vitest';

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
import { loadScenario, type ScenarioId } from '@/scenarios';

import { ImmEstimator } from './imm';

vi.setConfig({ testTimeout: 900_000 });

const FRAME_BUDGET_MS = 1000 / 60;

/**
 * The robust algorithm's configuration, optionally with identity enabled.
 *
 * The receiver is set to the bundled Code A terminal profile explicitly, never
 * from the scenario (Phase 9 preflight).
 */
function astraConfig(_scenario: ScenarioId, identity: boolean) {
  if (!identity) return DEFAULT_ASTRALOCK_CONFIG;
  return withExpectedBeacon(
    DEFAULT_ASTRALOCK_CONFIG,
    terminalProfileById(DEFAULT_TERMINAL_PROFILE_ID)!,
  );
}

const summarise = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  return {
    mean: samples.reduce((a, b) => a + b, 0) / samples.length,
    median: sorted[Math.floor(sorted.length / 2)]!,
    p95: sorted[Math.floor(sorted.length * 0.95)]!,
    max: sorted[sorted.length - 1]!,
  };
};

/** Per-frame wall-clock cost of the whole loop for one algorithm. */
function measureLoop(scenario: ScenarioId, robust: boolean, seconds: number, identity = false) {
  const engine = new SimulationEngine(loadScenario(scenario));
  const sensor = new VirtualCameraSensor({ config: engine.config });
  const runtime = new ClosedLoopRuntime({
    engine,
    sensor,
    sampler: new ExactWorldSampler(engine),
    plugin: robust ? astraLockXPat : baselineKfPidPat,
    config: robust ? astraConfig(scenario, identity) : DEFAULT_BASELINE_PAT_CONFIG,
  });

  // Warm the JIT and get past acquisition, so the measurement covers the
  // tracking path rather than only the scan.
  const tickRate = engine.config.tickRate;
  for (let tick = 0; tick < 20 * tickRate; tick += 1) runtime.step(1);

  const samples: number[] = [];
  for (let tick = 0; tick < seconds * tickRate; tick += 1) {
    const started = performance.now();
    const processed = runtime.step(1);
    const elapsed = performance.now() - started;
    if (processed > 0) samples.push(elapsed);
  }
  return summarise(samples);
}

describe('the whole loop', () => {
  it('fits inside the camera frame period with room to spare', () => {
    const robust = measureLoop('astralock-maneuver', true, 20);
    const baseline = measureLoop('astralock-maneuver', false, 20);

    // eslint-disable-next-line no-console -- the measured figures are the point
    console.log(
      `per processed frame at 640x480, ${FRAME_BUDGET_MS.toFixed(2)} ms budget:\n` +
        `  baseline    mean ${baseline.mean.toFixed(3)} ms  median ${baseline.median.toFixed(3)}  p95 ${baseline.p95.toFixed(3)}  max ${baseline.max.toFixed(3)}\n` +
        `  astralock-x mean ${robust.mean.toFixed(3)} ms  median ${robust.median.toFixed(3)}  p95 ${robust.p95.toFixed(3)}  max ${robust.max.toFixed(3)}`,
    );

    expect(robust.mean).toBeLessThan(FRAME_BUDGET_MS / 2);
    expect(robust.p95).toBeLessThan(FRAME_BUDGET_MS);
  });

  it('costs little more than the baseline, because both share the detector', () => {
    const robust = measureLoop('astralock-moving', true, 15);
    const baseline = measureLoop('astralock-moving', false, 15);

    // eslint-disable-next-line no-console -- the measured ratio is the point
    console.log(`  robust / baseline per-frame cost: ${(robust.mean / baseline.mean).toFixed(2)}x`);

    // Generous: the point is to catch the estimator becoming the dominant cost,
    // not to benchmark a shared machine.
    expect(robust.mean).toBeLessThan(baseline.mean * 3 + 1);
  });
});

describe('the estimator on its own', () => {
  it('is negligible next to image formation and detection', () => {
    // Six-state, two models, a mixing step and a covariance fusion — all of it
    // small dense arithmetic. Worth measuring before anyone optimises the wrong
    // thing.
    const imm = new ImmEstimator(DEFAULT_ASTRALOCK_CONFIG.imm);
    imm.initialise(0.1, 0.05, 0);

    const cycles = 20_000;
    const dt = 1 / 60;
    for (let i = 0; i < 2000; i += 1) {
      const prediction = imm.predict(i * dt);
      imm.applyMeasurement(prediction, 0.1 + i * 1e-5, 0.05);
    }

    const started = performance.now();
    for (let i = 0; i < cycles; i += 1) {
      const prediction = imm.predict((2000 + i) * dt);
      imm.applyMeasurement(prediction, 0.1 + i * 1e-5, 0.05);
    }
    const perCycleMs = (performance.now() - started) / cycles;

    // eslint-disable-next-line no-console -- the measured figure is the point
    console.log(`  IMM predict + update: ${(perCycleMs * 1000).toFixed(1)} µs per cycle`);
    expect(perCycleMs).toBeLessThan(FRAME_BUDGET_MS / 10);
  });
});

describe('a long autonomous run', () => {
  it('keeps memory bounded', () => {
    // Nothing per-frame may accumulate: not candidate history, not covariance
    // matrices, not recovery episodes. The sensor pool is the canary — a leaked
    // frame lease exhausts it within three frames.
    const engine = new SimulationEngine(loadScenario('astralock-moving'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const runtime = new ClosedLoopRuntime({
      engine,
      sensor,
      sampler: new ExactWorldSampler(engine),
      plugin: astraLockXPat,
      config: DEFAULT_ASTRALOCK_CONFIG,
      historyLimit: 64,
    });

    for (let tick = 0; tick < 110 * engine.config.tickRate; tick += 1) runtime.step(1);

    expect(runtime.framesProcessed).toBeGreaterThan(5000);
    expect(sensor.buffersAllocated).toBeLessThanOrEqual(3);
    expect(runtime.loopEvents.length).toBeLessThanOrEqual(64);
    expect(runtime.issuedCommands.length).toBeLessThanOrEqual(64);
    expect(engine.gimbal.pendingCommands.length).toBeLessThan(10);
  });

  it('keeps producing finite state the whole way', () => {
    const engine = new SimulationEngine(loadScenario('astralock-short-loss'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const runtime = new ClosedLoopRuntime({
      engine,
      sensor,
      sampler: new ExactWorldSampler(engine),
      plugin: astraLockXPat,
      config: DEFAULT_ASTRALOCK_CONFIG,
    });

    for (let tick = 0; tick < 65 * engine.config.tickRate; tick += 1) runtime.step(1);

    const debug = runtime.algorithmOutput!.debug as Record<string, unknown>;
    for (const [key, value] of Object.entries(debug)) {
      if (typeof value === 'number') {
        expect(Number.isFinite(value), `${key} should stay finite`).toBe(true);
      }
    }
    expect(Number.isFinite(engine.gimbal.measuredPointing().panAngle)).toBe(true);
  });
});

describe('what the correlator costs', () => {
  it('is a small addition to a loop the detector already dominates', () => {
    // The correlator searches phase for every watched candidate on every frame,
    // which is the only part of this design with a plausible route to being
    // expensive. Measured against the same scenario with identity switched off,
    // so the difference is the correlator and nothing else.
    const off = measureLoop('code-decoy-hard', true, 15, false);
    const on = measureLoop('code-decoy-hard', true, 15, true);

    // eslint-disable-next-line no-console -- the measured figures are the point
    console.log(
      `beacon identity, ${FRAME_BUDGET_MS.toFixed(2)} ms budget:\n` +
        `  identity off mean ${off.mean.toFixed(3)} ms  median ${off.median.toFixed(3)}  p95 ${off.p95.toFixed(3)}  max ${off.max.toFixed(3)}\n` +
        `  identity on  mean ${on.mean.toFixed(3)} ms  median ${on.median.toFixed(3)}  p95 ${on.p95.toFixed(3)}  max ${on.max.toFixed(3)}`,
    );

    expect(on.mean).toBeLessThan(FRAME_BUDGET_MS / 2);
    expect(on.p95).toBeLessThan(FRAME_BUDGET_MS);
  });

  it('does not grow with the length of the run', () => {
    // The guard against an accidentally unbounded history: cost per frame after
    // sixty seconds of watching must look like cost per frame after ten. A
    // history that grew with the run would show here as a rising mean long
    // before it showed as memory.
    const engine = new SimulationEngine(loadScenario('code-clean'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const runtime = new ClosedLoopRuntime({
      engine,
      sensor,
      sampler: new ExactWorldSampler(engine),
      plugin: astraLockXPat,
      config: astraConfig('code-clean', true),
    });

    const tickRate = engine.config.tickRate;
    const window = (seconds: number) => {
      const samples: number[] = [];
      for (let tick = 0; tick < seconds * tickRate; tick += 1) {
        const started = performance.now();
        const processed = runtime.step(1);
        const elapsed = performance.now() - started;
        if (processed > 0) samples.push(elapsed);
      }
      return summarise(samples);
    };

    for (let tick = 0; tick < 25 * tickRate; tick += 1) runtime.step(1);
    const early = window(10);
    for (let tick = 0; tick < 30 * tickRate; tick += 1) runtime.step(1);
    const late = window(10);

    // eslint-disable-next-line no-console -- the measured figures are the point
    console.log(
      `identity cost over a long run: early median ${early.median.toFixed(3)} ms, ` +
        `late median ${late.median.toFixed(3)} ms`,
    );

    // Generous, because this is a wall-clock measurement on a shared machine.
    // Anything unbounded shows up as a multiple, not as a percentage.
    expect(late.median).toBeLessThan(early.median * 3 + 0.5);
  });
});
