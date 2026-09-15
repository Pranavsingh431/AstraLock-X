/**
 * The temporal code waveform, and its integral over a camera exposure.
 *
 * A coded beacon varies its emitted intensity in time. A camera does not sample
 * that variation — it **integrates** it over the exposure and reports one
 * number per frame. So the quantity that actually reaches an image is
 *
 * ```
 *   level(a, b) = (1 / (b - a)) * integral of level(t) dt, over [a, b]
 * ```
 *
 * where `[a, b]` is the exposure window. This module computes that integral
 * exactly, by walking the symbols the window overlaps and weighting each by how
 * much of the window it covers. Nothing here samples `level(captureTime)` and
 * calls it a measurement: at the default timing an exposure can straddle a
 * symbol boundary, and evaluating the midpoint would report a level the sensor
 * never saw.
 *
 * **This module is shared deliberately.** The sensor uses it to modulate an
 * emitter; the tracker uses it to predict what a candidate's brightness should
 * look like under the code it has been configured to expect. They must agree
 * exactly, and two implementations of the same integral would eventually not.
 *
 * Sharing it leaks nothing. What is shared is the arithmetic of a square wave,
 * not any fact about the world: the sensor calls it with the scenario's code and
 * the tracker calls it with its own configured one, and neither can see the
 * other's arguments.
 *
 * See docs/BEACON_IDENTITY.md.
 */

/** One symbol of a binary code. */
export type CodeSymbol = 0 | 1;

/**
 * A periodic binary intensity code.
 *
 * `levelAt(t) = onLevel` when the symbol covering `t` is 1, `offLevel` when it
 * is 0. Symbol `k` covers `[phaseOffset + k*symbolDuration, phaseOffset +
 * (k+1)*symbolDuration)`, and `k` wraps around the sequence.
 */
export interface CodeWaveform {
  readonly sequence: readonly CodeSymbol[];
  /** Seconds each symbol is held. */
  readonly symbolDuration: number;
  /** Time at which symbol 0 begins, in seconds. May be negative. */
  readonly phaseOffset: number;
  /** Emitted level while a 1 is being sent. */
  readonly onLevel: number;
  /** Emitted level while a 0 is being sent. */
  readonly offLevel: number;
  /**
   * Whether the sequence repeats for ever.
   *
   * When false the beacon sends the sequence once and then holds `onLevel`,
   * becoming an ordinary uncoded source. That is not a curiosity: it is how a
   * scenario says "identity information stops being available part way through
   * the run", which is one of the cases a tracker has to answer honestly rather
   * than by assuming the code is still there.
   */
  readonly repeat: boolean;
}

/** The period of one full pass of the sequence, in seconds. */
export const codePeriod = (code: CodeWaveform): number =>
  code.sequence.length * code.symbolDuration;

/**
 * Emitted level at an instant.
 *
 * Exposed for tests and for reasoning about the waveform. The sensor does not
 * use it: a camera never observes an instant.
 */
export function levelAt(code: CodeWaveform, time: number): number {
  return levelOfIndex(code, Math.floor((time - code.phaseOffset) / code.symbolDuration));
}

/**
 * The level of the symbol at an absolute index, wrapping or holding as the
 * repeat policy requires.
 *
 * Absolute means "counted from `phaseOffset`", so it may be negative. A
 * repeating code wraps; a non-repeating one holds `onLevel` outside its single
 * pass, which is what "the beacon has stopped signalling" looks like.
 */
function levelOfIndex(code: CodeWaveform, absoluteIndex: number): number {
  const length = code.sequence.length;
  if (!code.repeat) {
    if (absoluteIndex < 0 || absoluteIndex >= length) return code.onLevel;
    return code.sequence[absoluteIndex] === 1 ? code.onLevel : code.offLevel;
  }
  const wrapped = ((absoluteIndex % length) + length) % length;
  return code.sequence[wrapped] === 1 ? code.onLevel : code.offLevel;
}

/**
 * Mean emitted level over `[start, end]`: the exposure-integrated observable.
 *
 * Exact, not sampled. The window is split at every symbol boundary it crosses
 * and each piece contributes its level weighted by its duration, so an exposure
 * lying half in a 1 and half in a 0 returns the midpoint of the two levels —
 * which is what the sensor would actually collect.
 *
 * @throws {RangeError} when the window runs backwards, or the code's timing is
 * not usable.
 */
export function integratedLevel(code: CodeWaveform, start: number, end: number): number {
  if (!(code.symbolDuration > 0)) {
    throw new RangeError(
      `Symbol duration must be positive, received ${String(code.symbolDuration)}`,
    );
  }
  if (code.sequence.length === 0) throw new RangeError('Code sequence must not be empty');
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    throw new RangeError('Exposure window must be finite');
  }
  if (end < start) {
    throw new RangeError(`Exposure window runs backwards: [${String(start)}, ${String(end)}]`);
  }

  // A zero-length window has no integral to take. Reporting the instantaneous
  // level is the limit of the integral as the window closes, so it is the
  // consistent answer rather than a special case.
  const span = end - start;
  if (span === 0) return levelAt(code, start);

  let total = 0;
  let cursor = start;

  // Walk symbol by symbol, stepping the **integer symbol index** rather than
  // re-deriving it from the cursor each time.
  //
  // The difference is not stylistic. Deriving the index from a cursor that is
  // itself the result of previous floating-point arithmetic means a boundary
  // can land a fraction of an ulp on the wrong side of itself, the symbol gets
  // split in two, and the sliver is charged to the previous symbol's level. One
  // sliver is nothing; forty thousand symbols of them measured as a systematic
  // bias of a whole symbol's worth of "on" time. Advancing an integer and
  // computing each boundary as `phaseOffset + index * symbolDuration` gives
  // exactly one iteration per symbol and cannot drift however long the window.
  let index = Math.floor((start - code.phaseOffset) / code.symbolDuration);

  while (cursor < end) {
    const boundary = code.phaseOffset + (index + 1) * code.symbolDuration;
    const next = boundary < end ? boundary : end;

    if (next > cursor) {
      total += levelOfIndex(code, index) * (next - cursor);
      cursor = next;
    }
    index += 1;
  }

  return total / span;
}

/**
 * The exposure-integrated level of a **unit-amplitude** version of a code.
 *
 * `onLevel = 1`, `offLevel = 0`: the shape of the code with its amplitude
 * divided out. This is what a receiver predicts against, because a receiver
 * configured with the expected signalling pattern knows the *pattern* and not
 * how bright the far terminal happens to be. Correlating against the shape and
 * normalising is what makes the identity test independent of brightness.
 */
export function integratedShape(
  sequence: readonly CodeSymbol[],
  symbolDuration: number,
  phaseOffset: number,
  start: number,
  end: number,
): number {
  return integratedLevel(
    { sequence, symbolDuration, phaseOffset, onLevel: 1, offLevel: 0, repeat: true },
    start,
    end,
  );
}
