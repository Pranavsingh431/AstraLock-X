// @vitest-environment node
/**
 * The mount inside the engine.
 *
 * The mount is not a separate machine bolted onto the simulation: it advances
 * on the engine's clock, resets with it, and is as reproducible as the rest of
 * the world. These cases check that relationship, the scripted-command facility
 * that makes an actuator regression detectable, and what the mechanism costs.
 */

import { describe, expect, it } from 'vitest';

import { loadScenario } from '@/scenarios';
import { SimulationEngine } from '@/core/simulation/engine';

import { GimbalCommandScript, at } from './command-script';

const script = (): GimbalCommandScript =>
  new GimbalCommandScript([
    at(0.05, 0.03, 0.05),
    at(0.4, -0.02, 0.08),
    at(0.4, 0.01, 0.06), // Same instant: written order decides.
    at(1.2, 0, 0.04),
  ]);

// --- Engine integration -----------------------------------------------------

describe('the mount advances on the engine clock', () => {
  it('moves only when the engine steps', () => {
    const engine = new SimulationEngine(loadScenario('gimbal-step-response'));
    engine.gimbal.commandPosition(0.05, 0.05);

    expect(engine.gimbal.time).toBe(0);
    expect(engine.gimbal.truePointing().panAngle).toBe(0);

    engine.step(1);
    expect(engine.gimbal.time).toBeCloseTo(1 / engine.config.tickRate, 12);
    expect(engine.gimbal.truePointing().panAngle).toBeGreaterThan(0);
  });

  it('keeps the mount clock equal to the engine clock', () => {
    const engine = new SimulationEngine(loadScenario('gimbal-step-response'));
    engine.gimbal.commandPosition(0.05, 0.05);

    for (let index = 0; index < 50; index += 1) {
      engine.step(3);
      expect(engine.gimbal.time).toBeCloseTo(engine.time, 12);
    }
  });

  it('advances tick by tick inside one multi-tick step', () => {
    // Stepping 10 ticks at once must integrate ten times, not once with a ten
    // times larger interval — which would be a different, and much worse,
    // approximation.
    const stepped = new SimulationEngine(loadScenario('gimbal-step-response'));
    const bulk = new SimulationEngine(loadScenario('gimbal-step-response'));
    stepped.gimbal.commandPosition(0.05, 0.05);
    bulk.gimbal.commandPosition(0.05, 0.05);

    for (let index = 0; index < 10; index += 1) stepped.step(1);
    bulk.step(10);

    expect(bulk.gimbal.truePointing()).toEqual(stepped.gimbal.truePointing());
  });

  it('puts the mount pose into the world sample the sensor reads', () => {
    const engine = new SimulationEngine(loadScenario('gimbal-step-response'));
    engine.gimbal.commandPosition(0.05, 0.06);
    engine.step(40);

    const pose = engine.gimbalPoseAt(engine.time);
    expect(pose.azimuth).toBe(engine.gimbal.truePointing().panAngle);
    expect(pose.elevation).toBe(engine.gimbal.truePointing().tiltAngle);
  });

  it('starts pointing where the mount configuration says, and nowhere else', () => {
    // Schema v4 removed the duplicate camera pointing fields. One source.
    const engine = new SimulationEngine(loadScenario('gimbal-step-response'));
    expect(engine.gimbal.truePointing().panAngle).toBe(engine.config.gimbal.pan.initialAngle);
    expect(engine.gimbal.truePointing().tiltAngle).toBe(engine.config.gimbal.tilt.initialAngle);
  });
});

describe('reset', () => {
  it('returns the mount along with the world', () => {
    const engine = new SimulationEngine(loadScenario('gimbal-latency'));
    engine.gimbal.commandPosition(0.06, 0.09);
    engine.step(300);
    engine.gimbal.commandPosition(-0.06, 0.02);

    engine.reset();

    expect(engine.tick).toBe(0);
    expect(engine.gimbal.time).toBe(0);
    expect(engine.gimbal.truePointing().panAngle).toBe(engine.config.gimbal.pan.initialAngle);
    expect(engine.gimbal.pendingCommands).toHaveLength(0);
    expect(engine.gimbal.lastApplied).toBeNull();
  });

  it('makes the run afterwards identical to the first', () => {
    const engine = new SimulationEngine(loadScenario('gimbal-latency'));
    const commands = script();

    const run = (): string => {
      let digest = '';
      for (let index = 0; index < 400; index += 1) {
        engine.step(1);
        commands.issueDue(engine.gimbal, engine.time);
        const pointing = engine.gimbal.truePointing();
        digest += `${pointing.panAngle.toExponential(17)},${pointing.tiltAngle.toExponential(17)};`;
      }
      return digest;
    };

    const first = run();
    engine.reset();
    commands.reset();
    expect(run()).toBe(first);
  });

  it('does not let mount activity disturb the world', () => {
    // The mount points the camera; it does not move the target. The state hash
    // legitimately covers the mount pose — it is part of the truth — so the
    // comparison is of the target trajectories, which must be untouched.
    const quiet = new SimulationEngine(loadScenario('gimbal-step-response'));
    const commanded = new SimulationEngine(loadScenario('gimbal-step-response'));

    quiet.step(200);
    commanded.gimbal.commandPosition(0.05, 0.09);
    commanded.step(200);

    const positionsOf = (engine: SimulationEngine): readonly unknown[] =>
      engine.snapshot().truth.targets.map((target) => target.pose.position);

    expect(positionsOf(commanded)).toEqual(positionsOf(quiet));
    // And the mount really did move, so the comparison is not vacuous.
    expect(commanded.gimbal.truePointing().panAngle).not.toBe(quiet.gimbal.truePointing().panAngle);
  });
});

describe('pause and resume', () => {
  it('is indistinguishable from an uninterrupted run', () => {
    const straight = new SimulationEngine(loadScenario('gimbal-latency'));
    const halted = new SimulationEngine(loadScenario('gimbal-latency'));

    straight.gimbal.commandPosition(0.05, 0.07);
    halted.gimbal.commandPosition(0.05, 0.07);

    straight.step(300);

    halted.step(120);
    // The pause: no steps at all for a while, then carry on.
    halted.step(180);

    expect(halted.gimbal.truePointing()).toEqual(straight.gimbal.truePointing());
    expect(halted.gimbal.measuredPointing()).toEqual(straight.gimbal.measuredPointing());
  });

  it('holds a queued command across the pause without ageing it', () => {
    // The delay is in simulated time. A command issued just before a pause must
    // still have its full remaining delay when the run resumes, not have it
    // consumed by wall-clock time spent paused.
    const engine = new SimulationEngine(loadScenario('gimbal-latency'));
    const latency = engine.config.gimbal.commandLatency;

    engine.step(2);
    const issuedAt = engine.time;
    engine.gimbal.commandPosition(0.05, 0.07);

    // Time does not advance while paused, however long that lasts.
    expect(engine.gimbal.pendingCommands).toHaveLength(1);
    expect(engine.gimbal.pendingCommands[0]?.dueAt).toBeCloseTo(issuedAt + latency, 12);

    engine.step(1);
    expect(engine.gimbal.pendingCommands).toHaveLength(1);
  });
});

// --- Scripted commands ------------------------------------------------------

describe('a deterministic command script', () => {
  it('issues each entry once, when its time arrives', () => {
    const engine = new SimulationEngine(loadScenario('gimbal-step-response'));
    const commands = script();
    expect(commands.length).toBe(4);

    engine.step(1);
    commands.issueDue(engine.gimbal, engine.time);
    expect(commands.issued).toBe(0);

    engine.step(20); // Past 0.05 s.
    commands.issueDue(engine.gimbal, engine.time);
    expect(commands.issued).toBe(1);

    engine.step(400);
    commands.issueDue(engine.gimbal, engine.time);
    expect(commands.isComplete).toBe(true);
  });

  it('keeps written order for entries at the same instant', () => {
    const engine = new SimulationEngine(loadScenario('gimbal-step-response'));
    const commands = script();

    engine.step(100); // Past 0.4 s, so both same-instant entries are due.
    commands.issueDue(engine.gimbal, engine.time);
    engine.step(1);

    // The second of the pair wins, because it was issued last.
    expect(engine.gimbal.truth().pan.setpoint).toBeCloseTo(0.01, 12);
  });

  it('sorts out-of-order entries by time', () => {
    const shuffled = new GimbalCommandScript([at(1, 0.2, 0), at(0.1, 0.05, 0), at(0.5, 0.1, 0)]);
    const engine = new SimulationEngine(loadScenario('gimbal-step-response'));

    engine.step(30); // 0.15 s.
    shuffled.issueDue(engine.gimbal, engine.time);
    engine.step(1);

    expect(engine.gimbal.truth().pan.setpoint).toBeCloseTo(0.05, 12);
  });

  it('rewinds', () => {
    const commands = script();
    const engine = new SimulationEngine(loadScenario('gimbal-step-response'));
    engine.step(400);
    commands.issueDue(engine.gimbal, engine.time);
    expect(commands.issued).toBeGreaterThan(0);

    commands.reset();
    expect(commands.issued).toBe(0);
    expect(commands.isComplete).toBe(false);
  });

  it('refuses a negative time', () => {
    expect(() => new GimbalCommandScript([at(-1, 0, 0)])).toThrow(RangeError);
  });

  it('gives identical pixels for identical scripts', () => {
    const digest = (): string => {
      const engine = new SimulationEngine(loadScenario('gimbal-latency'));
      const commands = script();
      let out = '';
      for (let index = 0; index < 500; index += 1) {
        engine.step(1);
        commands.issueDue(engine.gimbal, engine.time);
        out += engine.gimbal.measuredPointing().panAngle.toExponential(17);
      }
      return out;
    };
    expect(digest()).toBe(digest());
  });
});

// --- Cost -------------------------------------------------------------------

describe('what the mount costs', () => {
  it('adds a negligible fraction of the tick budget', () => {
    // A tick at 200 Hz is 5 ms. The mount is two second-order integrations, a
    // queue check and two roundings; if it were anywhere near the budget the
    // model would be wrong rather than slow.
    const engine = new SimulationEngine(loadScenario('gimbal-latency'));
    const commands = script();
    const ticks = 20_000;

    // Warm the JIT so the measurement is of steady-state code.
    for (let index = 0; index < 2000; index += 1) engine.step(1);
    engine.reset();
    commands.reset();

    const started = performance.now();
    for (let index = 0; index < ticks; index += 1) {
      engine.step(1);
      commands.issueDue(engine.gimbal, engine.time);
    }
    const perTickMs = (performance.now() - started) / ticks;

    // Generous by design: this is a regression guard against something
    // accidentally quadratic, not a benchmark. The measured figure is quoted in
    // the phase report.
    expect(perTickMs).toBeLessThan(0.2);
  });

  it('keeps the pointing history bounded over a long run', () => {
    // The between-tick history is a ring. If it were a growing array, a long
    // run would leak, and the interpolation search would slow down with it.
    const engine = new SimulationEngine(loadScenario('gimbal-step-response'));

    const timeFirstThousand = (): number => {
      const started = performance.now();
      for (let index = 0; index < 1000; index += 1) engine.step(1);
      return performance.now() - started;
    };

    const early = timeFirstThousand();
    for (let index = 0; index < 40_000; index += 1) engine.step(1);
    const late = timeFirstThousand();

    // Within an order of magnitude of the early figure: a growing history would
    // show up as steady degradation rather than noise.
    expect(late).toBeLessThan(Math.max(early, 1) * 10);

    // And the interpolation still answers correctly at the far end.
    const pointing = engine.gimbal.truePointingAt(engine.time);
    expect(Number.isFinite(pointing.panAngle)).toBe(true);
  });
});
