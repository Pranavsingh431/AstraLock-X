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

  // The unsaturated step is taken with the closed-form transition matrix, so
  // the only error is floating point. Phase 3 integrated this path with
  // semi-implicit Euler and paid 13.3% of a step in peak transient error on the
  // near-ideal profile; that was discovered in the Phase 4 preflight and is the
  // reason the integrator changed. See ADR-0012.
  it.each([
    ['under-damped', 0.3],
    ['lightly damped', 0.7],
    ['near critical', 0.9],
    ['critically damped', 1],
    ['over-damped', 1.5],
    ['heavily over-damped', 5],
  ])('reproduces a %s response to machine precision', (_label, zeta) => {
    expect(worstError(8, zeta, TICK)).toBeLessThan(1e-12);
  });

  it.each([
    ['near-ideal', 12, 0.9],
    ['realistic-lab pan', 6, 0.65],
    ['realistic-lab tilt', 5, 0.7],
  ])('reproduces the bundled %s profile exactly', (_label, frequency, zeta) => {
    // Both shipped profiles, at the tick they actually run at. These are the
    // plants the Phase 4 controller is tuned against, so their fidelity is not
    // a general claim about the integrator but a specific one about them.
    expect(worstError(frequency, zeta, TICK)).toBeLessThan(1e-12);
  });

  it('is exact regardless of step size, not merely convergent', () => {
    // The distinguishing property. A convergent integrator gets better as the
    // step shrinks; this one is already right, so every step size agrees.
    const errors = [TICK, TICK / 2, TICK / 4, TICK * 4].map((dt) => worstError(8, 0.7, dt));
    for (const error of errors) expect(error).toBeLessThan(1e-12);
  });

  it('stays exact for a large step, where Euler was unstable', () => {
    // omega*dt = 2.0, four times the bound the Euler path needed. The closed
    // form has no stability condition: it is the analytic answer.
    const dt = 1 / 200;
    const frequency = 2 / (2 * Math.PI * dt);
    expect(worstError(frequency, 0.7, dt, 1, 1)).toBeLessThan(1e-10);
  });

  it('scales with the size of the step only through floating point', () => {
    const small = worstError(8, 0.7, TICK, 0.1);
    const large = worstError(8, 0.7, TICK, 1);
    expect(small).toBeLessThan(1e-12);
    expect(large).toBeLessThan(1e-12);
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

  it('reproduces the theoretical overshoot', () => {
    const zeta = 0.3;
    const axis = linearAxis(4, zeta);
    axis.setSetpoint(1);

    let peak = 0;
    for (let step = 0; step < 4000; step += 1) {
      axis.advance(TICK);
      peak = Math.max(peak, axis.state().motorAngle);
    }

    // The sampled peak sits a hair below the continuous one purely because the
    // sample grid may not land on the instant of the true maximum; the bound is
    // the curvature of the response over half a tick, not integration error.
    const theoretical = 1 + Math.exp((-Math.PI * zeta) / Math.sqrt(1 - zeta * zeta));
    expect(peak).toBeLessThanOrEqual(theoretical + 1e-12);
    expect(Math.abs(peak - theoretical)).toBeLessThan(1e-3);
  });

  it('stays stable right at the validated ceiling', () => {
    // The schema still refuses a scenario above this bound. It no longer
    // guards the unsaturated path, which has no stability condition at all —
    // it guards the clamped Euler fallback the axis uses while a limit binds,
    // which is still first order and still conditionally stable.
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

  it('remains bounded when the saturated fallback is the path taken', () => {
    // A tight acceleration limit forces the clamped Euler branch for most of
    // the run. It must still converge rather than ring away.
    const config = gimbalConfigSchema.parse({
      pan: {
        initialAngle: 0,
        minAngle: -10,
        maxAngle: 10,
        maxRate: 0.4,
        maxAcceleration: 1.5,
        naturalFrequency: 8,
        dampingRatio: 0.7,
        deadband: 0,
        backlash: 0,
        encoderResolution: 1e-9,
      },
      tilt: {
        initialAngle: 0,
        minAngle: -10,
        maxAngle: 10,
        maxRate: 0.4,
        maxAcceleration: 1.5,
        naturalFrequency: 8,
        dampingRatio: 0.7,
        deadband: 0,
        backlash: 0,
        encoderResolution: 1e-9,
      },
      commandLatency: 0,
    });
    const axis = new GimbalAxis(config.pan);
    axis.setSetpoint(1);

    let sawSaturation = false;
    for (let step = 0; step < 8000; step += 1) {
      axis.advance(1 / 200);
      sawSaturation ||= axis.state().flags.accelerationSaturated;
    }

    expect(sawSaturation).toBe(true);
    expect(axis.state().motorAngle).toBeCloseTo(1, 6);
  });
});
