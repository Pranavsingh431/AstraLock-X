import { describe, expect, it } from 'vitest';

import { simulationSeed } from '@/core/contracts/simulation';

import { RANDOM_STREAM_NAMES, RandomStream, RandomStreams, deriveStreamSeed } from './rng';

const take = (stream: RandomStream, count: number): number[] =>
  Array.from({ length: count }, () => stream.nextUint32());

describe('deriveStreamSeed', () => {
  it('is a pure function of the root seed and the stream name', () => {
    const seed = simulationSeed(4242);
    expect(deriveStreamSeed(seed, 'trajectory')).toBe(deriveStreamSeed(seed, 'trajectory'));
  });

  it('gives every declared stream a distinct seed', () => {
    const seed = simulationSeed(7);
    const derived = RANDOM_STREAM_NAMES.map((name) => deriveStreamSeed(seed, name));
    expect(new Set(derived).size).toBe(RANDOM_STREAM_NAMES.length);
  });

  it('decorrelates adjacent root seeds', () => {
    // Consecutive seeds are the common case — a sweep runs 1000, 1001, 1002.
    // Without mixing, those would produce visibly related runs.
    const a = deriveStreamSeed(simulationSeed(1000), 'trajectory');
    const b = deriveStreamSeed(simulationSeed(1001), 'trajectory');
    expect(a).not.toBe(b);

    let differingBits = 0;
    for (let bit = 0; bit < 32; bit += 1) {
      if (((a >>> bit) & 1) !== ((b >>> bit) & 1)) differingBits += 1;
    }
    expect(differingBits).toBeGreaterThan(6);
  });

  it('produces a uint32', () => {
    for (const name of RANDOM_STREAM_NAMES) {
      const derived = deriveStreamSeed(simulationSeed(123456), name);
      expect(Number.isInteger(derived)).toBe(true);
      expect(derived).toBeGreaterThanOrEqual(0);
      expect(derived).toBeLessThanOrEqual(0xffff_ffff);
    }
  });
});

describe('RandomStream', () => {
  it('replays the same sequence from the same seed', () => {
    const first = take(new RandomStream('trajectory', 99), 64);
    const second = take(new RandomStream('trajectory', 99), 64);
    expect(second).toEqual(first);
  });

  it('produces a different sequence from a different seed', () => {
    const a = take(new RandomStream('trajectory', 99), 32);
    const b = take(new RandomStream('trajectory', 100), 32);
    expect(b).not.toEqual(a);
  });

  it('emits uint32 values', () => {
    const stream = new RandomStream('trajectory', 5);
    for (const value of take(stream, 500)) {
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(0xffff_ffff);
    }
  });

  it('maps floats onto [0, 1)', () => {
    const stream = new RandomStream('trajectory', 11);
    for (let index = 0; index < 2000; index += 1) {
      const value = stream.nextFloat();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  it('returns to the start on reset', () => {
    const stream = new RandomStream('trajectory', 2024);
    const original = take(stream, 32);
    take(stream, 17);
    stream.reset();
    expect(take(stream, 32)).toEqual(original);
    expect(stream.drawCount).toBe(32);
  });

  it('counts draws, including the two a Gaussian consumes', () => {
    const stream = new RandomStream('trajectory', 3);
    stream.nextUint32();
    expect(stream.drawCount).toBe(1);
    stream.nextGaussian();
    expect(stream.drawCount).toBe(3);
  });

  it('restores an exact position from a snapshot', () => {
    const stream = new RandomStream('trajectory', 777);
    take(stream, 40);

    const snapshot = stream.snapshot();
    const expected = take(stream, 25);

    take(stream, 60);
    stream.restore(snapshot);

    expect(take(stream, 25)).toEqual(expected);
    expect(stream.drawCount).toBe(snapshot.drawCount + 25);
  });

  it('survives a serialization round trip', () => {
    // The snapshot has to cross a JSON boundary intact, since a saved run is
    // reloaded from a file.
    const stream = new RandomStream('trajectory', 31337);
    take(stream, 13);

    const revived: unknown = JSON.parse(JSON.stringify(stream.snapshot()));
    const expected = take(stream, 20);

    const other = new RandomStream('trajectory', 31337);
    other.restore(revived as ReturnType<RandomStream['snapshot']>);
    expect(take(other, 20)).toEqual(expected);
  });

  it('refuses a snapshot belonging to another stream', () => {
    const trajectory = new RandomStream('trajectory', 1);
    const sensor = new RandomStream('sensor', 1);
    expect(() => trajectory.restore(sensor.snapshot())).toThrow(/sensor/);
  });

  it('produces a plausible standard normal', () => {
    const stream = new RandomStream('trajectory', 8675309);
    const samples = Array.from({ length: 20000 }, () => stream.nextGaussian());
    const mean = samples.reduce((sum, value) => sum + value, 0) / samples.length;
    const variance =
      samples.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (samples.length - 1);

    expect(Math.abs(mean)).toBeLessThan(0.05);
    expect(variance).toBeGreaterThan(0.9);
    expect(variance).toBeLessThan(1.1);
    expect(samples.every(Number.isFinite)).toBe(true);
  });

  it('rejects invalid integer bounds rather than guessing', () => {
    const stream = new RandomStream('trajectory', 1);
    expect(() => stream.nextInt(5, 1)).toThrow(RangeError);
    expect(() => stream.nextInt(0.5, 3)).toThrow(RangeError);
  });
});

describe('RandomStreams', () => {
  it('gives each subsystem an independent sequence', () => {
    const streams = new RandomStreams(simulationSeed(555));
    const trajectory = take(streams.get('trajectory'), 24);
    const environment = take(streams.get('environment'), 24);
    expect(environment).not.toEqual(trajectory);
  });

  it('keeps one stream unaffected by draws taken from another', () => {
    // This is the property the whole design exists for: adding a noise source
    // to one subsystem must not silently rewrite every recorded run of another.
    const seed = simulationSeed(31415);

    const baseline = new RandomStreams(seed);
    const expected = take(baseline.get('sensor'), 32);

    const perturbed = new RandomStreams(seed);
    take(perturbed.get('trajectory'), 1000);
    take(perturbed.get('environment'), 97);
    take(perturbed.get('platform'), 5);

    expect(take(perturbed.get('sensor'), 32)).toEqual(expected);
  });

  it('reports draw counts per stream', () => {
    const streams = new RandomStreams(simulationSeed(1));
    take(streams.get('trajectory'), 7);
    take(streams.get('sensor'), 3);

    const cursors = streams.cursors();
    expect(cursors['trajectory']).toBe(7);
    expect(cursors['sensor']).toBe(3);
    expect(cursors['disturbance']).toBe(0);
  });

  it('replays every stream after reset', () => {
    const streams = new RandomStreams(simulationSeed(9090));
    const expected = take(streams.get('trajectory'), 16);
    take(streams.get('trajectory'), 40);

    streams.reset();
    expect(take(streams.get('trajectory'), 16)).toEqual(expected);
  });

  it('restores every stream from a captured snapshot', () => {
    const streams = new RandomStreams(simulationSeed(4711));
    take(streams.get('trajectory'), 11);
    take(streams.get('environment'), 6);

    const snapshot = streams.snapshot();
    const expected = take(streams.get('trajectory'), 10);

    take(streams.get('trajectory'), 500);
    streams.restore(snapshot);

    expect(take(streams.get('trajectory'), 10)).toEqual(expected);
  });
});
