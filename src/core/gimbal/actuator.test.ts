// @vitest-environment node
/**
 * The mount, as a mechanism.
 *
 * Every case here has an answer that follows from the model rather than from a
 * previous run: a rate limit means a bound on `|angle(t+h) - angle(t)|/h`, a
 * travel stop means an angle that cannot be exceeded whatever is commanded, and
 * a backlash of B radians means exactly B radians of motor travel with a
 * stationary output after a reversal. Nothing is asserted against a recorded
 * number that nobody can check by hand.
 *
 * The continuous-time comparison lives in numerics.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { gimbalConfigSchema, type GimbalConfig } from '@/core/contracts/gimbal';

import { GimbalAxis, applyBacklash, applyDeadband } from './axis';
import { DynamicGimbal } from './dynamic-gimbal';
import { quantizeAngle } from './encoder';

const TICK = 1 / 200;

/** A profile with no imperfections, for isolating one effect at a time. */
const idealAxis = {
  initialAngle: 0,
  minAngle: -2,
  maxAngle: 2,
  maxRate: 2,
  maxAcceleration: 10,
  naturalFrequency: 8,
  dampingRatio: 0.9,
  deadband: 0,
  backlash: 0,
  encoderResolution: 1e-6,
};

function gimbal(patch: {
  pan?: Partial<typeof idealAxis>;
  tilt?: Partial<typeof idealAxis>;
  commandLatency?: number;
}): DynamicGimbal {
  const config: GimbalConfig = gimbalConfigSchema.parse({
    pan: { ...idealAxis, ...patch.pan },
    tilt: { ...idealAxis, ...patch.tilt },
    commandLatency: patch.commandLatency ?? 0,
  });
  return new DynamicGimbal(config);
}

/** Runs `seconds` of simulated time in whole ticks. */
function run(mount: DynamicGimbal, duration: number, tick = TICK): void {
  const ticks = Math.round(duration / tick);
  for (let index = 1; index <= ticks; index += 1) mount.advanceTo(mount.time + tick);
}

// --- A ----------------------------------------------------------------------

describe('A. holding position', () => {
  it('does not drift when nothing is commanded', () => {
    const mount = gimbal({ pan: { initialAngle: 0.3 }, tilt: { initialAngle: -0.2 } });
    run(mount, 10);

    const pointing = mount.truePointing();
    expect(pointing.panAngle).toBe(0.3);
    expect(pointing.tiltAngle).toBe(-0.2);
    expect(pointing.panRate).toBe(0);
  });

  it('reports holding, because nothing is being driven', () => {
    const mount = gimbal({});
    run(mount, 1);
    expect(mount.servoPhase(TICK)).toBe('holding');
  });
});

// --- B ----------------------------------------------------------------------

describe('B. step response', () => {
  it('takes real time to get there', () => {
    // The defining behaviour: an ideal mount would already be at 0.2.
    const mount = gimbal({});
    mount.commandPosition(0.2, 0);

    mount.advanceTo(TICK);
    expect(mount.truePointing().panAngle).toBeGreaterThan(0);
    expect(mount.truePointing().panAngle).toBeLessThan(0.2);
  });

  it('arrives, and stays', () => {
    const mount = gimbal({});
    mount.commandPosition(0.2, 0);
    run(mount, 3);

    expect(mount.truePointing().panAngle).toBeCloseTo(0.2, 6);
    expect(mount.servoPhase(TICK)).toBe('holding');
  });

  it('approaches monotonically when over-damped', () => {
    // zeta = 1.2 is over-damped, so the continuous response has no overshoot and
    // every step must reduce the remaining error. The axis is slow relative to
    // the tick (omega*dt = 0.03) so the discretisation overshoot, which is
    // O(omega*dt) and quantified in numerics.test.ts, stays below the tolerance.
    const mount = gimbal({ pan: { dampingRatio: 1.2, naturalFrequency: 1 } });
    mount.commandPosition(0.5, 0);

    let previous = mount.truePointing().panAngle;
    for (let index = 0; index < 1200; index += 1) {
      mount.advanceTo(mount.time + TICK);
      const current = mount.truePointing().panAngle;
      expect(current).toBeGreaterThanOrEqual(previous - 1e-15);
      expect(current).toBeLessThanOrEqual(0.5 + 1e-6);
      previous = current;
    }
  });

  it('overshoots when lightly damped, and does not when heavily damped', () => {
    const peak = (dampingRatio: number): number => {
      const mount = gimbal({ pan: { dampingRatio, naturalFrequency: 2 } });
      mount.commandPosition(0.3, 0);
      let highest = 0;
      for (let index = 0; index < 2000; index += 1) {
        mount.advanceTo(mount.time + TICK);
        highest = Math.max(highest, mount.truePointing().panAngle);
      }
      return highest;
    };

    expect(peak(0.2)).toBeGreaterThan(0.3);
    expect(peak(1.5)).toBeLessThanOrEqual(0.3 + 1e-9);
  });
});

// --- C ----------------------------------------------------------------------

describe('C. velocity limit', () => {
  it('never moves faster than the axis can', () => {
    // A huge step with a slow axis: the servo would demand far more rate than
    // the mechanism has.
    const maxRate = 0.5;
    const mount = gimbal({ pan: { maxRate, maxAcceleration: 1000, naturalFrequency: 8 } });
    mount.commandPosition(1.9, 0);

    let previous = mount.truePointing().panAngle;
    let sawSaturation = false;
    for (let index = 0; index < 1200; index += 1) {
      mount.advanceTo(mount.time + TICK);
      const current = mount.truePointing().panAngle;
      expect(Math.abs(current - previous) / TICK).toBeLessThanOrEqual(maxRate + 1e-12);
      sawSaturation ||= mount.truth().pan.rateSaturated;
      previous = current;
    }

    expect(sawSaturation).toBe(true);
    expect(mount.truePointing().panAngle).toBeCloseTo(1.9, 6);
  });
});

// --- D ----------------------------------------------------------------------

describe('D. acceleration limit', () => {
  it('never changes rate faster than the axis can', () => {
    const maxAcceleration = 2;
    const mount = gimbal({ pan: { maxAcceleration, maxRate: 100, naturalFrequency: 8 } });
    mount.commandPosition(1.5, 0);

    let previousRate = 0;
    let sawSaturation = false;
    for (let index = 0; index < 1500; index += 1) {
      mount.advanceTo(mount.time + TICK);
      const truth = mount.truth().pan;
      // A mechanical stop is an impulse and is outside the servo's acceleration
      // budget by definition, so the bound applies to the free axis only.
      const againstStop = truth.atMinLimit || truth.atMaxLimit;
      if (!againstStop) {
        expect(Math.abs(truth.motorRate - previousRate) / TICK).toBeLessThanOrEqual(
          maxAcceleration + 1e-9,
        );
      }
      expect(Math.abs(truth.appliedAcceleration)).toBeLessThanOrEqual(maxAcceleration + 1e-12);
      sawSaturation ||= truth.accelerationSaturated;
      previousRate = truth.motorRate;
    }

    expect(sawSaturation).toBe(true);
  });

  it('records what the servo asked for as well as what it got', () => {
    const mount = gimbal({ pan: { maxAcceleration: 1, naturalFrequency: 8 } });
    mount.commandPosition(1.5, 0);
    mount.advanceTo(TICK);

    const truth = mount.truth().pan;
    expect(Math.abs(truth.commandedAcceleration)).toBeGreaterThan(
      Math.abs(truth.appliedAcceleration),
    );
  });
});

// --- E ----------------------------------------------------------------------

describe('E. travel limits', () => {
  it('clamps a command beyond the stop and says it did', () => {
    const mount = gimbal({ pan: { minAngle: -0.5, maxAngle: 0.5 } });
    mount.commandPosition(2, 0);
    mount.advanceTo(TICK);

    expect(mount.lastApplied?.panClamped).toBe(true);
    expect(mount.lastApplied?.acceptedPan).toBe(0.5);
  });

  it('cannot be driven past the stop', () => {
    const mount = gimbal({ pan: { minAngle: -0.5, maxAngle: 0.5 } });
    mount.commandPosition(5, 0);
    run(mount, 5);

    expect(mount.truePointing().panAngle).toBeLessThanOrEqual(0.5);
    expect(mount.truePointing().panAngle).toBeCloseTo(0.5, 6);
  });

  it('raises the limit flag only while actually against the stop', () => {
    const mount = gimbal({
      pan: { minAngle: -0.5, maxAngle: 0.5, maxRate: 100, maxAcceleration: 1000 },
    });
    expect(mount.truth().pan.atMaxLimit).toBe(false);

    mount.commandPosition(5, 0);
    let sawLimit = false;
    for (let index = 0; index < 200; index += 1) {
      mount.advanceTo(mount.time + TICK);
      sawLimit ||= mount.truth().pan.atMaxLimit;
    }
    expect(sawLimit).toBe(true);
  });

  it('absorbs outward momentum at the stop instead of storing it', () => {
    // Without this an axis would arrive at the stop carrying rate, and leap the
    // instant it was commanded back inward.
    const mount = gimbal({
      pan: { minAngle: -0.5, maxAngle: 0.5, maxRate: 2, maxAcceleration: 1000 },
    });
    mount.commandPosition(5, 0);

    let approachRate = 0;
    for (let index = 0; index < 600; index += 1) {
      mount.advanceTo(mount.time + TICK);
      const truth = mount.truth().pan;
      if (!truth.atMaxLimit) approachRate = Math.max(approachRate, Math.abs(truth.motorRate));
    }

    expect(approachRate).toBeGreaterThan(0.5);
    // Whatever it arrived with is gone, not stored.
    expect(Math.abs(mount.truth().pan.motorRate)).toBeLessThan(approachRate * 1e-6);
  });
});

// --- F ----------------------------------------------------------------------

describe('F. recovery from a limit', () => {
  it('comes back when commanded inward', () => {
    const mount = gimbal({ pan: { minAngle: -0.5, maxAngle: 0.5 } });
    mount.commandPosition(5, 0);
    run(mount, 3);
    expect(mount.truePointing().panAngle).toBeCloseTo(0.5, 6);

    mount.commandPosition(0, 0);
    run(mount, 3);

    expect(mount.truePointing().panAngle).toBeCloseTo(0, 6);
    expect(mount.truth().pan.atMaxLimit).toBe(false);
    expect(mount.lastApplied?.panClamped).toBe(false);
  });
});

// --- G ----------------------------------------------------------------------

describe('G. command latency', () => {
  it('does nothing at all before the command is due', () => {
    const mount = gimbal({ commandLatency: 0.05 });
    mount.commandPosition(0.4, 0);

    run(mount, 0.04);
    expect(mount.truePointing().panAngle).toBe(0);
    expect(mount.pendingCommands).toHaveLength(1);

    run(mount, 0.02);
    expect(mount.truePointing().panAngle).toBeGreaterThan(0);
    expect(mount.pendingCommands).toHaveLength(0);
  });

  it('applies a latency that is not a multiple of the tick at its exact time', () => {
    // 23 ms under a 5 ms tick. Rounding to a tick boundary would make the delay
    // 20 or 25 ms, and would make it depend on the tick rate.
    const latency = 0.023;
    const mount = gimbal({ commandLatency: latency });
    mount.commandPosition(0.4, 0);
    run(mount, 0.5);

    expect(mount.lastApplied?.dueAt).toBeCloseTo(latency, 12);
    expect(mount.lastApplied?.appliedAt).toBeCloseTo(latency, 12);
  });

  it('delays the whole response by the latency, not just the start of it', () => {
    // The delayed response must be the undelayed one shifted in time. Sampling
    // both at the same offset past their own command times proves the shape is
    // untouched.
    const delay = 0.023;
    const prompt = gimbal({ commandLatency: 0 });
    const delayed = gimbal({ commandLatency: delay });

    prompt.commandPosition(0.4, 0);
    delayed.commandPosition(0.4, 0);

    const offset = 0.2;
    prompt.advanceTo(offset);
    delayed.advanceTo(delay + offset);

    expect(delayed.truePointing().panAngle).toBeCloseTo(prompt.truePointing().panAngle, 6);
  });

  it('counts the delay from when the command was issued, not from the tick', () => {
    const mount = gimbal({ commandLatency: 0.01 });
    mount.advanceTo(0.0125); // Deliberately not on a tick boundary.
    mount.commandPosition(0.4, 0);

    expect(mount.pendingCommands[0]?.dueAt).toBeCloseTo(0.0225, 12);
  });
});

// --- H ----------------------------------------------------------------------

describe('H. command ordering', () => {
  it('applies commands in the order they fall due', () => {
    const mount = gimbal({ commandLatency: 0.02 });
    mount.commandPosition(0.1, 0);
    run(mount, 0.005);
    mount.commandPosition(0.2, 0);

    // Both fall due inside this interval; the later one must win.
    run(mount, 0.1);
    expect(mount.truth().pan.setpoint).toBe(0.2);
    expect(mount.lastApplied?.command.requestedPan).toBe(0.2);
  });

  it('breaks a tie by command id, so a batch is deterministic', () => {
    const mount = gimbal({ commandLatency: 0 });
    const first = mount.commandPosition(0.1, 0);
    const second = mount.commandPosition(0.2, 0);
    expect(second.commandId).toBeGreaterThan(first.commandId);

    mount.advanceTo(TICK);
    expect(mount.lastApplied?.command.commandId).toBe(second.commandId);
  });

  it('applies an overdue command at the start of the interval rather than in the past', () => {
    const mount = gimbal({ commandLatency: 0 });
    mount.commandPosition(0.3, 0);
    mount.advanceTo(0.5);

    expect(mount.lastApplied?.appliedAt).toBe(0);
  });
});

// --- I ----------------------------------------------------------------------

describe('I. deadband', () => {
  it('ignores a command smaller than the dead zone', () => {
    const deadband = 0.001;
    const mount = gimbal({ pan: { deadband } });
    mount.commandPosition(deadband / 2, 0);
    run(mount, 2);

    expect(mount.truePointing().panAngle).toBe(0);
  });

  it('responds to a command larger than it, short by about the band', () => {
    const deadband = 0.001;
    const mount = gimbal({ pan: { deadband, dampingRatio: 1.5 } });
    mount.commandPosition(0.05, 0);
    run(mount, 4);

    const settled = mount.truePointing().panAngle;
    expect(settled).toBeGreaterThan(0.05 - 2 * deadband);
    expect(settled).toBeLessThan(0.05);
  });

  it('is continuous at the edge of the band', () => {
    // A threshold would step from zero to the full error here; a subtractive
    // dead zone grows from zero, which is what keeps the image from ticking.
    const deadband = 0.001;
    expect(applyDeadband(deadband, deadband)).toBe(0);
    expect(applyDeadband(deadband * 1.000001, deadband)).toBeCloseTo(1e-9, 12);
    expect(applyDeadband(-deadband * 2, deadband)).toBeCloseTo(-deadband, 12);
  });

  it('passes the error through untouched when there is no dead zone', () => {
    expect(applyDeadband(0.37, 0)).toBe(0.37);
  });
});

// --- J ----------------------------------------------------------------------

describe('J. backlash', () => {
  it('leaves the output stationary while the motor crosses the gap', () => {
    const backlash = 0.01;
    const mount = gimbal({ pan: { backlash, maxRate: 0.2, maxAcceleration: 1000 } });

    mount.commandPosition(0.3, 0);
    run(mount, 4);
    const forwardOutput = mount.truePointing().panAngle;
    const forwardMotor = mount.truth().pan.motorAngle;

    // Reverse. The load cannot move until the motor has crossed the whole gap.
    mount.commandPosition(-0.3, 0);
    let stationaryTravel = 0;
    let previousMotor = forwardMotor;
    for (let index = 0; index < 2000; index += 1) {
      mount.advanceTo(mount.time + TICK);
      const motor = mount.truth().pan.motorAngle;
      if (mount.truePointing().panAngle === forwardOutput) {
        stationaryTravel += Math.abs(motor - previousMotor);
      }
      previousMotor = motor;
      if (mount.truePointing().panAngle < forwardOutput - 0.01) break;
    }

    expect(stationaryTravel).toBeGreaterThan(backlash * 0.9);
    expect(stationaryTravel).toBeLessThan(backlash * 1.1);
  });

  it('is genuine hysteresis: the same motor angle gives different outputs', () => {
    const backlash = 0.02;
    const mount = gimbal({ pan: { backlash, maxRate: 0.3, maxAcceleration: 1000 } });

    // Detects the crossing rather than proximity: at 0.3 rad/s a tick moves the
    // motor 1.5 mrad, which can step straight over a narrow window.
    const outputAsMotorCrosses = (target: number): number => {
      let previous = mount.truth().pan.motorAngle;
      for (let index = 0; index < 4000; index += 1) {
        mount.advanceTo(mount.time + TICK);
        const motor = mount.truth().pan.motorAngle;
        if ((previous - target) * (motor - target) <= 0 && previous !== motor) {
          return mount.truePointing().panAngle;
        }
        previous = motor;
      }
      throw new Error('motor never passed the probe angle');
    };

    // Each direction is approached from a settled state at the far end, so the
    // gap is fully taken up before the probe angle is reached. Reversing near
    // the probe would measure a half-crossed gap instead.
    mount.commandPosition(0.4, 0);
    const rising = outputAsMotorCrosses(0.2);
    run(mount, 4);

    mount.commandPosition(-0.4, 0);
    const falling = outputAsMotorCrosses(0.2);

    // Approaching from below the load trails the motor; from above it leads.
    expect(rising).toBeLessThan(falling);
    expect(falling - rising).toBeGreaterThan(backlash * 0.5);
    expect(falling - rising).toBeLessThan(backlash * 1.5);
  });

  it('reports the take-up as it is crossed', () => {
    const mount = gimbal({ pan: { backlash: 0.01, maxRate: 0.2, maxAcceleration: 1000 } });
    mount.commandPosition(0.3, 0);
    run(mount, 2);
    mount.commandPosition(-0.3, 0);
    mount.advanceTo(mount.time + TICK * 4);

    expect(Math.abs(mount.truth().pan.backlashDisplacement)).toBeGreaterThan(0);
    expect(Math.abs(mount.truth().pan.backlashDisplacement)).toBeLessThanOrEqual(0.01 / 2 + 1e-12);
  });

  it('clamps the load into the gap around the motor', () => {
    expect(applyBacklash(0, 0.03, 0.02)).toBeCloseTo(0.02, 12);
    expect(applyBacklash(0.02, 0.015, 0.02)).toBe(0.02);
  });
});

// --- K ----------------------------------------------------------------------

describe('K. zero backlash', () => {
  it('couples the load directly to the motor', () => {
    const mount = gimbal({ pan: { backlash: 0 } });
    mount.commandPosition(0.3, 0);

    for (let index = 0; index < 300; index += 1) {
      mount.advanceTo(mount.time + TICK);
      expect(mount.truePointing().panAngle).toBe(mount.truth().pan.motorAngle);
      expect(mount.truth().pan.backlashDisplacement).toBe(0);
    }
  });

  it('needs no special case in the operator', () => {
    expect(applyBacklash(0.5, 0.9, 0)).toBe(0.9);
  });
});

// --- L ----------------------------------------------------------------------

describe('L. encoder quantisation', () => {
  it('reports only whole counts', () => {
    const resolution = 1e-3;
    const mount = gimbal({ pan: { encoderResolution: resolution } });
    mount.commandPosition(0.317, 0);

    for (let index = 0; index < 400; index += 1) {
      mount.advanceTo(mount.time + TICK);
      const reading = mount.measuredPointing().panAngle;
      expect(Math.abs(reading / resolution - Math.round(reading / resolution))).toBeLessThan(1e-9);
    }
  });

  it('stays within half a count of the truth', () => {
    const resolution = 1e-3;
    const mount = gimbal({ pan: { encoderResolution: resolution } });
    mount.commandPosition(0.317, 0);

    for (let index = 0; index < 400; index += 1) {
      mount.advanceTo(mount.time + TICK);
      const error = mount.measuredPointing().panAngle - mount.truePointing().panAngle;
      expect(Math.abs(error)).toBeLessThanOrEqual(resolution / 2 + 1e-15);
    }
  });

  it('is a real loss of information, not a cosmetic rounding', () => {
    const resolution = 1e-3;
    const mount = gimbal({ pan: { encoderResolution: resolution } });
    mount.commandPosition(0.317, 0);
    run(mount, 3);

    expect(mount.measuredPointing().panAngle).not.toBe(mount.truePointing().panAngle);
  });

  it('rounds to nearest, including across zero', () => {
    expect(quantizeAngle(0.0014, 1e-3)).toBeCloseTo(0.001, 12);
    expect(quantizeAngle(-0.0016, 1e-3)).toBeCloseTo(-0.002, 12);
    expect(quantizeAngle(0, 1e-3)).toBe(0);
  });

  it('derives rate by differencing readings, as a controller would', () => {
    const mount = gimbal({ pan: { encoderResolution: 1e-5, maxRate: 100 } });
    mount.commandPosition(0.5, 0);
    run(mount, 0.05);

    const measured = mount.measuredPointing();
    expect(measured.derivedPanRate).not.toBe(0);
    // Within a count per tick of the true rate: the difference is quantisation
    // noise, which is exactly what a real controller has to live with.
    const quantisationNoise = 1e-5 / TICK;
    expect(Math.abs(measured.derivedPanRate - mount.truePointing().panRate)).toBeLessThan(
      quantisationNoise * 2,
    );
  });
});

// --- M ----------------------------------------------------------------------

describe('M. reset', () => {
  it('returns the whole mechanism to its initial state', () => {
    const mount = gimbal({
      pan: { initialAngle: 0.1, backlash: 0.01 },
      tilt: { initialAngle: -0.2 },
      commandLatency: 0.02,
    });
    mount.commandPosition(0.8, 0.5);
    run(mount, 1);
    mount.commandPosition(-0.8, -0.4);

    mount.reset();

    expect(mount.time).toBe(0);
    expect(mount.truePointing().panAngle).toBe(0.1);
    expect(mount.truePointing().tiltAngle).toBe(-0.2);
    expect(mount.truePointing().panRate).toBe(0);
    expect(mount.pendingCommands).toHaveLength(0);
    expect(mount.lastApplied).toBeNull();
    expect(mount.truth().pan.setpoint).toBe(0.1);
  });

  it('produces an identical run afterwards', () => {
    const mount = gimbal({ commandLatency: 0.013 });
    const trace = (): number[] => {
      const seen: number[] = [];
      mount.commandPosition(0.4, -0.1);
      for (let index = 0; index < 200; index += 1) {
        mount.advanceTo(mount.time + TICK);
        seen.push(mount.truePointing().panAngle);
      }
      return seen;
    };

    const first = trace();
    mount.reset();
    const second = trace();

    expect(second).toEqual(first);
  });
});

// --- N ----------------------------------------------------------------------

describe('N. pause', () => {
  it('does not move while simulated time is not advancing', () => {
    const mount = gimbal({});
    mount.commandPosition(0.4, 0);
    run(mount, 0.05);
    const held = mount.truePointing();

    // A paused run calls nothing; asking for the same instant again must be a
    // no-op rather than a further step.
    mount.advanceTo(mount.time);
    mount.advanceTo(mount.time);

    expect(mount.truePointing()).toEqual(held);
  });

  it('accepts commands while paused and acts on them when time resumes', () => {
    const mount = gimbal({});
    run(mount, 0.05);
    const before = mount.truePointing().panAngle;

    mount.commandPosition(0.4, 0);
    expect(mount.truePointing().panAngle).toBe(before);

    run(mount, 3);
    expect(mount.truePointing().panAngle).toBeCloseTo(0.4, 6);
  });

  it('refuses to run backwards', () => {
    const mount = gimbal({});
    run(mount, 0.1);
    expect(() => mount.advanceTo(0.05)).toThrow(RangeError);
  });

  it('resuming produces the same trajectory as never pausing', () => {
    const straight = gimbal({ commandLatency: 0.007 });
    const paused = gimbal({ commandLatency: 0.007 });

    straight.commandPosition(0.3, 0.1);
    paused.commandPosition(0.3, 0.1);

    run(straight, 1);
    run(paused, 0.4);
    paused.advanceTo(paused.time); // The pause itself.
    run(paused, 0.6);

    expect(paused.truePointing()).toEqual(straight.truePointing());
  });
});

// --- O ----------------------------------------------------------------------

describe('O. reproducibility', () => {
  it('gives bit-identical trajectories for identical command histories', () => {
    const trace = (): string => {
      const mount = gimbal({ pan: { backlash: 0.004 }, commandLatency: 0.017 });
      const seen: number[] = [];
      for (let index = 0; index < 600; index += 1) {
        if (index === 10) mount.commandPosition(0.6, -0.2);
        if (index === 250) mount.commandPosition(-0.3, 0.4);
        mount.advanceTo(mount.time + TICK);
        seen.push(mount.truePointing().panAngle, mount.truePointing().tiltAngle);
      }
      return seen.map((value) => value.toExponential(17)).join(',');
    };

    expect(trace()).toBe(trace());
  });

  it('does not depend on how the interval was subdivided, for the ticks it shares', () => {
    // Advancing tick by tick and advancing in one call are different
    // integrations and are not expected to agree; what must agree is two runs
    // that take the same steps.
    const a = gimbal({});
    const b = gimbal({});
    a.commandPosition(0.3, 0);
    b.commandPosition(0.3, 0);

    for (let index = 1; index <= 100; index += 1) {
      a.advanceTo(index * TICK);
      b.advanceTo(index * TICK);
    }

    expect(a.truePointing()).toEqual(b.truePointing());
  });
});

// --- P ----------------------------------------------------------------------

describe('P. axis independence', () => {
  it('does not move tilt when only pan is commanded', () => {
    const mount = gimbal({ tilt: { initialAngle: 0.2 } });
    mount.commandPosition(0.5, 0.2);
    run(mount, 2);

    expect(mount.truePointing().tiltAngle).toBe(0.2);
    expect(mount.truePointing().tiltRate).toBe(0);
  });

  it('gives each axis its own dynamics', () => {
    const mount = gimbal({
      pan: { naturalFrequency: 2 },
      tilt: { naturalFrequency: 12 },
    });
    mount.commandPosition(0.3, 0.3);
    run(mount, 0.2);

    // The faster axis is further along.
    expect(mount.truePointing().tiltAngle).toBeGreaterThan(mount.truePointing().panAngle);
  });

  it('limits one axis without limiting the other', () => {
    const mount = gimbal({ pan: { minAngle: -0.1, maxAngle: 0.1 } });
    mount.commandPosition(5, 1.5);
    run(mount, 3);

    expect(mount.truePointing().panAngle).toBeCloseTo(0.1, 6);
    expect(mount.truePointing().tiltAngle).toBeCloseTo(1.5, 6);
    expect(mount.lastApplied?.panClamped).toBe(true);
    expect(mount.lastApplied?.tiltClamped).toBe(false);
  });
});

// --- Q ----------------------------------------------------------------------

describe('Q. numerical stability', () => {
  it('stays bounded over a long run of random commands', () => {
    // Deterministic pseudo-random sequence: a fixed script, not a PRNG import,
    // so the case is self-contained and reproducible.
    const mount = gimbal({ pan: { backlash: 0.003 }, commandLatency: 0.011 });

    let state = 12345;
    const nextTarget = (): number => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return ((state / 2147483648) * 2 - 1) * 1.8;
    };

    for (let index = 0; index < 20_000; index += 1) {
      if (index % 37 === 0) mount.commandPosition(nextTarget(), nextTarget() * 0.5);
      mount.advanceTo(mount.time + TICK);

      const pointing = mount.truePointing();
      expect(Number.isFinite(pointing.panAngle)).toBe(true);
      expect(Math.abs(pointing.panAngle)).toBeLessThanOrEqual(2 + 1e-9);
    }
  });

  it('does not gain energy when left undisturbed', () => {
    // Forward Euler injects energy into an oscillator; the symplectic form does
    // not. Started away from its setpoint with no damping to speak of, the
    // amplitude must not grow.
    const axis = new GimbalAxis(
      gimbalConfigSchema.parse({
        pan: { ...idealAxis, dampingRatio: 0.05, naturalFrequency: 4 },
        tilt: idealAxis,
        commandLatency: 0,
      }).pan,
    );
    axis.setSetpoint(0.5);

    let firstPeak = 0;
    let lastPeak = 0;
    let previous = axis.state().motorAngle;
    let rising = true;
    for (let index = 0; index < 6000; index += 1) {
      axis.advance(TICK);
      const angle = axis.state().motorAngle;
      if (rising && angle < previous) {
        const overshoot = previous - 0.5;
        if (firstPeak === 0) firstPeak = overshoot;
        lastPeak = overshoot;
        rising = false;
      } else if (!rising && angle > previous) {
        rising = true;
      }
      previous = angle;
    }

    expect(firstPeak).toBeGreaterThan(0);
    expect(lastPeak).toBeLessThanOrEqual(firstPeak);
  });

  it('refuses a negative or non-finite step', () => {
    const mount = gimbal({});
    expect(() => mount.advanceTo(Number.NaN)).toThrow(RangeError);
  });

  it('refuses a non-finite command', () => {
    const mount = gimbal({});
    expect(() => mount.commandPosition(Number.NaN, 0)).toThrow(RangeError);
    expect(() => mount.commandPosition(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

// --- Jogging ----------------------------------------------------------------

describe('relative commands', () => {
  it('accumulates presses issued inside one latency window', () => {
    // The operator's jog control. Measured from the last *requested* angle, not
    // the last applied one: with a 23 ms delay, six quick presses measured from
    // the applied setpoint would all request the same angle and five would be
    // silently lost.
    const mount = gimbal({ commandLatency: 0.023 });
    const step = 0.01;

    for (let index = 0; index < 6; index += 1) mount.nudge(step, 0);

    expect(mount.pendingCommands).toHaveLength(6);
    expect(mount.pendingCommands[5]?.command.requestedPan).toBeCloseTo(step * 6, 12);

    run(mount, 4);
    expect(mount.truePointing().panAngle).toBeCloseTo(step * 6, 6);
  });

  it('does not wind up past a travel stop', () => {
    // Otherwise jogging into the stop would build an unreachable target, and
    // the operator would have to jog all the way back before anything moved.
    const mount = gimbal({ pan: { minAngle: -0.1, maxAngle: 0.1 } });
    for (let index = 0; index < 100; index += 1) mount.nudge(0.05, 0);

    const newest = mount.pendingCommands[mount.pendingCommands.length - 1];
    expect(newest?.command.requestedPan).toBe(0.1);

    // One press back off the stop moves the target, rather than unwinding.
    mount.nudge(-0.05, 0);
    const afterBackoff = mount.pendingCommands[mount.pendingCommands.length - 1];
    expect(afterBackoff?.command.requestedPan).toBeCloseTo(0.05, 12);
  });

  it('measures from the applied setpoint once the queue is empty', () => {
    const mount = gimbal({ commandLatency: 0 });
    mount.nudge(0.02, 0);
    run(mount, 3);

    mount.nudge(0.02, 0);
    run(mount, 3);

    expect(mount.truePointing().panAngle).toBeCloseTo(0.04, 6);
  });
});
