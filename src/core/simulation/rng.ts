/**
 * Deterministic pseudo-randomness.
 *
 * Phase 0 specified the property and deferred the mechanism; this is the
 * mechanism. Every stochastic value in the simulator comes from here, and
 * `Math.random` is blocked by lint precisely so it cannot be used by accident.
 *
 * See docs/adr/0007-deterministic-prng-and-stream-derivation.md.
 */

import type { SimulationSeed } from '@/core/contracts/simulation';

/**
 * Named random streams.
 *
 * Each subsystem draws from its own stream, so adding a draw in one cannot
 * shift the sequence another sees. Without that, adding a noise source to the
 * camera would silently change every previously recorded trajectory, and no
 * stored result would mean anything afterwards.
 *
 * `sensor` and `disturbance` are reserved for Phase 2 and are declared now so
 * the derivation is fixed before anything depends on it — adding a stream name
 * later must not perturb the streams that already exist, and deriving each name
 * independently is what guarantees that.
 */
export const RANDOM_STREAM_NAMES = [
  'trajectory',
  'environment',
  'platform',
  'sensor',
  'disturbance',
] as const;

export type RandomStreamName = (typeof RANDOM_STREAM_NAMES)[number];

/** 2^-32, for mapping a uint32 onto [0, 1). */
const TWO_POW_MINUS_32 = 2.3283064365386963e-10;

/**
 * SplitMix32 finalizer.
 *
 * Used to decorrelate seeds, not to generate the sequence. Its avalanche
 * behaviour is what stops adjacent root seeds — 1000 and 1001, say — producing
 * visibly related runs.
 */
function splitMix32(input: number): number {
  let z = (input + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * FNV-1a, 32-bit, over the stream name.
 *
 * Stream names are ASCII identifiers fixed in this file, so hashing UTF-16 code
 * units is well defined for every name that can actually occur.
 */
function fnv1a32(name: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < name.length; index += 1) {
    hash = Math.imul(hash ^ name.charCodeAt(index), 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Derives a stream's seed from the root seed and the stream name.
 *
 * The root seed is mixed first, then combined with the name hash and mixed
 * again. Mixing after the combination matters: `rootSeed ^ nameHash` alone
 * would give correlated seeds to names whose hashes differ in few bits.
 */
export function deriveStreamSeed(rootSeed: SimulationSeed, streamName: string): number {
  return splitMix32(((splitMix32(rootSeed) ^ fnv1a32(streamName)) >>> 0) >>> 0);
}

/** Serializable position in a stream, for pause/resume and for replay. */
export interface RandomStreamSnapshot {
  readonly name: string;
  readonly seed: number;
  /** xoshiro128** state, four uint32 words. */
  readonly state: readonly [number, number, number, number];
  /** Draws taken since the stream was created or last reset. */
  readonly drawCount: number;
}

const rotl = (x: number, k: number): number => ((x << k) | (x >>> (32 - k))) >>> 0;

/**
 * xoshiro128**, by Blackman and Vigna.
 *
 * Chosen because it is a published, citable algorithm that needs only 32-bit
 * integer operations, which JavaScript can express exactly via `Math.imul` and
 * `>>>`. A generator built on float arithmetic would be at the mercy of
 * rounding; this one produces the identical bit sequence on any conforming
 * engine. Period is 2^128 - 1, far beyond any run this project will execute.
 *
 * The four-word state is expanded from the 32-bit stream seed with SplitMix32,
 * which is the seeding procedure the xoshiro authors recommend.
 */
export class RandomStream {
  public readonly name: string;
  public readonly seed: number;

  private readonly state = new Uint32Array(4);
  private draws = 0;

  constructor(name: string, seed: number) {
    this.name = name;
    this.seed = seed >>> 0;
    this.reset();
  }

  /** Returns the stream to its initial state, replaying the same sequence. */
  public reset(): void {
    let z = this.seed;
    for (let index = 0; index < 4; index += 1) {
      z = splitMix32(z);
      this.state[index] = z;
    }
    // An all-zero state is a fixed point of xoshiro. SplitMix32 makes it
    // vanishingly unlikely, but the generator would be silently dead if it
    // happened, so it is handled rather than assumed away.
    if ((this.state[0]! | this.state[1]! | this.state[2]! | this.state[3]!) === 0) {
      this.state[0] = 0x9e3779b9;
    }
    this.draws = 0;
  }

  /** Number of draws taken. Recorded in `WorldState.randomStreamCursors`. */
  public get drawCount(): number {
    return this.draws;
  }

  /** Next raw 32-bit output. */
  public nextUint32(): number {
    const s = this.state;
    const result = Math.imul(rotl(Math.imul(s[1]!, 5) >>> 0, 7), 9) >>> 0;

    const t = (s[1]! << 9) >>> 0;
    s[2] = (s[2]! ^ s[0]!) >>> 0;
    s[3] = (s[3]! ^ s[1]!) >>> 0;
    s[1] = (s[1]! ^ s[2]) >>> 0;
    s[0] = (s[0]! ^ s[3]) >>> 0;
    s[2] = (s[2] ^ t) >>> 0;
    s[3] = rotl(s[3], 11);

    this.draws += 1;
    return result;
  }

  /** Uniform on [0, 1). One draw. */
  public nextFloat(): number {
    return this.nextUint32() * TWO_POW_MINUS_32;
  }

  /** Uniform on [min, max). One draw. */
  public nextRange(min: number, max: number): number {
    return min + (max - min) * this.nextFloat();
  }

  /**
   * Uniform integer on [min, max]. One draw.
   *
   * @throws {RangeError} when the bounds are not integers, or are inverted.
   */
  public nextInt(min: number, max: number): number {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new RangeError(`nextInt bounds must be integers, received [${min}, ${max}]`);
    }
    if (max < min) {
      throw new RangeError(`nextInt bounds are inverted: [${min}, ${max}]`);
    }
    return min + Math.floor(this.nextFloat() * (max - min + 1));
  }

  /**
   * Standard normal, via Box-Muller. **Two** draws per value.
   *
   * The second variate is discarded rather than cached. Caching would halve the
   * cost but put a value outside the generator state, so a snapshot taken
   * between the two calls would not restore the same sequence. Correctness of
   * pause/resume is worth more here than the draws.
   */
  public nextGaussian(): number {
    // nextFloat() can return exactly 0, and log(0) is -Infinity.
    const u1 = Math.max(this.nextFloat(), Number.MIN_VALUE);
    const u2 = this.nextFloat();
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /** Captures the exact position in the sequence. */
  public snapshot(): RandomStreamSnapshot {
    return {
      name: this.name,
      seed: this.seed,
      state: [this.state[0]!, this.state[1]!, this.state[2]!, this.state[3]!],
      drawCount: this.draws,
    };
  }

  /**
   * Restores a captured position.
   *
   * @throws {Error} when the snapshot came from a different stream.
   */
  public restore(snapshot: RandomStreamSnapshot): void {
    if (snapshot.name !== this.name) {
      throw new Error(
        `Random stream snapshot is for "${snapshot.name}" but this stream is "${this.name}"`,
      );
    }
    for (let index = 0; index < 4; index += 1) {
      this.state[index] = snapshot.state[index]! >>> 0;
    }
    this.draws = snapshot.drawCount;
  }
}

/**
 * The set of streams belonging to one run.
 *
 * Streams are created eagerly for every declared name so that a stream's seed
 * never depends on the order in which subsystems happen to ask for it.
 */
export class RandomStreams {
  public readonly rootSeed: SimulationSeed;
  private readonly streams: ReadonlyMap<RandomStreamName, RandomStream>;

  constructor(rootSeed: SimulationSeed) {
    this.rootSeed = rootSeed;
    this.streams = new Map(
      RANDOM_STREAM_NAMES.map((name) => [
        name,
        new RandomStream(name, deriveStreamSeed(rootSeed, name)),
      ]),
    );
  }

  public get(name: RandomStreamName): RandomStream {
    const stream = this.streams.get(name);
    if (stream === undefined) {
      throw new Error(`Unknown random stream: ${name}`);
    }
    return stream;
  }

  /** Resets every stream, so the run replays from the beginning. */
  public reset(): void {
    for (const stream of this.streams.values()) stream.reset();
  }

  /** Draw counts by stream name, as `WorldState.randomStreamCursors` records them. */
  public cursors(): Record<string, number> {
    const cursors: Record<string, number> = {};
    for (const [name, stream] of this.streams) cursors[name] = stream.drawCount;
    return cursors;
  }

  /** Captures every stream's position. */
  public snapshot(): readonly RandomStreamSnapshot[] {
    return [...this.streams.values()].map((stream) => stream.snapshot());
  }

  /** Restores every stream from {@link snapshot}. */
  public restore(snapshots: readonly RandomStreamSnapshot[]): void {
    for (const snapshot of snapshots) {
      this.get(snapshot.name as RandomStreamName).restore(snapshot);
    }
  }
}
