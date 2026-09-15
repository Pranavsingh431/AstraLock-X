// @vitest-environment node
/**
 * The stochastic processes, checked against their own definitions.
 *
 * A correlated noise process is easy to get wrong in ways that still look
 * plausible on a plot: the wrong discretisation gives a variance that depends
 * on the step size, a missing stationary start gives a run that is quieter than
 * configured for its first few seconds, and a sequential generator gives a
 * different realization depending on how the caller stepped it. Each of those
 * is checked here against a number derivable from the configuration.
 *
 * Statistical assertions are over large deterministic samples with tolerances
 * chosen to pass comfortably for the fixed seeds used, rather than tight bounds
 * that would turn CI into a dice roll.
 */

import { describe, expect, it } from 'vitest';

import type { SimulationSeed } from '@/core/contracts/simulation';

import { BurstChain, OrnsteinUhlenbeck, toneSum } from './processes';
import { CounterStream, DisturbanceStreams } from './streams';

const seed = (value: number): SimulationSeed => value as SimulationSeed;

const stream = (name = 'disturbance:wander', root = 4242): CounterStream =>
  new CounterStream(seed(root), name);

/** Mean and standard deviation of a sample. */
function moments(values: readonly number[]): { mean: number; sd: number } {
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  const variance =
    values.reduce((sum, value) => sum + (value - mean) * (value - mean), 0) / values.length;
  return { mean, sd: Math.sqrt(variance) };
}

/** Lag-1 autocorrelation of a sample. */
function lag1(values: readonly number[]): number {
  const { mean } = moments(values);
  let numerator = 0;
  let denominator = 0;
  for (let index = 0; index < values.length; index += 1) {
    const centred = values[index]! - mean;
    denominator += centred * centred;
    if (index > 0) numerator += centred * (values[index - 1]! - mean);
  }
  return denominator === 0 ? 0 : numerator / denominator;
}

const walk = (process: OrnsteinUhlenbeck, count: number): number[] =>
  Array.from({ length: count }, (_, index) => process.valueAt(index));

describe('the Ornstein-Uhlenbeck process', () => {
  it('has the stationary standard deviation it was configured with', () => {
    const values = walk(new OrnsteinUhlenbeck(stream(), 1 / 60, 0.5, 2e-4), 20_000);
    const { mean, sd } = moments(values);

    expect(Math.abs(mean)).toBeLessThan(2e-5);
    expect(sd).toBeGreaterThan(1.6e-4);
    expect(sd).toBeLessThan(2.4e-4);
  });

  // The whole reason for the exact discretisation. With Euler stepping the
  // variance would fall with the step size, and a scenario's measured RMS would
  // silently depend on the frame rate it was run at.
  it('keeps that standard deviation when the step size changes', () => {
    const coarse = moments(walk(new OrnsteinUhlenbeck(stream(), 1 / 30, 0.5, 1e-3), 20_000)).sd;
    const fine = moments(walk(new OrnsteinUhlenbeck(stream(), 1 / 240, 0.5, 1e-3), 20_000)).sd;

    expect(coarse).toBeGreaterThan(0.8e-3);
    expect(coarse).toBeLessThan(1.2e-3);
    expect(fine).toBeGreaterThan(0.8e-3);
    expect(fine).toBeLessThan(1.2e-3);
  });

  it('correlates more strongly the longer its correlation time', () => {
    const fast = lag1(walk(new OrnsteinUhlenbeck(stream(), 1 / 60, 0.02, 1), 20_000));
    const slow = lag1(walk(new OrnsteinUhlenbeck(stream(), 1 / 60, 2, 1), 20_000));

    // exp(-dt/tau) is 0.43 for tau = 20 ms and 0.99 for tau = 2 s at 60 fps.
    expect(fast).toBeGreaterThan(0.3);
    expect(fast).toBeLessThan(0.6);
    expect(slow).toBeGreaterThan(0.95);
  });

  // This is what makes a realization a function of the frame index rather than
  // of how many frames the caller happened to render. The live view skips
  // frames; the headless runtime does not. They must see the same weather.
  it('gives the same value whether it was stepped or fast-forwarded', () => {
    const stepped = new OrnsteinUhlenbeck(stream(), 1 / 60, 0.3, 1e-3);
    for (let index = 0; index <= 500; index += 1) stepped.valueAt(index);

    const jumped = new OrnsteinUhlenbeck(stream(), 1 / 60, 0.3, 1e-3);
    expect(jumped.valueAt(500)).toBe(stepped.valueAt(500));
  });

  it('gives the same value when frames are skipped irregularly', () => {
    const dense = new OrnsteinUhlenbeck(stream(), 1 / 60, 0.3, 1e-3);
    for (let index = 0; index <= 300; index += 1) dense.valueAt(index);

    const sparse = new OrnsteinUhlenbeck(stream(), 1 / 60, 0.3, 1e-3);
    for (const index of [7, 8, 93, 220, 300]) sparse.valueAt(index);

    expect(sparse.valueAt(300)).toBe(dense.valueAt(300));
  });

  // Starting at zero would give every run a transient of several correlation
  // times during which the disturbance is weaker than the scenario asked for.
  it('starts in its stationary distribution rather than at zero', () => {
    const firsts = Array.from({ length: 400 }, (_, run) =>
      new OrnsteinUhlenbeck(stream('disturbance:wander', 1000 + run), 1 / 60, 5, 1).valueAt(0),
    );
    const { sd } = moments(firsts);
    expect(sd).toBeGreaterThan(0.8);
    expect(sd).toBeLessThan(1.25);
  });

  it('replays the same realization after a reset', () => {
    const process = new OrnsteinUhlenbeck(stream(), 1 / 60, 0.3, 1e-3);
    const first = walk(process, 50);
    process.reset();
    expect(walk(process, 50)).toEqual(first);
  });

  // Purity over caching. The sensor and the evaluator both walk the same run and
  // need not be in step; a process that refused to go back would make them
  // coordinate, and one that guessed would let them disagree.
  it('replays exactly when asked for an index it has already passed', () => {
    const process = new OrnsteinUhlenbeck(stream(), 1 / 60, 0.3, 1e-3);
    const forwards = Array.from({ length: 120 }, (_, index) => process.valueAt(index));

    expect(process.valueAt(40)).toBe(forwards[40]);
    expect(process.valueAt(119)).toBe(forwards[119]);
    expect(process.valueAt(0)).toBe(forwards[0]);
  });

  it('refuses an index that is not a non-negative integer', () => {
    const process = new OrnsteinUhlenbeck(stream(), 1 / 60, 0.3, 1e-3);
    expect(() => process.valueAt(-1)).toThrow(RangeError);
    expect(() => process.valueAt(1.5)).toThrow(RangeError);
  });

  it.each([0, -1, 1 / 3])('refuses a step or correlation time of %s', (bad) => {
    expect(
      () => new OrnsteinUhlenbeck(stream(), bad <= 0 ? bad : 1 / 60, bad <= 0 ? 1 : 0, 1),
    ).toThrow(RangeError);
  });
});

describe('tone sums', () => {
  it('is zero at t = 0 for zero phase, and peaks a quarter period later', () => {
    const tones = [{ amplitude: 3, frequency: 2, phase: 0 }];
    expect(toneSum(tones, 0)).toBeCloseTo(0, 12);
    expect(toneSum(tones, 0.125)).toBeCloseTo(3, 12);
  });

  it('adds several components', () => {
    const tones = [
      { amplitude: 1, frequency: 1, phase: Math.PI / 2 },
      { amplitude: 2, frequency: 3, phase: Math.PI / 2 },
    ];
    expect(toneSum(tones, 0)).toBeCloseTo(3, 12);
  });

  it('is exactly periodic, with no accumulated drift', () => {
    const tones = [{ amplitude: 1, frequency: 5, phase: 0.3 }];
    expect(toneSum(tones, 1000)).toBeCloseTo(toneSum(tones, 1000.2), 9);
  });

  it('is zero with no tones', () => {
    expect(toneSum([], 12.5)).toBe(0);
  });
});

describe('the burst dropout chain', () => {
  it('drops about the fraction of frames its dwell times imply', () => {
    const chain = new BurstChain(stream('disturbance:dropout'), 90, 10);
    let bad = 0;
    for (let index = 0; index < 60_000; index += 1) if (chain.isBadAt(index)) bad += 1;

    // Stationary bad fraction is meanBad / (meanGood + meanBad) = 0.1.
    expect(bad / 60_000).toBeGreaterThan(0.07);
    expect(bad / 60_000).toBeLessThan(0.13);
  });

  it('loses frames in runs rather than singly', () => {
    const chain = new BurstChain(stream('disturbance:dropout'), 90, 10);
    let runs = 0;
    let bad = 0;
    let previous = false;
    for (let index = 0; index < 60_000; index += 1) {
      const isBad = chain.isBadAt(index);
      if (isBad) {
        bad += 1;
        if (!previous) runs += 1;
      }
      previous = isBad;
    }
    // Mean run length should be near the configured 10 frames; independent
    // drops at the same rate would average 1.
    expect(bad / runs).toBeGreaterThan(5);
  });

  it('is reproducible and fast-forwardable like the other processes', () => {
    const stepped = new BurstChain(stream('disturbance:dropout'), 50, 5);
    for (let index = 0; index <= 900; index += 1) stepped.isBadAt(index);

    const jumped = new BurstChain(stream('disturbance:dropout'), 50, 5);
    expect(jumped.isBadAt(900)).toBe(stepped.isBadAt(900));
  });

  it.each([0, -3])('refuses a mean dwell of %s', (bad) => {
    expect(() => new BurstChain(stream(), bad, 5)).toThrow(RangeError);
    expect(() => new BurstChain(stream(), 5, bad)).toThrow(RangeError);
  });
});

describe('stream independence', () => {
  // The property the whole design exists for: changing one effect must not
  // move any other. Streams are derived by hashing their names, so they are
  // independent by construction — this checks the construction.
  it('gives every named stream a different seed', () => {
    const streams = new DisturbanceStreams(seed(7));
    const seeds = Object.values(streams.seeds());
    expect(new Set(seeds).size).toBe(seeds.length);
  });

  it('gives unrelated values at the same index across streams', () => {
    const streams = new DisturbanceStreams(seed(7));
    const read = streams.get('disturbance:sensor-read');
    const shot = streams.get('disturbance:sensor-shot');

    let matches = 0;
    for (let index = 0; index < 5000; index += 1) {
      if (read.uint32At(index) === shot.uint32At(index)) matches += 1;
    }
    expect(matches).toBe(0);
  });

  it('changes every stream when the root seed changes', () => {
    const a = new DisturbanceStreams(seed(1)).seeds();
    const b = new DisturbanceStreams(seed(2)).seeds();
    for (const name of Object.keys(a)) expect(a[name]).not.toBe(b[name]);
  });

  it('produces normals with the right moments', () => {
    const source = stream();
    const values = Array.from({ length: 40_000 }, (_, index) => source.gaussianAt(index));
    const { mean, sd } = moments(values);
    expect(Math.abs(mean)).toBeLessThan(0.02);
    expect(sd).toBeGreaterThan(0.97);
    expect(sd).toBeLessThan(1.03);
  });

  it('keeps lanes of one stream independent', () => {
    const source = stream();
    const first = Array.from({ length: 20_000 }, (_, index) => source.gaussianAt(index, 0));
    const second = Array.from({ length: 20_000 }, (_, index) => source.gaussianAt(index, 1));

    const a = moments(first);
    const b = moments(second);
    let covariance = 0;
    for (let index = 0; index < first.length; index += 1) {
      covariance += (first[index]! - a.mean) * (second[index]! - b.mean);
    }
    const correlation = covariance / first.length / (a.sd * b.sd);
    expect(Math.abs(correlation)).toBeLessThan(0.03);
  });

  it('is a pure function of the index, evaluable in any order', () => {
    const source = stream();
    const forwards = Array.from({ length: 100 }, (_, index) => source.floatAt(index));
    const backwards: number[] = [];
    for (let index = 99; index >= 0; index -= 1) backwards.unshift(source.floatAt(index));
    expect(backwards).toEqual(forwards);
  });
});

describe('the per-frame sequential noise generator', () => {
  it('produces standard normals', () => {
    const noise = stream('disturbance:sensor-read').sequentialAt(17);
    const values = Array.from({ length: 200_000 }, () => noise.nextGaussian());
    const { mean, sd } = moments(values);
    expect(Math.abs(mean)).toBeLessThan(0.01);
    expect(sd).toBeGreaterThan(0.99);
    expect(sd).toBeLessThan(1.01);
  });

  it('gives each frame its own field, reproducibly', () => {
    const source = stream('disturbance:sensor-read');
    const first = Array.from({ length: 64 }, () => source.sequentialAt(5).nextGaussian());
    const again = Array.from({ length: 64 }, () => source.sequentialAt(5).nextGaussian());
    const other = source.sequentialAt(6).nextGaussian();

    expect(again).toEqual(first);
    expect(other).not.toBe(first[0]);
  });

  it('never produces a non-finite value', () => {
    const noise = stream().sequentialAt(3);
    let nonFinite = 0;
    for (let index = 0; index < 100_000; index += 1) {
      if (!Number.isFinite(noise.nextGaussian())) nonFinite += 1;
    }
    expect(nonFinite).toBe(0);
  });
});
