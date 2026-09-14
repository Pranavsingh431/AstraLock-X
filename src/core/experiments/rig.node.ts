/**
 * A headless closed loop with an optional recorder, for the experiment tests.
 *
 * Node-only and test-only. Built the same way whether or not a recorder is
 * attached, so that "recorder on" and "recorder off" differ in exactly one
 * respect.
 */

import { DEFAULT_BASELINE_PAT_CONFIG, baselineKfPidPat } from '@/core/algorithms';
import type { BaselinePatConfig } from '@/core/algorithms/baseline/config';
import type { SimulationConfig } from '@/core/contracts/simulation';
import type { LoopObserver } from '@/core/runtime/closed-loop';
import { ClosedLoopRuntime } from '@/core/runtime/closed-loop';
import { SimulationEngine } from '@/core/simulation/engine';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';
import { loadScenario, type ScenarioId } from '@/scenarios';

import { ExperimentRecorder } from './recorder';
import type { RecorderOptions } from './recorder';
import type { MetricsConfig } from './schema';
import type { ExperimentStorage } from './storage';

export interface Rig {
  readonly engine: SimulationEngine;
  readonly sensor: VirtualCameraSensor;
  readonly runtime: ClosedLoopRuntime;
  readonly recorder: ExperimentRecorder | null;
}

export interface RigOptions {
  readonly scenario: ScenarioId | SimulationConfig;
  readonly algorithmConfig?: BaselinePatConfig;
  readonly storage?: ExperimentStorage | null;
  readonly runId?: string;
  readonly metricsConfig?: MetricsConfig;
  readonly backpressureBytes?: number;
  /** Wraps the recorder, for tests that watch alongside it. */
  readonly observe?: (recorder: ExperimentRecorder | null) => LoopObserver | null;
}

export function buildRig(options: RigOptions): Rig {
  const config =
    typeof options.scenario === 'string' ? loadScenario(options.scenario) : options.scenario;
  const algorithmConfig = options.algorithmConfig ?? DEFAULT_BASELINE_PAT_CONFIG;
  const engine = new SimulationEngine(config);
  const sensor = new VirtualCameraSensor({ config: engine.config });

  const recorderOptions: RecorderOptions | null =
    options.storage === undefined || options.storage === null
      ? null
      : {
          storage: options.storage,
          engine,
          config: engine.config,
          scenarioId: config.id,
          algorithmId: baselineKfPidPat.manifest.id,
          algorithmVersion: baselineKfPidPat.manifest.version,
          algorithmConfig,
          metricsConfig: options.metricsConfig,
          applicationVersion: '0.0.0-test',
          sourceCommit: null,
          platform: 'test',
          runId: options.runId,
          backpressureBytes: options.backpressureBytes,
          now: () => new Date('2026-01-01T00:00:00.000Z'),
        };
  const recorder = recorderOptions === null ? null : new ExperimentRecorder(recorderOptions);
  const observer = options.observe === undefined ? recorder : options.observe(recorder);

  const runtime = new ClosedLoopRuntime({
    engine,
    sensor,
    sampler: new ExactWorldSampler(engine),
    plugin: baselineKfPidPat,
    config: algorithmConfig,
    // Unbounded, so a comparison sees every command rather than the last 256.
    historyLimit: Number.MAX_SAFE_INTEGER,
    ...(observer === null ? {} : { observer }),
  });

  return { engine, sensor, runtime, recorder };
}

/** What an engineering comparison compares. Host timings are not in it. */
export interface EngineeringTrace {
  /** Each PAT mode change, as `mode@processedAt` from the runtime's own history. */
  readonly modes: readonly string[];
  readonly commands: readonly string[];
  readonly finalMeasuredPan: number;
  readonly finalMeasuredTilt: number;
  readonly stateHash: string;
  readonly framesProcessed: number;
}

/** Steps a rig tick by tick and returns the engineering trace of the whole run so far. */
export function drive(rig: Rig, seconds: number): EngineeringTrace {
  const ticks = Math.round(seconds * rig.engine.config.tickRate);
  for (let tick = 0; tick < ticks; tick += 1) rig.runtime.step(1);
  return trace(rig);
}

/**
 * Steps a rig while honouring recorder backpressure, as the application does:
 * when the write queue is over its mark, simulation stops advancing until the
 * queue drains. Wall-clock time passes; simulated time does not.
 *
 * @returns the trace, and the largest queue in bytes observed after any step.
 */
export async function driveRespectingBackpressure(
  rig: Rig,
  seconds: number,
  ticksPerStep = 10,
): Promise<{ trace: EngineeringTrace; maxPendingBytes: number }> {
  const ticks = Math.round(seconds * rig.engine.config.tickRate);
  let maxPendingBytes = 0;
  for (let tick = 0; tick < ticks; tick += ticksPerStep) {
    const recorder = rig.recorder;
    if (recorder?.backpressured === true) await recorder.drain();
    const step = Math.min(ticksPerStep, ticks - tick);
    for (let i = 0; i < step; i += 1) rig.runtime.step(1);
    maxPendingBytes = Math.max(maxPendingBytes, recorder?.status.pendingBytes ?? 0);
    // Let queued writes make progress, as an animation frame would.
    await Promise.resolve();
  }
  return { trace: trace(rig), maxPendingBytes };
}

export function trace(rig: Rig): EngineeringTrace {
  const modes: string[] = [];
  let last = '';
  for (const event of rig.runtime.loopEvents) {
    if (event.mode !== last) {
      modes.push(`${event.mode}@${event.processedAt.toExponential(17)}`);
      last = event.mode;
    }
  }
  const measured = rig.engine.gimbal.measuredPointing();
  return {
    modes,
    commands: rig.runtime.issuedCommands.map(
      (c) =>
        `${String(c.commandId)}@${c.issuedAt.toExponential(17)}:${c.azimuth.toExponential(17)},${c.elevation.toExponential(17)}`,
    ),
    finalMeasuredPan: measured.panAngle,
    finalMeasuredTilt: measured.tiltAngle,
    stateHash: rig.engine.stateHash(),
    framesProcessed: rig.runtime.framesProcessed,
  };
}

/** When a mode was first entered, in simulated seconds, or `null`. */
export function firstModeTime(trace: EngineeringTrace, mode: string): number | null {
  const entry = trace.modes.find((m) => m.startsWith(`${mode}@`));
  return entry === undefined ? null : Number(entry.split('@')[1]);
}
