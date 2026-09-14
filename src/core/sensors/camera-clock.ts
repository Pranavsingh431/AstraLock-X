/**
 * The camera's own clock.
 *
 * A camera runs at its own rate. It is not a divider of the physics tick, and
 * it has nothing to do with the display refresh. Those are three independent
 * clocks and conflating any two of them produces a sensor whose timestamps are
 * an artefact of the machine it ran on.
 *
 * The tempting implementation — `capture every round(tickRate / fps) ticks` —
 * is wrong the moment the rates do not divide. At 200 Hz physics and 60 FPS it
 * gives `round(3.33) = 3`, which is 66.7 FPS: a 11% timing error that would
 * quietly corrupt every velocity a future tracker estimated.
 *
 * Instead, capture times come from the frame index directly:
 *
 * ```
 *   captureTime(frameIndex) = frameIndex / frameRate
 * ```
 *
 * One division, never an accumulation, so there is no drift however long the
 * run: the ten-thousandth frame is exactly as accurate as the first.
 *
 * See docs/SENSOR_MODEL.md and ADR-0010.
 */

import { type Hertz, type Seconds, seconds } from '@/core/contracts/units';

/** An inclusive range of frame indices. Empty when `last < first`. */
export interface FrameRange {
  readonly first: number;
  readonly last: number;
  readonly count: number;
}

const EMPTY_RANGE: FrameRange = { first: 0, last: -1, count: 0 };

export class CameraClock {
  public readonly frameRate: Hertz;
  /** Nominal interval between frames. Reported; never accumulated. */
  public readonly framePeriod: Seconds;

  /** @throws {RangeError} when the frame rate is not strictly positive. */
  constructor(frameRate: Hertz) {
    if (!(frameRate > 0)) {
      throw new RangeError(
        `Camera frame rate must be strictly positive, received ${String(frameRate)} Hz`,
      );
    }
    this.frameRate = frameRate;
    this.framePeriod = seconds(1 / frameRate);
  }

  /**
   * Capture time of a frame, in simulated seconds.
   *
   * Frame 0 is captured at t = 0.
   *
   * @throws {RangeError} when `frameIndex` is not a non-negative integer.
   */
  public captureTime(frameIndex: number): Seconds {
    if (!Number.isInteger(frameIndex) || frameIndex < 0) {
      throw new RangeError(
        `Frame index must be a non-negative integer, received ${String(frameIndex)}`,
      );
    }
    return seconds(frameIndex / this.frameRate);
  }

  /**
   * Frames whose capture time lies in the half-open interval
   * `(afterTime, throughTime]`.
   *
   * Half-open so that advancing the simulation repeatedly never captures the
   * same frame twice and never skips one: the previous call's `throughTime`
   * becomes the next call's `afterTime`.
   *
   * The index bounds are computed directly and then corrected against the
   * actual capture times. `frameIndex / frameRate` and `time * frameRate` are
   * not exact inverses in binary floating point — at 60 FPS, `(1 / 60) * 60`
   * is not exactly 1 — so a bound derived by multiplication can be off by one.
   * The corrections run at most once or twice and keep the operation O(1),
   * which matters because this is on the per-step path.
   *
   * @throws {RangeError} when the interval is not finite or runs backwards.
   */
  public framesBetween(afterTime: number, throughTime: number): FrameRange {
    if (!Number.isFinite(afterTime) || !Number.isFinite(throughTime)) {
      throw new RangeError('Camera capture interval must be finite');
    }
    if (throughTime < afterTime) {
      throw new RangeError(
        `Camera capture interval must not run backwards: (${String(afterTime)}, ${String(throughTime)}]`,
      );
    }
    if (throughTime < 0) return EMPTY_RANGE;

    let first = Math.max(0, Math.ceil(afterTime * this.frameRate));
    while (first > 0 && this.captureTime(first - 1) > afterTime) first -= 1;
    while (this.captureTime(first) <= afterTime) first += 1;

    let last = Math.max(-1, Math.floor(throughTime * this.frameRate));
    while (last >= 0 && this.captureTime(last) > throughTime) last -= 1;
    while (this.captureTime(last + 1) <= throughTime) last += 1;

    if (last < first) return EMPTY_RANGE;
    return { first, last, count: last - first + 1 };
  }

  /**
   * Number of frames a run of `durationSeconds` produces, counting the frame at
   * t = 0.
   */
  public frameCountFor(durationSeconds: number): number {
    if (durationSeconds < 0) return 0;
    return this.framesBetween(-1, durationSeconds).count;
  }
}
