/**
 * Correlated stochastic processes.
 *
 * Every random disturbance in this system is *coloured*: it has a correlation
 * time, and its value at one instant is related to its value at the last one.
 * That is not a refinement, it is the difference between a model and an
 * artefact. Independent draws every frame would have infinite bandwidth, so a
 * platform "vibration" built that way would ask the mount to follow a signal
 * with unbounded acceleration, and a "scintillation" built that way would be
 * rejected by any temporal filter as obviously non-physical.
 *
 * The process used throughout is Ornstein-Uhlenbeck, integrated **exactly**
 * rather than by Euler stepping:
 *
 * ```
 *   a      = exp(-dt / tau)
 *   X(t+dt) = a * X(t) + sqrt(1 - a^2) * sigma * N(0, 1)
 * ```
 *
 * The exact form matters. Euler-Maruyama would make the stationary variance
 * depend on the step size, so a scenario's measured RMS would quietly change
 * with the frame rate. With the form above the stationary distribution is
 * exactly `N(0, sigma^2)` at every step size, which is what lets a configured
 * RMS be checked against a measured one.
 *
 * See docs/DISTURBANCE_MODEL.md.
 */

import type { CounterStream } from './streams';

/**
 * An Ornstein-Uhlenbeck process evaluated on a fixed index grid.
 *
 * The grid is what makes the realization independent of how a caller steps
 * through it. `valueAt(n)` walks forward from whatever index the process last
 * reached, taking each intermediate step, so asking for frames 0, 1, 2, 3 and
 * asking only for frame 3 give the same answer at frame 3. Since the driving
 * normals are counter-based rather than sequential, a process constructed fresh
 * and fast-forwarded reproduces one that was stepped all along.
 *
 * Asking for an index already passed is answered by replaying from the start.
 * That costs O(index) rather than O(1), and it is the right trade: the process
 * stays a *pure function of the index*, so two consumers walking the same run at
 * different rates — the sensor rendering frames and the evaluator scoring them —
 * cannot disagree about the weather. A cached partial process that threw
 * instead would push that coordination problem onto every caller.
 */
export class OrnsteinUhlenbeck {
  private readonly stream: CounterStream;
  private readonly lane: number;
  private readonly sigma: number;
  /** Retention factor per grid step, `exp(-dt / tau)`. */
  private readonly retention: number;
  /** Innovation scale per grid step, `sqrt(1 - retention^2) * sigma`. */
  private readonly innovation: number;

  private index = -1;
  private current = 0;

  /**
   * @param stepSeconds spacing of the index grid
   * @param correlationTime 1/e decay time; must be positive
   * @param sigma stationary standard deviation
   * @param lane distinguishes independent processes drawing from one stream
   * @throws {RangeError} when the step or correlation time is not positive
   */
  constructor(
    stream: CounterStream,
    stepSeconds: number,
    correlationTime: number,
    sigma: number,
    lane = 0,
  ) {
    if (!(stepSeconds > 0)) {
      throw new RangeError(`Process step must be positive, received ${String(stepSeconds)}`);
    }
    if (!(correlationTime > 0)) {
      throw new RangeError(
        `Correlation time must be positive, received ${String(correlationTime)}`,
      );
    }
    this.stream = stream;
    this.lane = lane;
    this.sigma = sigma;
    this.retention = Math.exp(-stepSeconds / correlationTime);
    this.innovation = Math.sqrt(Math.max(0, 1 - this.retention * this.retention)) * sigma;
  }

  /**
   * The process value at grid index `index`.
   *
   * @throws {RangeError} when the index is not a non-negative integer.
   */
  public valueAt(index: number): number {
    if (!Number.isInteger(index) || index < 0) {
      throw new RangeError(
        `Process index must be a non-negative integer, received ${String(index)}`,
      );
    }
    // Replay rather than refuse. The realization is fixed by the seed, so going
    // back gives exactly the value that index had the first time.
    if (index < this.index) this.reset();

    if (this.index < 0) {
      // Start in the stationary distribution rather than at zero. Starting at
      // zero would give every run a transient of a few correlation times during
      // which the disturbance is weaker than configured — and for a slow
      // process that can be most of the run.
      this.current = this.sigma * this.stream.gaussianAt(0, this.lane);
      this.index = 0;
    }

    while (this.index < index) {
      this.index += 1;
      this.current =
        this.retention * this.current +
        this.innovation * this.stream.gaussianAt(this.index, this.lane);
    }
    return this.current;
  }

  /** Returns the process to its initial state, replaying the same realization. */
  public reset(): void {
    this.index = -1;
    this.current = 0;
  }
}

/**
 * Sum of fixed sinusoids.
 *
 * Wholly deterministic — no stream, no state, no index grid. A tone is a
 * closed-form function of time, so it is evaluated directly and cannot drift,
 * accumulate error, or depend on how the caller stepped.
 */
export interface Tone {
  readonly amplitude: number;
  readonly frequency: number;
  readonly phase: number;
}

/** Evaluates `sum(A * sin(2*pi*f*t + phase))` at `time`. */
export function toneSum(tones: readonly Tone[], time: number): number {
  let total = 0;
  for (const tone of tones) {
    total += tone.amplitude * Math.sin(2 * Math.PI * tone.frequency * time + tone.phase);
  }
  return total;
}

/**
 * A two-state good/bad Markov chain over a frame index.
 *
 * Used for burst frame loss. `meanGood` and `meanBad` are the expected dwell in
 * each state in frames, so the per-frame switch probabilities are their
 * reciprocals. Like the OU process it is evaluated on the frame grid and walks
 * forward, so the burst pattern is a function of the seed and the frame index
 * and nothing else.
 */
export class BurstChain {
  private readonly stream: CounterStream;
  private readonly leaveGood: number;
  private readonly leaveBad: number;

  private index = -1;
  private bad = false;

  /**
   * @throws {RangeError} when either mean dwell is not positive
   */
  constructor(stream: CounterStream, meanGoodFrames: number, meanBadFrames: number) {
    if (!(meanGoodFrames > 0) || !(meanBadFrames > 0)) {
      throw new RangeError(
        `Burst dwell means must be positive, received good=${String(meanGoodFrames)} bad=${String(meanBadFrames)}`,
      );
    }
    this.stream = stream;
    this.leaveGood = Math.min(1, 1 / meanGoodFrames);
    this.leaveBad = Math.min(1, 1 / meanBadFrames);
  }

  /** Whether frame `index` is in the bad (dropping) state. Replays if asked to go back. */
  public isBadAt(index: number): boolean {
    if (index < this.index) this.reset();
    if (this.index < 0) {
      // Start in the stationary distribution of the chain, so a run does not
      // begin with a guaranteed healthy stretch that the configuration did not
      // ask for.
      const badFraction = this.leaveGood / (this.leaveGood + this.leaveBad);
      this.bad = this.stream.floatAt(0) < badFraction;
      this.index = 0;
    }
    while (this.index < index) {
      this.index += 1;
      const draw = this.stream.floatAt(this.index);
      this.bad = this.bad ? draw >= this.leaveBad : draw < this.leaveGood;
    }
    return this.bad;
  }

  public reset(): void {
    this.index = -1;
    this.bad = false;
  }
}
