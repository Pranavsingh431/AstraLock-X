/**
 * Image formation for an ideal point source.
 *
 * A beacon at optical infinity is a point, and a real camera spreads it across
 * several pixels through diffraction, defocus and pixel sampling. Phase 2 models
 * that spread as a circular Gaussian: enough structure for a future centroid
 * algorithm to have something to work with, and far short of a diffraction
 * simulator, which would be answering a question nobody has asked yet.
 *
 * Two properties matter more than fidelity here:
 *
 *  - **Sub-pixel centres are respected.** The kernel is evaluated about the
 *    exact projected coordinate, not a rounded one. Rounding to the nearest
 *    pixel would cap the accuracy of every centroid a tracker could ever
 *    compute at half a pixel, which is worse than the sensor itself.
 *  - **The kernel is bounded and clipped.** Writes outside the image are
 *    dropped, not wrapped, so a beacon at the edge cannot bleed onto the
 *    opposite side of the row above.
 *
 * See docs/SENSOR_MODEL.md.
 */

/**
 * Kernel half-width, in standard deviations.
 *
 * Beyond three sigma a Gaussian contributes under 1.2% of its peak, which for
 * an 8-bit sensor is at most three counts. Extending further costs quadratic
 * time for values that quantise to nothing.
 */
export const PSF_RADIUS_SIGMAS = 3;

/** Kernel half-width in whole pixels for a given spread. */
export const psfRadiusPixels = (sigma: number): number => Math.ceil(PSF_RADIUS_SIGMAS * sigma);

export interface RasterTarget {
  /** Row-major intensity samples, `width * height` entries. */
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Largest value the format can hold; contributions clip here. */
  readonly maxValue: number;
}

/**
 * Adds one Gaussian point source to an image.
 *
 * Contributions from several emitters **add**, then clip at `maxValue`. Adding
 * is what light does; clipping is what a full well does. The alternative —
 * taking the maximum — would let two overlapping beacons look exactly like one,
 * which is precisely the case a multi-target tracker has to resolve.
 *
 * The Gaussian is evaluated separably: `exp(-(dx^2 + dy^2) / 2s^2)` factors
 * into `exp(-dx^2 / 2s^2) * exp(-dy^2 / 2s^2)`, so a kernel of half-width `k`
 * costs `2k` calls to `Math.exp` instead of `k^2`. For the default spread that
 * is roughly twenty calls per emitter rather than two hundred, and the result
 * is identical rather than approximated.
 *
 * @param centreX continuous image coordinate; pixel centres are at half-integers
 * @param peak    peak intensity in the same units as `maxValue`
 * @returns the number of pixels actually written
 */
export function addGaussianPointSource(
  target: RasterTarget,
  centreX: number,
  centreY: number,
  peak: number,
  sigma: number,
): number {
  if (!(sigma > 0)) {
    throw new RangeError(`Point-spread sigma must be strictly positive, received ${String(sigma)}`);
  }
  if (!Number.isFinite(centreX) || !Number.isFinite(centreY) || !Number.isFinite(peak)) {
    throw new RangeError('Point source centre and peak must be finite');
  }

  const radius = psfRadiusPixels(sigma);

  // Clipped to the image, so a partially visible beacon draws its visible part
  // and nothing else. Row arithmetic below assumes these bounds hold.
  const firstX = Math.max(0, Math.floor(centreX - radius));
  const lastX = Math.min(target.width - 1, Math.ceil(centreX + radius));
  const firstY = Math.max(0, Math.floor(centreY - radius));
  const lastY = Math.min(target.height - 1, Math.ceil(centreY + radius));

  if (firstX > lastX || firstY > lastY) return 0;

  const denominator = 2 * sigma * sigma;

  // Separable factors, evaluated about the exact sub-pixel centre.
  const columnCount = lastX - firstX + 1;
  const rowCount = lastY - firstY + 1;
  const columnWeights = new Float64Array(columnCount);
  const rowWeights = new Float64Array(rowCount);

  for (let index = 0; index < columnCount; index += 1) {
    const dx = firstX + index + 0.5 - centreX;
    columnWeights[index] = Math.exp(-(dx * dx) / denominator);
  }
  for (let index = 0; index < rowCount; index += 1) {
    const dy = firstY + index + 0.5 - centreY;
    rowWeights[index] = Math.exp(-(dy * dy) / denominator);
  }

  let written = 0;
  for (let row = 0; row < rowCount; row += 1) {
    const rowWeight = rowWeights[row]! * peak;
    const rowOffset = (firstY + row) * target.width;

    for (let column = 0; column < columnCount; column += 1) {
      const contribution = rowWeight * columnWeights[column]!;
      // Values below half a count would round to nothing; skipping them keeps
      // the inner loop off pixels it cannot change.
      if (contribution < 0.5) continue;

      const index = rowOffset + firstX + column;
      const summed = target.data[index]! + contribution;
      target.data[index] = summed >= target.maxValue ? target.maxValue : Math.round(summed);
      written += 1;
    }
  }

  return written;
}

/** Fills an image with a uniform level. */
export function fillBackground(target: RasterTarget, level: number): void {
  target.data.fill(Math.max(0, Math.min(target.maxValue, Math.round(level))));
}

/**
 * A floating-point accumulation buffer.
 *
 * The integer {@link RasterTarget} clips and rounds at every write, which is
 * correct for a single ideal exposure but wrong once several things have to be
 * summed before quantisation: sub-exposure samples, ambient background and
 * noise all have to land in one place first. Rounding between them would
 * quantise the same photon budget several times over.
 */
export interface FloatRasterTarget {
  /** Row-major intensity, `width * height` entries, unclipped. */
  readonly data: Float64Array;
  readonly width: number;
  readonly height: number;
}

/**
 * Adds one Gaussian point source to a floating-point image.
 *
 * Same kernel, same separable evaluation and same sub-pixel centre as
 * {@link addGaussianPointSource}. Two differences, both required by the
 * disturbance pipeline:
 *
 *  - Contributions accumulate without clipping or rounding, so saturation is
 *    decided once, at quantisation, against the total.
 *  - There is no "below half a count" cut-off. That shortcut is safe when a
 *    contribution is written straight to an 8-bit pixel, and wrong when it is
 *    one of several sub-exposure samples that together round to something.
 *
 * @param centreX continuous image coordinate; pixel centres are at half-integers
 * @param peak    peak intensity of this contribution
 * @returns the number of pixels touched
 */
export function addGaussianPointSourceFloat(
  target: FloatRasterTarget,
  centreX: number,
  centreY: number,
  peak: number,
  sigma: number,
): number {
  if (!(sigma > 0)) {
    throw new RangeError(`Point-spread sigma must be strictly positive, received ${String(sigma)}`);
  }
  if (!Number.isFinite(centreX) || !Number.isFinite(centreY) || !Number.isFinite(peak)) {
    throw new RangeError('Point source centre and peak must be finite');
  }

  const radius = psfRadiusPixels(sigma);
  const firstX = Math.max(0, Math.floor(centreX - radius));
  const lastX = Math.min(target.width - 1, Math.ceil(centreX + radius));
  const firstY = Math.max(0, Math.floor(centreY - radius));
  const lastY = Math.min(target.height - 1, Math.ceil(centreY + radius));

  if (firstX > lastX || firstY > lastY) return 0;

  const denominator = 2 * sigma * sigma;
  const columnCount = lastX - firstX + 1;
  const rowCount = lastY - firstY + 1;
  const columnWeights = new Float64Array(columnCount);
  const rowWeights = new Float64Array(rowCount);

  for (let index = 0; index < columnCount; index += 1) {
    const dx = firstX + index + 0.5 - centreX;
    columnWeights[index] = Math.exp(-(dx * dx) / denominator);
  }
  for (let index = 0; index < rowCount; index += 1) {
    const dy = firstY + index + 0.5 - centreY;
    rowWeights[index] = Math.exp(-(dy * dy) / denominator);
  }

  let written = 0;
  for (let row = 0; row < rowCount; row += 1) {
    const rowWeight = rowWeights[row]! * peak;
    const rowOffset = (firstY + row) * target.width;
    for (let column = 0; column < columnCount; column += 1) {
      target.data[rowOffset + firstX + column]! += rowWeight * columnWeights[column]!;
      written += 1;
    }
  }
  return written;
}

/**
 * Peak intensity that preserves total energy when a spot is broadened.
 *
 * A Gaussian's integral is `peak * 2*pi*sigma^2`, so holding the peak fixed
 * while widening the spot would create light. Defocus spreads a fixed amount of
 * energy over a larger area: the peak falls as `sigma^2` grows, and the sum over
 * the image is unchanged.
 */
export function energyPreservingPeak(peak: number, baseSigma: number, spreadSigma: number): number {
  if (!(spreadSigma > 0) || !(baseSigma > 0)) return peak;
  return (peak * baseSigma * baseSigma) / (spreadSigma * spreadSigma);
}
