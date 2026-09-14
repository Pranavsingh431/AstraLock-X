// @vitest-environment node
/**
 * The outer pointing loop's controller.
 *
 * A PID is small enough that every term can be checked against arithmetic done
 * by hand, so these cases mostly do exactly that: given this error, this dt and
 * these gains, the output must be this number. Sign errors in a controller are
 * catastrophic and completely silent — the mount simply drives away from the
 * target — so the direction cases matter as much as the magnitudes.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_BASELINE_PAT_CONFIG } from './config';
import { PidController, type PidConfig } from './pid';

const P_ONLY: PidConfig = {
  kp: 0.5,
  ki: 0,
  kd: 0,
  outputLimit: 1,
  integralLimit: 1,
  derivativeFilterTau: 0,
};

const make = (patch: Partial<PidConfig> = {}): PidController =>
  new PidController({ ...P_ONLY, ...patch });

describe('proportional behaviour', () => {
  it('does nothing when there is no error', () => {
    const pid = make();
    const step = pid.step(0, 1 / 60);

    expect(step.output).toBe(0);
    expect(step.proportional).toBe(0);
    expect(step.integral).toBe(0);
    expect(step.derivative).toBe(0);
  });

  it('commands in the same direction as the error', () => {
    // The sign convention: error is "target minus where I am", so a positive
    // error means the target is at a larger angle and the mount must increase
    // its angle. A negated output here would drive the mount away and the
    // system would diverge with no other symptom.
    const pid = make();
    expect(pid.step(0.1, 1 / 60).output).toBeGreaterThan(0);

    pid.reset();
    expect(pid.step(-0.1, 1 / 60).output).toBeLessThan(0);
  });

  it('is exactly kp times the error', () => {
    expect(make({ kp: 0.7 }).step(0.2, 1 / 60).output).toBeCloseTo(0.14, 12);
  });

  it('scales linearly with the error', () => {
    const a = make().step(0.1, 1 / 60).output;
    const b = make().step(0.2, 1 / 60).output;
    expect(b).toBeCloseTo(2 * a, 12);
  });
});

describe('integral behaviour', () => {
  it('accumulates a persistent error', () => {
    const pid = make({ kp: 0, ki: 1 });
    const dt = 0.1;

    pid.step(0.2, dt);
    expect(pid.integralTerm).toBeCloseTo(0.02, 12);

    pid.step(0.2, dt);
    expect(pid.integralTerm).toBeCloseTo(0.04, 12);
  });

  it('unwinds when the error changes sign', () => {
    const pid = make({ kp: 0, ki: 1 });
    pid.step(0.5, 0.1);
    pid.step(0.5, 0.1);
    const wound = pid.integralTerm;

    pid.step(-0.5, 0.1);
    expect(pid.integralTerm).toBeLessThan(wound);
  });

  it('removes a steady offset that P alone would leave', () => {
    // The reason the term is there at all.
    const pid = make({ kp: 0.5, ki: 2 });
    let output = 0;
    for (let k = 0; k < 50; k += 1) output = pid.step(0.01, 1 / 60).output;

    expect(output).toBeGreaterThan(0.5 * 0.01);
  });
});

describe('anti-windup', () => {
  it('stops accumulating once the output is saturated', () => {
    // A mount commanded somewhere it cannot reach would otherwise store an
    // ever-growing demand that has to be unwound before it will come back.
    const pid = make({ kp: 1, ki: 5, outputLimit: 0.1, integralLimit: 100 });

    for (let k = 0; k < 20; k += 1) pid.step(1, 0.1);
    const early = pid.integralTerm;

    for (let k = 0; k < 200; k += 1) pid.step(1, 0.1);
    expect(pid.integralTerm).toBeCloseTo(early, 9);
  });

  it('caps the integral even when the output is not saturated', () => {
    const pid = make({ kp: 0, ki: 5, outputLimit: 1000, integralLimit: 0.25 });
    for (let k = 0; k < 500; k += 1) pid.step(0.5, 0.1);

    expect(pid.integralTerm).toBeLessThanOrEqual(0.25 + 1e-12);
  });

  it('recovers immediately when the error reverses', () => {
    // The test that distinguishes real anti-windup from a hard cap alone: after
    // a long saturated push, one step of opposite error must already be able to
    // move the output, not wait for a wound-up integral to drain.
    const pid = make({ kp: 1, ki: 5, outputLimit: 0.1, integralLimit: 100 });
    for (let k = 0; k < 200; k += 1) pid.step(1, 0.1);

    const reversed = pid.step(-1, 0.1);
    expect(reversed.output).toBeLessThan(0.1);
    expect(pid.integralTerm).toBeLessThan(200 * 5 * 0.1);
  });

  it('accumulates again once the output comes off the limit', () => {
    const pid = make({ kp: 1, ki: 5, outputLimit: 0.5, integralLimit: 100 });
    for (let k = 0; k < 50; k += 1) pid.step(1, 0.1);
    const saturatedIntegral = pid.integralTerm;

    for (let k = 0; k < 10; k += 1) pid.step(-0.01, 0.1);
    expect(pid.integralTerm).toBeLessThan(saturatedIntegral);
  });
});

describe('derivative behaviour', () => {
  it('is zero on the first step, with no history to difference', () => {
    expect(make({ kp: 0, kd: 1 }).step(0.5, 0.1).derivative).toBe(0);
  });

  it('responds to a changing error', () => {
    const pid = make({ kp: 0, kd: 1 });
    pid.step(0.1, 0.1);
    expect(pid.step(0.2, 0.1).derivative).toBeGreaterThan(0);
  });

  it('opposes a shrinking error, which is what damps the loop', () => {
    const pid = make({ kp: 0, kd: 1 });
    pid.step(0.2, 0.1);
    expect(pid.step(0.1, 0.1).derivative).toBeLessThan(0);
  });

  it('is exactly kd times the slope when unfiltered', () => {
    const pid = make({ kp: 0, kd: 2, derivativeFilterTau: 0 });
    pid.step(0.1, 0.5);
    expect(pid.step(0.3, 0.5).derivative).toBeCloseTo(2 * ((0.3 - 0.1) / 0.5), 12);
  });

  it('the filter blunts a one-step spike', () => {
    // The error carries an encoder step of up to one count; a raw derivative of
    // that is a large phantom rate.
    const raw = make({ kp: 0, kd: 1, derivativeFilterTau: 0 });
    const filtered = make({ kp: 0, kd: 1, derivativeFilterTau: 0.1 });

    raw.step(0, 1 / 60);
    filtered.step(0, 1 / 60);

    const rawSpike = raw.step(0.01, 1 / 60).derivative;
    const filteredSpike = filtered.step(0.01, 1 / 60).derivative;

    expect(Math.abs(filteredSpike)).toBeLessThan(Math.abs(rawSpike));
  });
});

describe('output limiting', () => {
  it('clamps and says so', () => {
    const pid = make({ kp: 10, outputLimit: 0.2 });
    const step = pid.step(1, 1 / 60);

    expect(step.output).toBe(0.2);
    expect(step.saturated).toBe(true);
  });

  it('clamps symmetrically', () => {
    expect(make({ kp: 10, outputLimit: 0.2 }).step(-1, 1 / 60).output).toBe(-0.2);
  });

  it('does not report saturation when inside the limit', () => {
    expect(make({ kp: 1, outputLimit: 1 }).step(0.1, 1 / 60).saturated).toBe(false);
  });
});

describe('timing', () => {
  it('treats a zero interval as no time passing', () => {
    // Dividing by it would give an infinite derivative; skipping the whole step
    // would drop a real proportional correction.
    const pid = make({ kp: 0.5, ki: 10, kd: 1 });
    const step = pid.step(0.2, 0);

    expect(step.output).toBeCloseTo(0.1, 12);
    expect(step.integral).toBe(0);
    expect(step.derivative).toBe(0);
    expect(Number.isFinite(step.output)).toBe(true);
  });

  it('survives a negative or non-finite interval', () => {
    const pid = make({ kp: 0.5, ki: 10, kd: 1 });
    for (const dt of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const step = pid.step(0.2, dt);
      expect(Number.isFinite(step.output)).toBe(true);
      expect(step.output).toBeCloseTo(0.1, 12);
    }
  });
});

describe('reset', () => {
  it('clears the integral and the derivative history', () => {
    const pid = make({ kp: 0.5, ki: 5, kd: 1 });
    for (let k = 0; k < 20; k += 1) pid.step(0.3, 0.1);
    expect(pid.integralTerm).not.toBe(0);

    pid.reset();

    expect(pid.integralTerm).toBe(0);

    // The next step starts from nothing: its integral is exactly one step's
    // worth of contribution, and its derivative is zero because there is no
    // previous error to difference against.
    const fresh = pid.step(0.3, 0.1);
    expect(fresh.integral).toBeCloseTo(5 * 0.3 * 0.1, 12);
    expect(fresh.derivative).toBe(0);
  });
});

describe('over a long run', () => {
  it('stays finite under a varying error', () => {
    const pid = new PidController(DEFAULT_BASELINE_PAT_CONFIG.panPid);
    for (let k = 0; k < 100_000; k += 1) {
      const step = pid.step(Math.sin(k / 137) * 0.05, 1 / 60);
      expect(Number.isFinite(step.output)).toBe(true);
    }
    expect(Math.abs(pid.integralTerm)).toBeLessThanOrEqual(
      DEFAULT_BASELINE_PAT_CONFIG.panPid.integralLimit + 1e-12,
    );
  });

  it('converges on a first-order plant rather than oscillating', () => {
    // A crude stand-in for the mount: position moves a fixed fraction of the
    // way towards the command each step. With the shipped gains the loop must
    // settle, not ring.
    const pid = new PidController(DEFAULT_BASELINE_PAT_CONFIG.panPid);
    const target = 0.05;
    let position = 0;

    for (let k = 0; k < 400; k += 1) {
      const command = position + pid.step(target - position, 1 / 60).output;
      position += (command - position) * 0.25;
    }

    expect(position).toBeCloseTo(target, 3);
  });
});
