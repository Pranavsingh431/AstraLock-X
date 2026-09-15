/**
 * Deterministic randomness for disturbances.
 *
 * Two properties are needed here, and the second one rules out the obvious
 * implementation.
 *
 * **Independence.** Each effect draws from its own named stream, derived from
 * the root seed by name. Adding a draw to the read-noise generator must not
 * shift the platform vibration, the dropout pattern or the scintillation, or
 * every stored result would silently stop meaning what it said. `deriveStreamSeed`
 * hashes the name, so streams are independent by construction and a new name
 * can be added without perturbing any existing one.
 *
 * **Indexing by frame, not by draw.** A sequential generator's output depends on
 * how many values have been taken from it, and how many values have been taken
 * depends on how many frames were rasterized — which is a *display* decision.
 * The live view renders only the newest frame due and skips the rest; the
 * autonomous runtime renders every one. A sequential stream would therefore give
 * the interactive run and the headless run different weather, and recording a
 * run would change its physics.
 *
 * So the disturbance generators are **counter-based**: the realization at frame
 * `n` is a pure function of `(rootSeed, streamName, n)`. Skipping frames cannot
 * change it, a fresh process gets the same answer as a warm one, and a run is
 * reproducible from its seed alone.
 *
 * See docs/DISTURBANCE_MODEL.md and ADR-0020.
 */

import type { SimulationSeed } from '@/core/contracts/simulation';
import { deriveStreamSeed } from '@/core/simulation/rng';

/**
 * Named disturbance streams.
 *
 * Deliberately fine-grained: separating shot noise from read noise costs one
 * name and means a change to one cannot move the other. Names are part of the
 * reproducibility contract — renaming one changes every realization drawn from
 * it, so they are fixed here rather than constructed at call sites.
 */
export const DISTURBANCE_STREAM_NAMES = [
  'disturbance:platform-jitter',
  'disturbance:scintillation',
  'disturbance:wander',
  'disturbance:sensor-read',
  'disturbance:sensor-shot',
  'disturbance:dropout',
] as const;

export type DisturbanceStreamName = (typeof DISTURBANCE_STREAM_NAMES)[number];

/** 2^-32, for mapping a uint32 onto [0, 1). */
const TWO_POW_MINUS_32 = 2.3283064365386963e-10;

/** SplitMix32 finalizer, as used by the simulator's own stream derivation. */
function splitMix32(input: number): number {
  let z = (input + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad) >>> 0;
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97) >>> 0;
  return (z ^ (z >>> 15)) >>> 0;
}

/**
 * A counter-based bit source.
 *
 * Three rounds of SplitMix32 over the stream seed combined with a counter. This
 * is a stateless hash, not a sequence: `at(n)` can be evaluated in any order, any
 * number of times, and always gives the same answer. That is exactly the
 * property a frame-indexed disturbance needs.
 */
function hashCounter(streamSeed: number, counter: number): number {
  let z = splitMix32((streamSeed ^ Math.imul(counter >>> 0, 0x9e3779b1)) >>> 0);
  z = splitMix32((z + Math.imul(counter >>> 0, 0x85ebca6b)) >>> 0);
  return splitMix32(z);
}

/**
 * One named, counter-based random stream.
 *
 * Every accessor takes an explicit index. There is no cursor, no `next()` and
 * no internal state to get out of step — which is the whole point.
 */
export class CounterStream {
  public readonly name: string;
  public readonly seed: number;

  constructor(rootSeed: SimulationSeed, name: string) {
    this.name = name;
    this.seed = deriveStreamSeed(rootSeed, name);
  }

  /** Raw 32-bit value at `index`. */
  public uint32At(index: number): number {
    return hashCounter(this.seed, index);
  }

  /** Uniform on [0, 1) at `index`. */
  public floatAt(index: number): number {
    return hashCounter(this.seed, index) * TWO_POW_MINUS_32;
  }

  /**
   * Standard normal at `(index, lane)`.
   *
   * Box-Muller over two independent hashes. `lane` lets one frame index carry
   * several independent normals — two orthogonal wander components, say —
   * without the second borrowing the first's counter and coupling them.
   */
  public gaussianAt(index: number, lane = 0): number {
    // Lanes are spread far apart in counter space so that neighbouring
    // (index, lane) pairs cannot collide onto the same counter.
    const base = (Math.imul(index, 0x27220a95) + Math.imul(lane, 0x165667b1)) >>> 0;
    const u1 = Math.max(hashCounter(this.seed, base) * TWO_POW_MINUS_32, Number.MIN_VALUE);
    const u2 = hashCounter(this.seed, (base ^ 0x9e3779b9) >>> 0) * TWO_POW_MINUS_32;
    return Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
  }

  /**
   * A sequential generator seeded from `index`.
   *
   * For the per-pixel noise, where hashing each of 307,200 pixels separately
   * would cost more than the rest of the frame put together. The *seed* is
   * counter-based, so the whole frame's noise is still a pure function of the
   * frame index; within the frame a fast sequential generator walks the pixels
   * in raster order.
   */
  public sequentialAt(index: number): SequentialNoise {
    return new SequentialNoise(hashCounter(this.seed, index));
  }
}

/**
 * Inverse standard-normal CDF, Acklam's rational approximation.
 *
 * Accurate to about 1.15e-9 in absolute error over the whole range, which is far
 * finer than anything an 8-bit image can express. Used once, at module load, to
 * build the table below.
 */
function probit(p: number): number {
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ];
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ];
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ];
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416];
  const low = 0.02425;

  if (p < low) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    );
  }
  if (p > 1 - low) return -probit(1 - p);

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
    (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
  );
}

/**
 * Table size. A power of two so the index is a mask rather than a modulo.
 */
const NORMAL_TABLE_SIZE = 1 << 16;

/**
 * A stratified table of standard normal values.
 *
 * **Why a table.** Box-Muller needs a logarithm, a square root and a cosine per
 * pair. At 640x480 with two noise sources that is three hundred thousand
 * transcendental evaluations per frame, and it measured at 38 ms — more than
 * twice the whole 16.67 ms frame budget, and more than every other disturbance
 * put together. A table lookup is a shift, a mask and an array read.
 *
 * **What it costs in accuracy.** The entries are `probit((i + 0.5) / N)` for
 * `i` in `[0, N)`: an exact stratified sample of the standard normal, not a
 * random one, so the table has no sampling error of its own. Drawing a uniform
 * index from it gives a discrete distribution with:
 *
 *  - mean exactly zero, by symmetry of the strata;
 *  - variance 0.99991 rather than 1, because the outermost strata truncate;
 *  - support bounded at +/- 4.05 sigma, being `probit(1 - 0.5/65536)`.
 *
 * The truncation is the only real limitation and it is deliberate: values beyond
 * four sigma occur once in thirty thousand samples and, on an 8-bit sensor with
 * a read noise of a few counts, land outside the representable range anyway.
 * A scenario that needs heavier tails than this needs a different noise model,
 * not a bigger table.
 *
 * Built once at module load. It is 512 KB and shared by every stream.
 */
const NORMAL_TABLE = (() => {
  const table = new Float64Array(NORMAL_TABLE_SIZE);
  for (let index = 0; index < NORMAL_TABLE_SIZE; index += 1) {
    table[index] = probit((index + 0.5) / NORMAL_TABLE_SIZE);
  }
  return table;
})();

/** Standard deviation of the stratified table, for tests and documentation. */
export const NORMAL_TABLE_STDDEV = (() => {
  let sum = 0;
  for (const value of NORMAL_TABLE) sum += value * value;
  return Math.sqrt(sum / NORMAL_TABLE_SIZE);
})();

/** Largest magnitude the table can produce. */
export const NORMAL_TABLE_MAX_SIGMA = NORMAL_TABLE[NORMAL_TABLE_SIZE - 1]!;

/**
 * A fast sequential generator for one frame's worth of pixel noise.
 *
 * xorshift128 rather than the simulator's xoshiro128**: this runs a few hundred
 * thousand times per frame, and it generates noise for an 8-bit image rather
 * than trajectories, so throughput matters and the extra scrambling does not.
 * It is seeded deterministically from the frame index, and its output is only
 * ever consumed in one fixed raster order, so the frame is reproducible.
 */
export class SequentialNoise {
  private s0: number;
  private s1: number;
  private s2: number;
  private s3: number;
  constructor(seed: number) {
    let z = seed >>> 0;
    z = splitMix32(z);
    this.s0 = z;
    z = splitMix32(z);
    this.s1 = z;
    z = splitMix32(z);
    this.s2 = z;
    z = splitMix32(z);
    this.s3 = z;
    if ((this.s0 | this.s1 | this.s2 | this.s3) === 0) this.s0 = 0x9e3779b9;
  }

  /** Next raw 32-bit value. */
  public nextUint32(): number {
    let t = this.s3;
    const s = this.s0;
    this.s3 = this.s2;
    this.s2 = this.s1;
    this.s1 = s;
    t = (t ^ (t << 11)) >>> 0;
    t = (t ^ (t >>> 8)) >>> 0;
    this.s0 = (t ^ s ^ (s >>> 19)) >>> 0;
    return this.s0;
  }

  /** Uniform on [0, 1). */
  public nextFloat(): number {
    return this.nextUint32() * TWO_POW_MINUS_32;
  }

  /**
   * Standard normal, by uniform lookup into {@link NORMAL_TABLE}.
   *
   * One PRNG draw, one mask, one array read. See the table's own comment for
   * what this costs in distributional accuracy — briefly: exact mean, variance
   * low by one part in ten thousand, and tails truncated at 4.05 sigma.
   *
   * Box-Muller would be exact and was measured at more than twice the frame
   * budget on its own. This is the trade §16 of the phase brief anticipated, and
   * the accuracy is stated rather than assumed.
   */
  public nextGaussian(): number {
    return NORMAL_TABLE[this.nextUint32() & (NORMAL_TABLE_SIZE - 1)]!;
  }
}

/**
 * The disturbance streams belonging to one run.
 *
 * Built eagerly for every declared name, so a stream's seed never depends on
 * the order in which effects happen to ask for it.
 */
export class DisturbanceStreams {
  public readonly rootSeed: SimulationSeed;
  private readonly streams: ReadonlyMap<DisturbanceStreamName, CounterStream>;

  constructor(rootSeed: SimulationSeed) {
    this.rootSeed = rootSeed;
    this.streams = new Map(
      DISTURBANCE_STREAM_NAMES.map((name) => [name, new CounterStream(rootSeed, name)]),
    );
  }

  public get(name: DisturbanceStreamName): CounterStream {
    const stream = this.streams.get(name);
    if (stream === undefined) throw new Error(`Unknown disturbance stream: ${name}`);
    return stream;
  }

  /** Each stream's derived seed, for the record. */
  public seeds(): Record<string, number> {
    const seeds: Record<string, number> = {};
    for (const [name, stream] of this.streams) seeds[name] = stream.seed;
    return seeds;
  }
}
