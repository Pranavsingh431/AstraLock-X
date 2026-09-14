/**
 * The IMM estimator on synthetic bearing streams, independent of the simulator.
 *
 * Behavioural assertions only: which model's probability rises, which way, and
 * that the numbers stay finite and consistent. No exact probability is asserted
 * because none is analytically fixed by these inputs.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_ASTRALOCK_CONFIG } from './config';
import { ImmEstimator, STATE_SIZE, transitionProbabilities } from './imm';
import type { Matrix } from './matrix';

const CONFIG = DEFAULT_ASTRALOCK_CONFIG.imm;
const DT = 1 / 60;

/** Deterministic standard normal draws (xorshift + Box–Muller). */
function normal(seed: number): () => number {
  let s = seed >>> 0 || 1;
  const uniform = (): number => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return (s + 0.5) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(uniform())) * Math.cos(2 * Math.PI * uniform());
}

interface Run {
  readonly imm: ImmEstimator;
  readonly ncaProbability: number[];
  readonly times: number[];
}

/** Feeds a bearing function sampled every dt, with measurement noise. */
function run(
  bearing: (t: number) => [number, number],
  seconds: number,
  options: { dt?: (k: number) => number; skip?: (t: number) => boolean; seed?: number } = {},
): Run {
  const imm = new ImmEstimator(CONFIG);
  const noise = normal(options.seed ?? 7);
  const sigma = CONFIG.measurementNoiseStdDev;
  const ncaProbability: number[] = [];
  const times: number[] = [];
  let t = 0;
  let k = 0;
  const [a0, e0] = bearing(0);
  imm.initialise(a0, e0, 0);
  while (t < seconds) {
    t += options.dt?.(k) ?? DT;
    k += 1;
    const prediction = imm.predict(t);
    if (options.skip?.(t) === true) {
      imm.applyNoMeasurement(prediction);
    } else {
      const [az, el] = bearing(t);
      imm.applyMeasurement(prediction, az + sigma * noise(), el + sigma * noise());
    }
    const probabilities = imm.estimate().modelProbabilities;
    expect(probabilities[0]! + probabilities[1]!).toBeCloseTo(1, 12);
    ncaProbability.push(probabilities[1]!);
    times.push(t);
  }
  return { imm, ncaProbability, times };
}

const meanOver = (r: Run, from: number, to: number): number => {
  const values = r.ncaProbability.filter((_, i) => r.times[i]! >= from && r.times[i]! < to);
  return values.reduce((a, b) => a + b, 0) / values.length;
};

function expectHealthyCovariance(P: Matrix): void {
  expect(P.length).toBe(STATE_SIZE);
  for (let i = 0; i < STATE_SIZE; i += 1) {
    for (let j = 0; j < STATE_SIZE; j += 1) {
      expect(Number.isFinite(P[i]![j]!)).toBe(true);
      expect(Math.abs(P[i]![j]! - P[j]![i]!)).toBeLessThanOrEqual(
        1e-12 * (Math.abs(P[i]![j]!) + 1e-30),
      );
    }
    expect(P[i]![i]!).toBeGreaterThanOrEqual(0);
  }
  // Positive semidefinite within tolerance: a Cholesky factorisation of
  // P + εI must exist.
  const n = STATE_SIZE;
  const L: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const eps = 1e-18;
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j <= i; j += 1) {
      let sum = P[i]![j]! + (i === j ? eps : 0);
      for (let k = 0; k < j; k += 1) sum -= L[i]![k]! * L[j]![k]!;
      if (i === j) {
        expect(sum).toBeGreaterThan(0);
        L[i]![i] = Math.sqrt(sum);
      } else {
        L[i]![j] = sum / L[j]![j]!;
      }
    }
  }
}

describe('model transition probabilities', () => {
  it('are a stochastic matrix, and scale with the interval', () => {
    const p = transitionProbabilities(CONFIG, DT);
    expect(p[0]![0]! + p[0]![1]!).toBeCloseTo(1, 15);
    expect(p[1]![0]! + p[1]![1]!).toBeCloseTo(1, 15);
    expect(p[0]![0]).toBeCloseTo(CONFIG.stayNcv, 12);
    // Twice the interval: staying twice in a row.
    expect(transitionProbabilities(CONFIG, 2 * DT)[0]![0]).toBeCloseTo(CONFIG.stayNcv ** 2, 12);
    expect(transitionProbabilities(CONFIG, 0)[0]![0]).toBe(1);
  });
});

describe('model probabilities follow the motion', () => {
  it('A. stationary target: the velocity model is preferred', () => {
    const r = run(() => [0.3, 0.05], 4);
    expect(meanOver(r, 2, 4)).toBeLessThan(0.5);
    const e = r.imm.estimate();
    expect(e.state[0]).toBeCloseTo(0.3, 3);
    expect(Math.abs(e.state[2]!)).toBeLessThan(5e-3);
  });

  it('B. constant angular rate: the velocity model is preferred and the rate is estimated', () => {
    const r = run((t) => [0.02 * t, 0.05 - 0.01 * t], 5);
    expect(meanOver(r, 3, 5)).toBeLessThan(0.5);
    const e = r.imm.estimate();
    expect(e.state[2]).toBeCloseTo(0.02, 2);
    expect(e.state[3]).toBeCloseTo(-0.01, 2);
  });

  it('C. constant angular acceleration: the acceleration model rises materially', () => {
    const cv = run((t) => [0.02 * t, 0.05], 5);
    const ca = run((t) => [0.02 * t + 0.5 * 0.08 * t * t, 0.05], 5);
    expect(meanOver(ca, 3, 5)).toBeGreaterThan(0.5);
    expect(meanOver(ca, 3, 5)).toBeGreaterThan(meanOver(cv, 3, 5) + 0.3);
    // The fused acceleration is probability-weighted (NCV holds it at zero); the
    // acceleration model's own state is the one that should find 0.08.
    expect(ca.imm.modelStates()[1]!.state[4]).toBeCloseTo(0.08, 1);
  });

  it('D. manoeuvre transition: acceleration model rises during the manoeuvre and falls after', () => {
    // Constant rate, then 2 s at 0.1 rad/s², then constant rate again.
    const bearing = (t: number): [number, number] => {
      const a = 0.1;
      if (t < 3) return [0.01 * t, 0];
      if (t < 5) return [0.03 + 0.01 * (t - 3) + 0.5 * a * (t - 3) ** 2, 0];
      const v = 0.01 + a * 2;
      return [0.03 + 0.02 + 0.2 + v * (t - 5), 0];
    };
    const r = run(bearing, 9);
    const before = meanOver(r, 2, 3);
    const during = meanOver(r, 3.5, 5);
    const after = meanOver(r, 7, 9);
    expect(during).toBeGreaterThan(before + 0.3);
    expect(after).toBeLessThan(during - 0.3);
  });

  it('D. the response is direction-independent: the mirror-image manoeuvre behaves the same', () => {
    const plus = run((t) => [0.5 * 0.08 * t * t, 0], 4, { seed: 11 });
    const minus = run((t) => [-0.5 * 0.08 * t * t, 0], 4, { seed: 11 });
    const elevation = run((t) => [0, 0.5 * 0.08 * t * t], 4, { seed: 11 });
    for (const r of [plus, minus, elevation]) expect(meanOver(r, 2.5, 4)).toBeGreaterThan(0.5);
  });
});

describe('robustness', () => {
  it('E. irregular intervals: rate still estimated, probabilities finite', () => {
    const r = run((t) => [0.03 * t, 0], 5, { dt: (k) => (k % 3 === 0 ? 0.025 : 0.01) });
    expect(r.imm.estimate().state[2]).toBeCloseTo(0.03, 2);
    expectHealthyCovariance(r.imm.estimate().covariance);
  });

  it('F. missing measurements: uncertainty grows through the gap and the track re-converges', () => {
    const imm = new ImmEstimator(CONFIG);
    imm.initialise(0, 0, 0);
    let t = 0;
    for (let k = 0; k < 180; k += 1) {
      t += DT;
      imm.applyMeasurement(imm.predict(t), 0.02 * t, 0);
    }
    const before = ImmEstimator.angularSigma(imm.estimate().covariance);
    const beforeProbabilities = imm.estimate().modelProbabilities;
    for (let k = 0; k < 30; k += 1) {
      t += DT;
      imm.applyNoMeasurement(imm.predict(t));
    }
    const during = ImmEstimator.angularSigma(imm.estimate().covariance);
    expect(during).toBeGreaterThan(before * 2);
    // With no evidence, probabilities follow the Markov chain toward its stationary
    // mix, π_nca = (1 − p_vv) / ((1 − p_vv) + (1 − p_aa)).
    const stationary = (1 - CONFIG.stayNcv) / (1 - CONFIG.stayNcv + (1 - CONFIG.stayNca));
    expect(Math.abs(imm.estimate().modelProbabilities[1]! - stationary)).toBeLessThanOrEqual(
      Math.abs(beforeProbabilities[1]! - stationary) + 1e-12,
    );
    // The coasted prediction kept moving with the estimated rate.
    expect(imm.estimate().state[0]).toBeCloseTo(0.02 * t, 3);
    for (let k = 0; k < 60; k += 1) {
      t += DT;
      imm.applyMeasurement(imm.predict(t), 0.02 * t, 0);
    }
    expect(ImmEstimator.angularSigma(imm.estimate().covariance)).toBeLessThan(during);
  });

  it('G. reset returns to the uninitialised state', () => {
    const imm = new ImmEstimator(CONFIG);
    imm.initialise(0.1, 0.1, 1);
    imm.reset();
    expect(imm.isInitialised).toBe(false);
    expect(() => imm.predict(2)).toThrow();
    imm.initialise(0.2, 0, 3);
    expect(imm.estimate().state[0]).toBeCloseTo(0.2, 14);
  });

  it('H. azimuth crossing ±π: small innovations, correct rate, wrapped state', () => {
    const wrap = (a: number): number => Math.atan2(Math.sin(a), Math.cos(a));
    const r = run((t) => [wrap(Math.PI - 0.1 + 0.1 * t), 0], 3);
    const e = r.imm.estimate();
    expect(e.state[2]).toBeCloseTo(0.1, 2);
    expect(Math.abs(e.state[0]!)).toBeLessThanOrEqual(Math.PI);
    expect(
      Math.abs(
        Math.atan2(
          Math.sin(e.state[0]! - wrap(Math.PI + 0.2)),
          Math.cos(e.state[0]! - wrap(Math.PI + 0.2)),
        ),
      ),
    ).toBeLessThan(2e-3);
    // A gate on the next measurement across the cut is consistent, not 2π away.
    const next = r.imm.predict(3 + DT);
    expect(r.imm.gate(next, wrap(Math.PI + 0.2 + 0.1 * DT), 0)!.nis).toBeLessThan(20);
  });

  it('I and L. covariances stay symmetric, finite, positive semidefinite; probabilities sum to one', () => {
    const r = run((t) => [0.2 * Math.sin(0.7 * t), 0.05 * Math.cos(0.4 * t)], 10);
    expectHealthyCovariance(r.imm.estimate().covariance);
    for (const model of r.imm.modelStates()) expectHealthyCovariance(model.covariance);
  });

  it('J. long run: no NaN, no drift in the probability sum', () => {
    const r = run(
      (t) => [
        0.3 * Math.sin(0.2 * t) + (t > 30 ? 0.01 * (t - 30) ** 2 : 0),
        0.1 * Math.sin(0.13 * t),
      ],
      60,
      { skip: (t) => t % 10 > 9.6 },
    );
    const e = r.imm.estimate();
    expect(e.state.every(Number.isFinite)).toBe(true);
    expect(r.ncaProbability.every((p) => p > 0 && p < 1)).toBe(true);
    expectHealthyCovariance(e.covariance);
  });

  it('K. fused covariance includes the spread between models', () => {
    // Right after an acceleration onset the two models disagree about rate.
    const r = run((t) => [t < 2 ? 0 : 0.5 * 0.2 * (t - 2) ** 2, 0], 2.4);
    const e = r.imm.estimate();
    const models = r.imm.modelStates();
    const mu = e.modelProbabilities;
    const withinOnly =
      mu[0]! * models[0]!.covariance[2]![2]! + mu[1]! * models[1]!.covariance[2]![2]!;
    const rateSpread =
      mu[0]! * (models[0]!.state[2]! - e.state[2]!) ** 2 +
      mu[1]! * (models[1]!.state[2]! - e.state[2]!) ** 2;
    expect(Math.abs(models[0]!.state[2]! - models[1]!.state[2]!)).toBeGreaterThan(0);
    expect(e.covariance[2]![2]).toBeCloseTo(withinOnly + rateSpread, 15);
    expect(e.covariance[2]![2]!).toBeGreaterThan(withinOnly);
  });
});
