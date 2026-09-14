// @vitest-environment node
/**
 * The integrator, checked against the closed-form answer.
 *
 * The axis model is a second-order system:
 *
 * ```
 *   x'' + 2*zeta*omega*x' + omega^2*x = omega^2*u
 * ```
 *
 * which has an exact step response. Nothing else in this project can check the
 * integrator: a recorded trajectory only proves the code still does what it did
 * yesterday. These cases prove it does what the differential equation says, and
 * measure by how much it misses — because it does miss, and the size of that
 * miss is a property of the model that belongs in the record rather than in
 * someone's head.
 *
 * The limits and nonlinearities are switched off here on purpose. A rate limit
 * or a deadband makes the system nonlinear and there is no closed form to
 * compare against; those are covered behaviourally in actuator.test.ts.
 */

import { describe, expect, it } from 'vitest';

import { MAX_SERVO_OMEGA_TIMESTEP, gimbalConfigSchema } from '@/core/contracts/gimbal';

import { GimbalAxis } from './axis';

/**
 * Exact unit-step response of the system above, starting from rest at zero.
 *
 * Three regimes, because the roots of `s^2 + 2*zeta*omega*s + omega^2` change
 * character at `zeta = 1` and a single expression would be numerically useless
 * near it.
 */
function analyticStep(amplitude: number, omega: number, zeta: number, t: number): number {
  if (t <= 0) return 0;

  if (Math.abs(zeta - 1) < 1e-12) {
    // Critically damped: repeated root at -omega.
    return amplitude * (1 - Math.exp(-omega * t) * (1 + omega * t));
  }

  if (zeta < 1) {
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const decay = Math.exp(-zeta * omega * t);
    return (
      amplitude *
      (1 - decay * (Math.cos(wd * t) + (zeta / Math.sqrt(1 - zeta * zeta)) * Math.sin(wd * t)))
    );
  }

  // Over-damped: two distinct real roots.
  const root = omega * Math.sqrt(zeta * zeta - 1);
  const s1 = -zeta * omega + root;
  const s2 = -zeta * omega - root;
  return amplitude * (1 - (s1 * Math.exp(s2 * t) - s2 * Math.exp(s1 * t)) / (s1 - s2));
}

/** An axis with every limit and nonlinearity out of the way. */
function linearAxis(naturalFrequency: number, dampingRatio: number): GimbalAxis {
  const config = gimbalConfigSchema.parse({
    pan: {
      initialAngle: 0,
      minAngle: -10,
      maxAngle: 10,
      maxRate: 1e6,
      maxAcceleration: 1e9,
      naturalFrequency,
      dampingRatio,
      deadband: 0,
      backlash: 0,
      encoderResolution: 1e-9,
    },
    tilt: {
      initialAngle: 0,
      minAngle: -10,
      maxAngle: 10,
      maxRate: 1e6,
      maxAcceleration: 1e9,
      naturalFrequency,
      dampingRatio,
      deadband: 0,
      backlash: 0,
      encoderResolution: 1e-9,
    },
    commandLatency: 0,
  });
  return new GimbalAxis(config.pan);
}

/** Largest absolute difference from the closed form over `duration`. */
function worstError(
  naturalFrequency: number,
  dampingRatio: number,
  dt: number,
  amplitude = 1,
  duration = 3,
): number {
  const axis = linearAxis(naturalFrequency, dampingRatio);
  axis.setSetpoint(amplitude);

  const omega = 2 * Math.PI * naturalFrequency;
  const steps = Math.round(duration / dt);
  let worst = 0;

  for (let step = 1; step <= steps; step += 1) {
    axis.advance(dt);
    const exact = analyticStep(amplitude, omega, dampingRatio, step * dt);
    worst = Math.max(worst, Math.abs(axis.state().motorAngle - exact));
  }
  return worst;
}

describe('the closed form itself', () => {
  it('starts at zero and settles at the commanded amplitude', () => {
    const omega = 2 * Math.PI * 2;
    expect(analyticStep(0.5, omega, 0.7, 0)).toBe(0);
    expect(analyticStep(0.5, omega, 0.7, 20)).toBeCloseTo(0.5, 9);
  });

  it('overshoots by exp(-pi*zeta/sqrt(1-zeta^2)) when under-damped', () => {
    // The textbook result, which pins the formula independently of the axis.
    const zeta = 0.3;
    const omega = 2 * Math.PI * 2;
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    const peak = analyticStep(1, omega, zeta, Math.PI / wd);
    expect(peak - 1).toBeCloseTo(Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta)), 6);
  });
});

describe('the discrete axis against the closed form', () => {
  // 5 ms is the tick of the bundled scenarios, and 8 Hz is the realistic-lab
  // profile's bandwidth: omega*dt = 0.25, half the validated ceiling.
  const TICK = 1 / 200;

  // Measured peak transient error against the closed form, as a fraction of the
  // step, at omega*dt = 0.251 (8 Hz servo, 200 Hz tick). These are the model's
  // real accuracy and are quoted in docs/GIMBAL_MODEL.md rather than left for
  // someone to rediscover: the error is in the transient, it shrinks with the
  // tick, and it is zero at steady state.
  it.each([
    ['under-damped', 0.3, 0.12],
    ['lightly damped', 0.7, 0.097],
    ['near critical', 0.9, 0.087],
    ['critically damped', 1, 0.083],
    ['over-damped', 1.5, 0.065],
  ])('tracks a %s response at the bundled tick', (_label, zeta, tolerance) => {
    const error = worstError(8, zeta, TICK);
    expect(error).toBeLessThan(tolerance);
    // And is not trivially small, which would mean the case proves nothing:
    // first-order Euler at this step really does cost several percent.
    expect(error).toBeGreaterThan(tolerance / 2);
  });

  it('is accurate to a fraction of a percent when the axis is slow for the tick', () => {
    // omega*dt = 0.0063. The error is a property of the step, not of the model,
    // and a scenario that needs better can have it by asking for it.
    expect(worstError(0.2, 0.7, TICK)).toBeLessThan(0.003);
  });

  it('converges as the step shrinks, at first order', () => {
    // Semi-implicit Euler is first-order accurate: halving dt should roughly
    // halve the error. Checked over three halvings so a coincidence at one
    // step size cannot pass.
    const errors = [TICK, TICK / 2, TICK / 4, TICK / 8].map((dt) => worstError(8, 0.7, dt));

    for (let index = 1; index < errors.length; index += 1) {
      const ratio = errors[index - 1]! / errors[index]!;
      expect(ratio).toBeGreaterThan(1.9);
      expect(ratio).toBeLessThan(2.2);
    }
    expect(errors[errors.length - 1]!).toBeLessThan(0.012);
  });

  it('has no steady-state error at all', () => {
    // The error is in the transient. Where the axis ends up is exact, because
    // the fixed point of the update is the setpoint itself.
    const axis = linearAxis(8, 0.9);
    axis.setSetpoint(0.37);
    for (let step = 0; step < 20_000; step += 1) axis.advance(1 / 200);

    expect(axis.state().motorAngle).toBeCloseTo(0.37, 12);
    expect(axis.state().motorRate).toBeCloseTo(0, 12);
  });

  it('scales with the size of the step, so the error is relative not absolute', () => {
    const small = worstError(8, 0.7, TICK, 0.1);
    const large = worstError(8, 0.7, TICK, 1);
    expect(large / small).toBeCloseTo(10, 1);
  });

  it('reproduces the theoretical overshoot to within a percent of the step', () => {
    const zeta = 0.3;
    const axis = linearAxis(4, zeta);
    axis.setSetpoint(1);

    let peak = 0;
    for (let step = 0; step < 4000; step += 1) {
      axis.advance(TICK);
      peak = Math.max(peak, axis.state().motorAngle);
    }

    // Within 1% of the step: the discrete peak is slightly low, which is the
    // same transient error measured above showing up at the overshoot.
    const theoretical = 1 + Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta));
    expect(Math.abs(peak - theoretical)).toBeLessThan(0.01);
  });

  it('stays stable right at the validated ceiling', () => {
    // The schema refuses a scenario whose omega*dt exceeds this. At the bound
    // the response must still be a decaying oscillation rather than a growing
    // one — that is what the bound is for.
    const dt = 1 / 200;
    const naturalFrequency = MAX_SERVO_OMEGA_TIMESTEP / (2 * Math.PI * dt);
    const axis = linearAxis(naturalFrequency, 0.7);
    axis.setSetpoint(1);

    let peak = 0;
    let latePeak = 0;
    for (let step = 1; step <= 4000; step += 1) {
      axis.advance(dt);
      const excursion = Math.abs(axis.state().motorAngle - 1);
      peak = Math.max(peak, excursion);
      if (step > 2000) latePeak = Math.max(latePeak, excursion);
    }

    expect(Number.isFinite(peak)).toBe(true);
    expect(latePeak).toBeLessThan(peak * 1e-3);
  });

  it('diverges well past the ceiling, which is why the ceiling is validated', () => {
    // Not a demand on the model — a demonstration that the schema bound is
    // load-bearing rather than decorative.
    const dt = 1 / 200;
    const reckless = (MAX_SERVO_OMEGA_TIMESTEP * 10) / (2 * Math.PI * dt);
    const axis = linearAxis(reckless, 0.7);
    axis.setSetpoint(1);

    for (let step = 0; step < 200; step += 1) axis.advance(dt);

    expect(Math.abs(axis.state().motorAngle - 1)).toBeGreaterThan(1);
  });
});
