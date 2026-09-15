/**
 * Beacon identity from temporal brightness: bounded candidate histories, a
 * normalised code correlation, and a bounded phase search.
 *
 * ## What problem this solves
 *
 * Phase 6 gave the tracker motion consistency, and Phase 7 showed its limit: a
 * decoy that is bright, close to the predicted bearing and moving plausibly
 * passes every gate, because nothing in an image says *which* source a blob is.
 * Intensity and geometry cannot separate two sources that look and move alike.
 *
 * Time can. A beacon that modulates its brightness to a known pattern can be
 * recognised by watching it, and a decoy that does not carry that pattern
 * cannot fake it without knowing it.
 *
 * ## What the tracker knows, and what it must not
 *
 * The terminal is configured with the **pattern it expects the far end to
 * send** — the same way a radio is configured with a frequency. That is not
 * ground truth: it says nothing about which object in the world is emitting.
 *
 * Nothing here ever sees an emitter id, a target index, the simulator's true
 * code, or the true modulation phase. Every input is something a camera
 * produced: a timestamp, an exposure, a position on the image, a brightness.
 * The isolation tests hold this to the line.
 *
 * ## Why the score is normalised
 *
 * A raw correlation prefers whatever is brightest, which is exactly the failure
 * being fixed. The score here is a Pearson correlation between the observed
 * brightness history and the exposure-integrated *shape* of the expected code:
 * it is invariant to any affine change of brightness, so a decoy twice as bright
 * but following the wrong pattern scores no better for being bright.
 *
 * It is **not** a probability and is not named as one.
 *
 * See docs/BEACON_IDENTITY.md.
 */

import { integratedShape, type CodeSymbol } from '@/core/contracts/code-waveform';

// --- Observations -----------------------------------------------------------

/**
 * One observation of one candidate.
 *
 * Every field is something the camera reported. There is deliberately no
 * identifier of any kind: a sample knows when it was taken, where on the image
 * it was, and how bright it was.
 */
export interface IdentitySample {
  /** Mid-exposure instant, in simulated seconds. */
  readonly time: number;
  /** Exposure duration, seconds. The code is integrated over this window. */
  readonly exposure: number;
  /** Continuous image coordinates of the centroid. Reported, never joined on. */
  readonly u: number;
  readonly v: number;
  /**
   * Absolute bearing of the centroid, with the gimbal pose already removed.
   *
   * This is the coordinate histories are joined in. Image coordinates are not,
   * and the difference is not cosmetic: the image moves under the gimbal, so
   * during a slew a stationary source can travel tens of pixels per frame while
   * its bearing barely changes. Joining on pixels therefore breaks every
   * history exactly when the tracker is manoeuvring — which is when it most
   * needs to know what it is looking at.
   */
  readonly azimuth: number;
  readonly elevation: number;
  /**
   * Background-subtracted integrated intensity of the blob.
   *
   * A monotone but **not linear** function of the emitted level: as a source
   * dims, fewer of its pixels clear the detector threshold, so the integral
   * falls faster than the emission does. Normalised correlation tolerates that
   * — it only needs the observed series to rise and fall with the emitted one —
   * but the nonlinearity does cost correlation, and it is the main reason a
   * real coded target scores below the 1.0 an ideal receiver would reach. See
   * docs/BEACON_IDENTITY.md.
   */
  readonly intensity: number;
}

// --- Candidate histories ----------------------------------------------------

/**
 * A run of observations believed to come from one source.
 *
 * "Believed" is doing real work in that sentence. Samples are joined across
 * frames by nearest-neighbour in image space and nothing else, because there is
 * nothing else available: no identifier travels with a blob. When two sources
 * pass close the join can follow the wrong one, and it is supposed to be able
 * to — a history that magically stayed with the right source would be using
 * knowledge the tracker does not have, and would make every result here a
 * fiction.
 */
export class CandidateHistory {
  private readonly samples: IdentitySample[] = [];

  constructor(
    /** Longest span of samples retained, in seconds. */
    private readonly window: number,
    /** Hard cap on retained samples, whatever the window implies. */
    private readonly capacity: number,
  ) {}

  /** The most recent observation, or `null` for an empty history. */
  public get latest(): IdentitySample | null {
    return this.samples.length === 0 ? null : this.samples[this.samples.length - 1]!;
  }

  public get length(): number {
    return this.samples.length;
  }

  /** Seconds between the oldest and newest retained sample. */
  public get span(): number {
    if (this.samples.length < 2) return 0;
    return this.samples[this.samples.length - 1]!.time - this.samples[0]!.time;
  }

  /** The retained samples, oldest first. */
  public get observations(): readonly IdentitySample[] {
    return this.samples;
  }

  /**
   * Adds an observation and discards whatever has aged out.
   *
   * Bounded twice over: by time, so evidence cannot be older than the window,
   * and by count, so a high frame rate cannot grow the history without limit.
   */
  public push(sample: IdentitySample): void {
    this.samples.push(sample);
    const oldest = sample.time - this.window;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop]!.time < oldest) drop += 1;
    if (drop > 0) this.samples.splice(0, drop);
    if (this.samples.length > this.capacity) {
      this.samples.splice(0, this.samples.length - this.capacity);
    }
  }

  /** Drops every sample older than `time - window`, without adding one. */
  public expire(time: number): void {
    const oldest = time - this.window;
    let drop = 0;
    while (drop < this.samples.length && this.samples[drop]!.time < oldest) drop += 1;
    if (drop > 0) this.samples.splice(0, drop);
  }

  public clear(): void {
    this.samples.length = 0;
  }
}

// --- Correlation ------------------------------------------------------------

/** What a correlation at one phase produced. */
export interface CorrelationResult {
  /** Pearson correlation on [-1, 1], or `null` when it is undefined. */
  readonly correlation: number | null;
  /** The code phase, in seconds, that produced it. */
  readonly phase: number;
  /** Observations that went into it. */
  readonly samples: number;
  /**
   * How much the observed brightness actually varied, as standard deviation
   * over mean.
   *
   * A property of the observations alone — no code enters it — and the reason
   * it is carried alongside the correlation is that Pearson's r is scale-free
   * in a way that is dangerous here. Divide a flat series by its own tiny
   * standard deviation and the noise is stretched to fill the range, so a
   * source that has stopped signalling correlates somewhere in [-1, 1] at
   * random, and about half the time that number is low enough to look like
   * positive evidence of a *wrong* code. It is not. It is no evidence at all,
   * and this is the quantity that tells the two apart.
   */
  readonly modulation: number;
}

/**
 * Coefficient of variation of the observed brightness: standard deviation over
 * mean, on a series of non-negative intensities.
 *
 * Zero for a perfectly steady source and around 0.5 for a square-wave beacon at
 * the bundled contrast. Returns 0 rather than infinity when the mean is zero,
 * because a candidate with no light in it has nothing to say either way.
 */
export function observedModulation(samples: readonly IdentitySample[]): number {
  const count = samples.length;
  if (count < 2) return 0;
  let sum = 0;
  for (const sample of samples) sum += sample.intensity;
  const mean = sum / count;
  if (!(mean > 0)) return 0;
  let variance = 0;
  for (const sample of samples) {
    const d = sample.intensity - mean;
    variance += d * d;
  }
  return Math.sqrt(variance / count) / mean;
}

/**
 * Pearson correlation between a candidate's brightness history and the
 * exposure-integrated shape of a code at one phase.
 *
 * ```
 *   x_i = integrated shape of the expected code over sample i's exposure
 *   y_i = observed intensity of sample i
 *
 *   r = SUM (x_i - xbar)(y_i - ybar)
 *       / sqrt( SUM (x_i - xbar)^2 * SUM (y_i - ybar)^2 )
 * ```
 *
 * Undefined — returned as `null` — when either series has no variance. That is
 * not an edge case to paper over: a history spanning less than one symbol has a
 * constant predicted shape, and a candidate whose brightness never changed
 * carries no temporal information. In both cases there is nothing to correlate,
 * and saying so is the correct answer.
 */
export function correlateAtPhase(
  samples: readonly IdentitySample[],
  sequence: readonly CodeSymbol[],
  symbolDuration: number,
  phase: number,
): number | null {
  const count = samples.length;
  if (count < 2) return null;

  let sumX = 0;
  let sumY = 0;
  const predicted = new Float64Array(count);

  for (let index = 0; index < count; index += 1) {
    const sample = samples[index]!;
    const half = sample.exposure / 2;
    const shape = integratedShape(
      sequence,
      symbolDuration,
      phase,
      sample.time - half,
      sample.time + half,
    );
    predicted[index] = shape;
    sumX += shape;
    sumY += sample.intensity;
  }

  const meanX = sumX / count;
  const meanY = sumY / count;

  let covariance = 0;
  let varianceX = 0;
  let varianceY = 0;
  for (let index = 0; index < count; index += 1) {
    const dx = predicted[index]! - meanX;
    const dy = samples[index]!.intensity - meanY;
    covariance += dx * dy;
    varianceX += dx * dx;
    varianceY += dy * dy;
  }

  if (varianceX <= 0 || varianceY <= 0) return null;
  return covariance / Math.sqrt(varianceX * varianceY);
}

/**
 * Searches code phase for the best correlation.
 *
 * The transmitter's symbol clock is not known, so phase has to be recovered
 * rather than assumed. The search is a uniform sweep over one full code period,
 * which is sufficient because the code repeats: every possible alignment occurs
 * within one period.
 *
 * Resolution is a configured number of steps rather than something adaptive.
 * A sweep finer than the camera's own sampling buys nothing — the observations
 * cannot distinguish phases closer together than an exposure — and the cost is
 * linear in steps, so the setting is a direct and visible trade.
 *
 * When `around` is given the sweep is narrowed to a window either side of it,
 * which is what a tracker that has already locked the phase should do: the
 * transmitter's clock does not move, so re-searching the whole period every
 * frame is work with a known answer.
 */
export function searchPhase(
  samples: readonly IdentitySample[],
  sequence: readonly CodeSymbol[],
  symbolDuration: number,
  steps: number,
  around: number | null = null,
  narrowSymbols = 1,
): CorrelationResult {
  const period = sequence.length * symbolDuration;
  const searchSpan =
    around === null ? period : Math.min(period, 2 * narrowSymbols * symbolDuration);
  const start = around === null ? 0 : around - searchSpan / 2;

  // Steps scale with the span, so resolution is the same whether the sweep is
  // wide or narrow. Holding the *count* fixed instead would either waste most of
  // a narrow sweep's work on a resolution the observations cannot support, or
  // leave a wide sweep too coarse to find the peak. It is also where the cost
  // goes: at the bundled timing a narrow sweep is a seventh of a wide one, and
  // the search runs for every candidate on every frame.
  const scaled = Math.round(steps * (searchSpan / period));
  const count = Math.max(2, Math.min(Math.trunc(steps), scaled));

  let bestCorrelation: number | null = null;
  let bestPhase = start;

  for (let step = 0; step < count; step += 1) {
    const phase = start + (searchSpan * step) / count;
    const correlation = correlateAtPhase(samples, sequence, symbolDuration, phase);
    if (correlation === null) continue;
    if (bestCorrelation === null || correlation > bestCorrelation) {
      bestCorrelation = correlation;
      bestPhase = phase;
    }
  }

  // Reported on [0, period) so that two phases a period apart, which are the
  // same alignment, are reported as the same number.
  const wrapped = ((bestPhase % period) + period) % period;
  return {
    correlation: bestCorrelation,
    phase: wrapped,
    samples: samples.length,
    modulation: observedModulation(samples),
  };
}

// --- Verdict ----------------------------------------------------------------

/**
 * What the tracker is willing to say about a candidate's identity.
 *
 * Every name here describes the **evidence**, not the world. There is no
 * `TRUE_TARGET` or `FALSE_TARGET`, because the tracker has no way to know
 * either and a name that implied otherwise would be a lie in the type system.
 */
export type IdentityState =
  /** Too few samples, or too short a span, to correlate anything. */
  | 'insufficient-evidence'
  /** Enough evidence to correlate, but the result sits between the thresholds. */
  | 'unconfirmed'
  /** Correlates with the expected code well enough to accept. */
  | 'match'
  /** Correlates badly enough to reject. */
  | 'mismatch'
  /** Matches, but so does another candidate: identity does not separate them. */
  | 'ambiguous';

export interface IdentityRule {
  /** Correlation at or above which a candidate is accepted. */
  readonly minCorrelation: number;
  /** Correlation at or below which a candidate is rejected. */
  readonly mismatchCorrelation: number;
  /** Fewest observations before any verdict other than insufficient. */
  readonly minSamples: number;
  /** Fewest symbol durations the history must span before any verdict. */
  readonly minSpanSymbols: number;
  /**
   * Least observed brightness variation, as standard deviation over mean,
   * before a candidate may be either recognised or refused.
   *
   * A source that is not modulating carries no identity information, and the
   * only honest thing to say about it is that there is nothing to say. Without
   * this, noise on a steady source correlates at random and the verdict becomes
   * a coin toss between "that is the wrong beacon" and "that is the right one".
   */
  readonly minModulation: number;
}

export interface IdentityReading {
  readonly state: IdentityState;
  /** Best correlation found, or `null` when none was defined. */
  readonly correlation: number | null;
  /** Code phase, in seconds, at the best correlation. */
  readonly phase: number;
  readonly samples: number;
  /** Seconds spanned by the samples used. */
  readonly span: number;
  /** Observed brightness variation behind the verdict. */
  readonly modulation: number;
}

/**
 * Turns a correlation into a verdict.
 *
 * The evidence test comes first and is not negotiable: without enough samples
 * over enough time there is no verdict to give, however high a correlation a
 * short history happens to produce. Three samples inside one symbol can
 * correlate at 1.0 and mean nothing.
 *
 * The same applies to a source that is not varying at all. A beacon that has
 * stopped signalling, or an ordinary light, produces a flat series whose
 * correlation is decided entirely by noise — and a *low* correlation from such
 * a series is not evidence of a wrong code, only of an absent one. Both the
 * recognising and the refusing verdicts therefore require the observations to
 * have carried some modulation; otherwise the answer is the same one a short
 * history gets.
 */
export function classify(
  result: CorrelationResult,
  span: number,
  symbolDuration: number,
  rule: IdentityRule,
): IdentityReading {
  const base = {
    correlation: result.correlation,
    phase: result.phase,
    samples: result.samples,
    modulation: result.modulation,
    span,
  };

  if (
    result.correlation === null ||
    result.samples < rule.minSamples ||
    span < rule.minSpanSymbols * symbolDuration ||
    result.modulation < rule.minModulation
  ) {
    return { ...base, state: 'insufficient-evidence' };
  }
  if (result.correlation >= rule.minCorrelation) return { ...base, state: 'match' };
  if (result.correlation <= rule.mismatchCorrelation) return { ...base, state: 'mismatch' };
  return { ...base, state: 'unconfirmed' };
}

// --- Tracking candidates across frames ---------------------------------------

/** One tracked candidate: its history, and where it was last seen. */
export interface TrackedCandidate {
  readonly history: CandidateHistory;
  /** Image position of the most recent observation, for display only. */
  u: number;
  v: number;
  /** Bearing of the most recent observation. Association happens here. */
  azimuth: number;
  elevation: number;
  /** Time of the most recent observation. */
  lastSeen: number;
  /** Best correlation and phase from the last evaluation, if any. */
  reading: IdentityReading | null;
}

export interface CandidateTrackerRule {
  /**
   * How far, in radians of bearing, a blob may move between frames and still be
   * joined to the same history.
   */
  readonly associationAngle: number;
  /** Seconds of history retained per candidate. */
  readonly historyWindow: number;
  /** Samples retained per candidate. */
  readonly historyCapacity: number;
  /** Most candidates tracked at once. */
  readonly maxCandidates: number;
}

/**
 * Angle between two bearings, small-angle on the sphere.
 *
 * Azimuth is compared the short way round so a history is not lost at the
 * wrap, and is foreshortened by `cos(elevation)` because a degree of azimuth
 * subtends less angle the further from the horizon you look.
 */
function angularDistance(
  a: { readonly azimuth: number; readonly elevation: number },
  b: { readonly azimuth: number; readonly elevation: number },
): number {
  let delta = a.azimuth - b.azimuth;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  const across = delta * Math.cos((a.elevation + b.elevation) / 2);
  return Math.hypot(across, a.elevation - b.elevation);
}

/**
 * Maintains a bounded set of candidate histories across frames.
 *
 * Association is nearest-neighbour in **bearing** space within an angle,
 * greedily by distance, with each observation and each existing track used at
 * most once. There is no identifier to join on and none is invented.
 *
 * Bearing rather than pixels, because a history should follow a *source* and
 * not a position on a sensor. The two agree while the camera is still and
 * disagree badly while it is slewing, where a pixel join loses every history at
 * once and the tracker forgets what it was looking at mid-manoeuvre.
 *
 * **Crossings are allowed to go wrong.** When two sources pass within the
 * association radius the nearest-neighbour join can hand one source's history
 * to the other, and the identity evidence then follows the wrong blob until
 * enough new samples wash it out. That is a real property of tracking by
 * position alone, it is why identity evidence is treated as evidence rather
 * than proof, and a tracker that avoided it here would only be doing so by
 * consulting something it is not allowed to see.
 */
export class CandidateTracker {
  private tracks: TrackedCandidate[] = [];

  constructor(private readonly rule: CandidateTrackerRule) {}

  public get candidates(): readonly TrackedCandidate[] {
    return this.tracks;
  }

  public reset(): void {
    this.tracks = [];
  }

  /**
   * Joins this frame's observations to existing histories, starting new ones
   * for observations that match nothing and retiring histories that have gone
   * quiet.
   *
   * @returns for each observation, the track it was joined to
   */
  public observe(
    observations: readonly IdentitySample[],
    time: number,
  ): readonly TrackedCandidate[] {
    // Retire anything older than the window before matching, so a track that
    // disappeared long ago cannot capture a new source that happens to appear
    // where it used to be.
    this.tracks = this.tracks.filter((track) => time - track.lastSeen <= this.rule.historyWindow);
    for (const track of this.tracks) track.history.expire(time);

    const radius = this.rule.associationAngle;
    const pairs: { observation: number; track: number; distance: number }[] = [];
    for (let o = 0; o < observations.length; o += 1) {
      const sample = observations[o]!;
      for (let t = 0; t < this.tracks.length; t += 1) {
        const track = this.tracks[t]!;
        const distance = angularDistance(sample, track);
        if (distance <= radius) pairs.push({ observation: o, track: t, distance });
      }
    }
    // Greedy by distance: the closest unambiguous pair is taken first, so a
    // blob that is near two tracks goes to the nearer one.
    pairs.sort((a, b) => a.distance - b.distance);

    const takenObservation = new Set<number>();
    const takenTrack = new Set<number>();
    const joined = new Array<TrackedCandidate | null>(observations.length).fill(null);

    for (const pair of pairs) {
      if (takenObservation.has(pair.observation) || takenTrack.has(pair.track)) continue;
      takenObservation.add(pair.observation);
      takenTrack.add(pair.track);
      const track = this.tracks[pair.track]!;
      const sample = observations[pair.observation]!;
      track.history.push(sample);
      track.u = sample.u;
      track.v = sample.v;
      track.azimuth = sample.azimuth;
      track.elevation = sample.elevation;
      track.lastSeen = sample.time;
      joined[pair.observation] = track;
    }

    for (let o = 0; o < observations.length; o += 1) {
      if (joined[o] !== null) continue;
      const sample = observations[o]!;
      const history = new CandidateHistory(this.rule.historyWindow, this.rule.historyCapacity);
      history.push(sample);
      const track: TrackedCandidate = {
        history,
        u: sample.u,
        v: sample.v,
        azimuth: sample.azimuth,
        elevation: sample.elevation,
        lastSeen: sample.time,
        reading: null,
      };
      this.tracks.push(track);
      joined[o] = track;
    }

    // Bounded: when more sources are visible than the tracker will follow, the
    // ones seen least recently are dropped. Memory cannot grow with the number
    // of blobs a noisy frame happens to contain.
    if (this.tracks.length > this.rule.maxCandidates) {
      this.tracks.sort((a, b) => b.lastSeen - a.lastSeen);
      this.tracks.length = this.rule.maxCandidates;
    }

    return joined.map((track, index) => track ?? this.tracks[index]!);
  }
}
