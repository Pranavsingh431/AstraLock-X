/**
 * The encoder: how the mount reports its own position.
 *
 * A real encoder has finite resolution, so the reported angle is a multiple of
 * one count. The difference between that and the true mechanical angle is not
 * an error to be removed — it is the reason a controller cannot know exactly
 * where it is pointing, and modelling it is the point.
 *
 * Deterministic and noiseless in Phase 3. Encoder noise, bias and reporting
 * latency belong to later phases and are deliberately absent rather than
 * approximated.
 */

/**
 * Quantises an angle to the nearest whole count.
 *
 * ```
 *   measured = round(angle / resolution) * resolution
 * ```
 *
 * Round-to-nearest rather than truncation, so the error is centred on zero and
 * bounded by half a count rather than being a systematic bias of up to a whole
 * one. `Math.round` breaks its ties upward, which makes the mapping total and
 * deterministic; a tie is one specific angle per count and the choice only has
 * to be consistent.
 *
 * @throws {RangeError} for a non-positive resolution, which would divide by
 * zero and produce NaN for every subsequent reading.
 */
export function quantizeAngle(angle: number, resolution: number): number {
  if (!(resolution > 0)) {
    throw new RangeError(
      `Encoder resolution must be strictly positive, received ${String(resolution)}`,
    );
  }
  return Math.round(angle / resolution) * resolution;
}

/** How far the reported angle sits from the true one. */
export const quantizationError = (angle: number, resolution: number): number =>
  quantizeAngle(angle, resolution) - angle;
