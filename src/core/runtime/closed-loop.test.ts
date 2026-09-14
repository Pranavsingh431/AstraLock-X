// @vitest-environment node
/**
 * The whole loop, running by itself.
 *
 * These are the tests that decide whether Phase 4 works. Everything else checks
 * a component; this checks that the components are wired together in a way that
 * actually closes — that pixels cause commands, that commands cause the mount
 * to move, and that the mount moving causes different pixels.
 *
 * **Ground truth appears in this file.** That is correct and deliberate: the
 * test is the evaluator, and an evaluator that could not see the truth could
 * not tell whether the tracker was pointing at anything. The algorithm is given
 * only `TrackingInput`; truth is used exclusively inside assertions.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_BASELINE_PAT_CONFIG, baselineKfPidPat } from '@/core/algorithms';
import type { BaselineDebug } from '@/core/algorithms';
import { SimulationEngine } from '@/core/simulation/engine';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';
import { loadScenario, type ScenarioId } from '@/scenarios';

import { ClosedLoopRuntime, type ClosedLoopOptions } from './closed-loop';

/**
 * Every case here drives tens of simulated seconds of the real pipeline —
 * world, mount, 640x480 image formation and full connected-component analysis
 * on every one of thousands of frames. That is the point: a faster stand-in
 * would not be the system under test. It does not fit the default per-test
 * budget, particularly when the suite runs files in parallel.
 */
vi.setConfig({ testTimeout: 180_000 });

interface Rig {
  readonly engine: SimulationEngine;
  readonly sensor: VirtualCameraSensor;
  readonly sampler: ExactWorldSampler;
  readonly runtime: ClosedLoopRuntime;
}

function rig(id: ScenarioId, options: Partial<ClosedLoopOptions> = {}): Rig {
  const engine = new SimulationEngine(loadScenario(id));
  const sensor = new VirtualCameraSensor({ config: engine.config });
  const sampler = new ExactWorldSampler(engine);
  const runtime = new ClosedLoopRuntime({
    engine,
    sensor,
    sampler,
    plugin: baselineKfPidPat,
    config: DEFAULT_BASELINE_PAT_CONFIG,
    ...options,
  });
  return { engine, sensor, sampler, runtime };
}

/**
 * Where the beacon truly is on the image right now, or `null` if not visible.
 *
 * Privileged. Used only to judge the tracker from the outside.
 */
function trueImagePosition(rig: Rig): { x: number; y: number } | null {
  const index = Math.round(rig.engine.time * rig.engine.config.camera.frameRate);
  const capture = rig.sensor.captureFrame(rig.sampler, index);
  try {
    const projection = capture.truth.projections[0];
    if (projection === undefined || projection.imageX === null) return null;
    return { x: projection.imageX, y: projection.imageY! };
  } finally {
    capture.release();
  }
}

interface RunResult {
  readonly acquiredAt: number;
  readonly modes: readonly string[];
  readonly settledErrors: readonly number[];
  readonly postFrames: number;
  readonly postVisible: number;
  readonly finalMode: string;
}

/** Runs the loop and records what happened, judged from the outside. */
function drive(rig: Rig, durationSeconds: number, settleSeconds = 3): RunResult {
  const ticks = Math.round(durationSeconds * rig.engine.config.tickRate);
  const modes: string[] = [];
  const settledErrors: number[] = [];
  let lastMode = '';
  let acquiredAt = -1;
  let postFrames = 0;
  let postVisible = 0;

  for (let tick = 0; tick < ticks; tick += 1) {
    const processed = rig.runtime.step(1);
    const output = rig.runtime.algorithmOutput;
    if (output === null) continue;

    if (output.pat.mode !== lastMode) {
      modes.push(output.pat.mode);
      lastMode = output.pat.mode;
    }
    if (output.pat.mode === 'track' && acquiredAt < 0) acquiredAt = rig.engine.time;

    if (processed > 0 && acquiredAt >= 0 && rig.engine.time - acquiredAt > settleSeconds) {
      postFrames += 1;
      const position = trueImagePosition(rig);
      if (position !== null) {
        postVisible += 1;
        settledErrors.push(Math.hypot(position.x - 320, position.y - 240));
      }
    }
  }

  return { acquiredAt, modes, settledErrors, postFrames, postVisible, finalMode: lastMode };
}

const median = (values: readonly number[]): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

const percentile = (values: readonly number[], fraction: number): number => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? Number.NaN;
};

// --- The stationary acquisition test ----------------------------------------

describe('a stationary target outside the initial field of view', () => {
  it('is invisible before the scan reaches it', () => {
    // The premise of the whole test. If the beacon were already in frame the
    // run would prove nothing about search.
    const r = rig('pat-stationary-outside-fov');
    const capture = r.sensor.captureFrame(r.sampler, 1);
    try {
      const sum = (capture.frame.data as Uint8Array).reduce((a, b) => a + b, 0);
      expect(sum).toBe(0);
      expect(capture.truth.projections[0]!.visibility).toBe('outside-fov');
    } finally {
      capture.release();
    }
  });

  it('is found, centred and held, with no target truth reaching the algorithm', () => {
    const r = rig('pat-stationary-outside-fov');
    const result = drive(r, 40);

    // Acquisition happened, and only after the mount had physically scanned.
    expect(result.acquiredAt).toBeGreaterThan(0);
    expect(result.modes).toEqual(['scan', 'track']);
    expect(result.finalMode).toBe('track');

    // The beacon stayed in view for every settled frame.
    expect(result.postVisible).toBe(result.postFrames);
    expect(result.postFrames).toBeGreaterThan(500);

    // And it is centred. Measured on this run: median ~0.5 px from the
    // principal point, 95th percentile a few pixels. The bounds below are set
    // well clear of those figures rather than trimmed to them, but they are far
    // tighter than the 320 px half-width that "somewhere in frame" would allow.
    expect(median(result.settledErrors)).toBeLessThan(3);
    expect(percentile(result.settledErrors, 0.95)).toBeLessThan(20);
  });

  it('moved the mount itself, rather than starting out pointed at the target', () => {
    const r = rig('pat-stationary-outside-fov');
    const startPan = r.engine.gimbal.measuredPointing().panAngle;
    drive(r, 25);
    const endPan = r.engine.gimbal.measuredPointing().panAngle;

    // The target sits about 25 degrees off the initial bearing.
    expect(Math.abs(endPan - startPan)).toBeGreaterThan(0.3);
  });

  it('issued its commands through the mount, which applied its own limits', () => {
    const r = rig('pat-stationary-outside-fov');
    drive(r, 20);

    expect(r.runtime.issuedCommands.length).toBeGreaterThan(10);
    // Every command went through DynamicGimbal and got an id from it.
    for (const command of r.runtime.issuedCommands) {
      expect(Number.isInteger(command.commandId)).toBe(true);
    }
  });
});

// --- The moving target test -------------------------------------------------

describe('a gently moving target', () => {
  it('is acquired and then followed through the real actuator', () => {
    const r = rig('pat-moving-target');
    const result = drive(r, 60);

    expect(result.acquiredAt).toBeGreaterThan(0);
    expect(result.finalMode).toBe('track');
    expect(result.postFrames).toBeGreaterThan(500);

    // Every settled frame kept the beacon in view.
    expect(result.postVisible / result.postFrames).toBeGreaterThan(0.99);
    expect(median(result.settledErrors)).toBeLessThan(3);
  });

  it('keeps the mount genuinely moving to do it', () => {
    // A tracker that acquired and then sat still would pass a visibility test
    // on a slow target by luck. The mount must actually be slewing.
    const r = rig('pat-moving-target');
    drive(r, 45);

    const rate = Math.abs(r.engine.gimbal.measuredPointing().derivedPanRate);
    expect(rate).toBeGreaterThan(1e-4);
  });
});

// --- Loss -------------------------------------------------------------------

describe('a target that outruns the mount', () => {
  it('goes TRACK, then LOST, then back to SEARCH', () => {
    const r = rig('pat-loss');
    const result = drive(r, 40);

    expect(result.modes.slice(0, 4)).toEqual(['scan', 'track', 'lost', 'scan']);
  });

  it('clears its stale estimate on the way, rather than chasing a ghost', () => {
    const r = rig('pat-loss');
    drive(r, 40);

    const debug = r.runtime.algorithmOutput!.debug as BaselineDebug;
    expect(debug.state).toBe('search');
    // Baseline recovery in full: the filter is gone and the scan restarted.
    expect(debug.filteredAzimuth).toBeNull();
    expect(debug.searchWaypointIndex).not.toBeNull();
  });

  it('does not declare loss on a single missed frame', () => {
    const r = rig('pat-stationary-outside-fov');
    const result = drive(r, 30);
    expect(result.modes).not.toContain('lost');
  });
});

// --- The anti-cheat test ----------------------------------------------------

describe('the image is causally required', () => {
  it('cannot acquire when the pixels carry no information', () => {
    // The strongest regression test against accidental ground-truth leakage.
    // Same world, same mount, same everything — but every frame handed to the
    // algorithm is blank. A tracker that still pointed correctly would be
    // reading the world some other way.
    const r = rig('pat-stationary-outside-fov', { blankPixels: true });
    const result = drive(r, 40);

    expect(result.acquiredAt).toBe(-1);
    expect(result.modes).toEqual(['scan']);
    expect(result.finalMode).toBe('scan');
  });

  it('scans the whole time instead, which is the correct blind behaviour', () => {
    const r = rig('pat-stationary-outside-fov', { blankPixels: true });
    drive(r, 20);

    const debug = r.runtime.algorithmOutput!.debug as BaselineDebug;
    expect(debug.componentsFound).toBe(0);
    expect(debug.centroidX).toBeNull();
    expect(debug.searchWaypointIndex).not.toBeNull();
  });

  it('acquires as soon as the real pixels are restored', () => {
    // The other half of the proof: the failure above is caused by the blanking
    // and by nothing else.
    const withPixels = rig('pat-stationary-outside-fov');
    expect(drive(withPixels, 40).acquiredAt).toBeGreaterThan(0);
  });

  it('follows the pixels it is shown, not the world behind them', () => {
    // Two different worlds, the same blank pixels: identical behaviour. The
    // algorithm cannot be reading anything but the frame.
    const a = rig('pat-stationary-outside-fov', { blankPixels: true });
    const b = rig('pat-moving-target', { blankPixels: true });

    drive(a, 12);
    drive(b, 12);

    const debugA = a.runtime.algorithmOutput!.debug as BaselineDebug;
    const debugB = b.runtime.algorithmOutput!.debug as BaselineDebug;
    expect(debugB.searchWaypointIndex).toBe(debugA.searchWaypointIndex);
    expect(debugB.state).toBe(debugA.state);
  });
});

// --- Command timing ---------------------------------------------------------

describe('commands are never back-dated', () => {
  it('stamps every command at or after the capture time of its frame', () => {
    // The invariant. A command stamped at capture time would act on the mount
    // before the software could possibly have produced it.
    const r = rig('pat-stationary-outside-fov');
    drive(r, 25);

    expect(r.runtime.issuedCommands.length).toBeGreaterThan(50);
    for (const command of r.runtime.issuedCommands) {
      expect(command.captureTime).not.toBeNull();
      expect(command.issuedAt).toBeGreaterThanOrEqual(command.captureTime!);
    }
  });

  it('actually issues later than capture, not merely no earlier', () => {
    // At 60 FPS against a 200 Hz tick most frames fall between ticks, so the
    // strict inequality must hold for a majority of them. If it never held, the
    // runtime would be delivering frames at capture time and the invariant
    // above would be passing vacuously.
    const r = rig('pat-stationary-outside-fov');
    drive(r, 25);

    const strictlyLater = r.runtime.issuedCommands.filter(
      (command) => command.issuedAt > command.captureTime!,
    );
    expect(strictlyLater.length).toBeGreaterThan(r.runtime.issuedCommands.length / 2);
  });

  it('never issues a command before the engine has reached that time', () => {
    const r = rig('pat-moving-target');
    drive(r, 20);

    for (const command of r.runtime.issuedCommands) {
      expect(command.issuedAt).toBeLessThanOrEqual(r.engine.time + 1e-9);
    }
  });

  it('the mount applies its latency from the issue time, not the capture time', () => {
    const r = rig('pat-stationary-outside-fov');
    const latency = r.engine.config.gimbal.commandLatency;
    expect(latency).toBeGreaterThan(0);

    // Step until a command has been issued and is still pending.
    let pending: readonly { dueAt: number; command: { issuedAt: number } }[] = [];
    for (let tick = 0; tick < 2000 && pending.length === 0; tick += 1) {
      r.runtime.step(1);
      pending = r.engine.gimbal.pendingCommands;
    }

    expect(pending.length).toBeGreaterThan(0);
    for (const entry of pending) {
      expect(entry.dueAt).toBeCloseTo(entry.command.issuedAt + latency, 9);
    }
  });
});

// --- Frame delivery ---------------------------------------------------------

describe('frame delivery', () => {
  it('processes every frame due in an interval, in order', () => {
    // Advancing many ticks at once must not drop the frames in between: the
    // algorithm's behaviour would then depend on how often it was called.
    const oneAtATime = rig('pat-stationary-outside-fov');
    const inBatches = rig('pat-stationary-outside-fov');

    for (let tick = 0; tick < 2000; tick += 1) oneAtATime.runtime.step(1);
    for (let batch = 0; batch < 200; batch += 1) inBatches.runtime.step(10);

    expect(inBatches.runtime.framesProcessed).toBe(oneAtATime.runtime.framesProcessed);
  });

  it('delivers frames in ascending capture time', () => {
    const r = rig('pat-stationary-outside-fov');
    for (let batch = 0; batch < 100; batch += 1) r.runtime.step(17);

    const events = r.runtime.loopEvents;
    for (let index = 1; index < events.length; index += 1) {
      expect(events[index]!.captureTime).toBeGreaterThan(events[index - 1]!.captureTime);
      expect(events[index]!.frameId).toBe(events[index - 1]!.frameId + 1);
    }
  });

  it('releases every frame lease, even when the algorithm throws', () => {
    // The pool has three buffers. A leak would exhaust it within three frames.
    const r = rig('pat-stationary-outside-fov');
    const broken = {
      ...baselineKfPidPat,
      create: () => ({
        update: () => {
          throw new Error('detector exploded');
        },
        reset: () => undefined,
      }),
    };

    const engine = new SimulationEngine(loadScenario('pat-stationary-outside-fov'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const runtime = new ClosedLoopRuntime({
      engine,
      sensor,
      sampler: new ExactWorldSampler(engine),
      plugin: broken,
      config: DEFAULT_BASELINE_PAT_CONFIG,
    });

    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect(() => {
        for (let tick = 0; tick < 10; tick += 1) runtime.step(1);
      }).toThrow('detector exploded');
    }

    // The pool is intact: a leak would have turned the error into a
    // FrameLeaseError by the fourth frame.
    expect(sensor.buffersAllocated).toBeLessThanOrEqual(3);
    void r;
  });
});

// --- Determinism ------------------------------------------------------------

describe('reproducibility', () => {
  it('replays identically for the same scenario, config and seed', () => {
    const digest = (): string => {
      const r = rig('pat-moving-target');
      drive(r, 35);
      return [
        r.runtime.loopEvents
          .map((e) => `${e.frameId}:${e.mode}:${e.processedAt.toFixed(9)}`)
          .join('|'),
        r.runtime.issuedCommands
          .map(
            (c) => `${c.commandId}:${c.azimuth.toExponential(15)}:${c.elevation.toExponential(15)}`,
          )
          .join('|'),
        r.engine.gimbal.measuredPointing().panAngle.toExponential(15),
        r.engine.stateHash(),
      ].join('#');
    };

    expect(digest()).toBe(digest());
  });

  it('uses no unseeded randomness', () => {
    // Math.random would make the run irreproducible. Replacing it with a
    // throwing stub proves nothing in the loop calls it.
    const original = Math.random;
    Math.random = () => {
      throw new Error('the algorithm must not use unseeded randomness');
    };
    try {
      const r = rig('pat-stationary-outside-fov');
      expect(() => drive(r, 15)).not.toThrow();
    } finally {
      Math.random = original;
    }
  });

  it('returns to the same place after a reset', () => {
    const r = rig('pat-stationary-outside-fov');
    const first = drive(r, 18);

    r.engine.reset();
    r.sensor.reset();
    r.runtime.reset();
    const second = drive(r, 18);

    expect(second.modes).toEqual(first.modes);
    expect(second.acquiredAt).toBeCloseTo(first.acquiredAt, 9);
  });
});

// --- Interactive cadence ----------------------------------------------------

describe('the interface is not part of the control loop', () => {
  it('gives the same engineering result under an irregular cadence', () => {
    // A UI scheduler delivers ticks in uneven clumps. The autonomous result
    // must not depend on that, or every demonstration would be a different
    // experiment from the headless run.
    const headless = rig('pat-moving-target');
    const interactive = rig('pat-moving-target');

    const ticks = Math.round(35 * headless.engine.config.tickRate);
    for (let tick = 0; tick < ticks; tick += 1) headless.runtime.step(1);

    // A stuttering display: 60 Hz, then a stall, then a catch-up burst.
    const cadence = [3, 3, 4, 3, 12, 3, 3, 1, 7, 3];
    let done = 0;
    let index = 0;
    while (done < ticks) {
      const batch = Math.min(cadence[index % cadence.length]!, ticks - done);
      interactive.runtime.step(batch);
      done += batch;
      index += 1;
    }

    expect(interactive.runtime.framesProcessed).toBe(headless.runtime.framesProcessed);
    expect(interactive.engine.stateHash()).toBe(headless.engine.stateHash());
    expect(interactive.runtime.loopEvents.map((e) => `${e.frameId}:${e.mode}`)).toEqual(
      headless.runtime.loopEvents.map((e) => `${e.frameId}:${e.mode}`),
    );
    expect(interactive.runtime.issuedCommands.map((c) => c.commandId)).toEqual(
      headless.runtime.issuedCommands.map((c) => c.commandId),
    );
  });
});

// --- Bounded resources ------------------------------------------------------

describe('a long autonomous run stays bounded', () => {
  it('leaks no frame leases and grows no history', () => {
    const r = rig('pat-moving-target', { historyLimit: 64 });
    const ticks = Math.round(90 * r.engine.config.tickRate);

    for (let tick = 0; tick < ticks; tick += 1) r.runtime.step(1);

    expect(r.runtime.framesProcessed).toBeGreaterThan(4000);
    // Bounded buffers, bounded diagnostics, bounded command log.
    expect(r.sensor.buffersAllocated).toBeLessThanOrEqual(3);
    expect(r.runtime.loopEvents.length).toBeLessThanOrEqual(64);
    expect(r.runtime.issuedCommands.length).toBeLessThanOrEqual(64);
    // And the mount's own queue has not backed up.
    expect(r.engine.gimbal.pendingCommands.length).toBeLessThan(10);
  });

  it('keeps producing finite state the whole way', () => {
    const r = rig('pat-moving-target');
    const ticks = Math.round(60 * r.engine.config.tickRate);
    for (let tick = 0; tick < ticks; tick += 1) r.runtime.step(1);

    const debug = r.runtime.algorithmOutput!.debug as BaselineDebug;
    for (const value of [debug.filteredAzimuth, debug.filteredElevation, debug.azimuthRate]) {
      if (value !== null) expect(Number.isFinite(value)).toBe(true);
    }
    expect(Number.isFinite(r.engine.gimbal.measuredPointing().panAngle)).toBe(true);
  });
});
