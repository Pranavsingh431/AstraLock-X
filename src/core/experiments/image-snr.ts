/**
 * Image signal-to-noise ratio, defined.
 *
 * **Privileged and evaluation-only.** Computing this needs the noiseless image,
 * which only a simulator has. No algorithm receives it; a tracker that knew the
 * SNR of its own frame would be told how hard its job is.
 *
 * Phase 5 replaced a fabricated 0 dB SNR with "Not modelled", because nothing
 * modelled signal or noise. Phase 7 models both, so a real figure is available —
 * and it is stated with its formula, because "SNR" without one is not a
 * measurement. Every published SNR depends on choices of aperture, of what
 * counts as signal, and of whether the ratio is of powers or amplitudes, and two
 * numbers computed under different choices are not comparable.
 *
 * ```
 *   signal(p)  = the clean target contribution at pixel p, before noise
 *   noise(p)   = noisy(p) - clean(p)
 *   SNR_power  = sum over aperture of signal(p)^2 / sum over aperture of noise(p)^2
 *   SNR_dB     = 10 * log10(SNR_power)
 * ```
 *
 * Both images come from the same deterministic realization, so their difference
 * is the noise field and nothing else — not a second draw, and not an estimate
 * of the noise from the noisy image itself.
 *
 * The background is supplied as a function rather than a third rendered image.
 * It is analytic — a pedestal plus an optional ramp — so evaluating it costs a
 * few multiplications per pixel instead of a whole extra frame, and there is no
 * way for it to disagree with what the renderer actually laid down.
 *
 * See docs/DISTURBANCE_MODEL.md.
 */

/** A frame's pixels and its dimensions. */
export interface ImagePlane {
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

export interface ImageSnrResult {
  /**
   * Signal-to-noise ratio in decibels, or `null` when it is undefined.
   *
   * Undefined when either side of the ratio is zero inside the aperture: no
   * noise means there is nothing to compare against, and no signal means the
   * target is absent rather than the noise measured. Reported as `null` and
   * rendered as not measured — never as infinity, and never as 0 dB.
   */
  readonly snrDb: number | null;
  /** Pixels the aperture actually covered, after clipping to the image. */
  readonly aperturePixels: number;
  /** Summed squared signal inside the aperture. */
  readonly signalPower: number;
  /** Summed squared noise inside the aperture. */
  readonly noisePower: number;
}

/**
 * Measures SNR in a square aperture centred on the target's projected position.
 *
 * A box rather than a disc: the aperture is a bookkeeping boundary, and a
 * circular one would need a rule for partially covered pixels that changes the
 * answer without making it more meaningful. The half-width comes from the
 * metrics definition so that two reports quoting SNR agree on what was summed.
 *
 * @param noisy      the delivered frame
 * @param clean      the same frame with every stochastic effect disabled
 * @param background the deterministic background level at a pixel, in counts
 * @param centreX    target's projected centre; `null` when it does not project
 * @param radius     half-width of the aperture in pixels
 */
export function imageSnr(
  noisy: ImagePlane,
  clean: ImagePlane,
  background: (x: number, y: number) => number,
  centreX: number | null,
  centreY: number | null,
  radius: number,
): ImageSnrResult {
  const empty: ImageSnrResult = {
    snrDb: null,
    aperturePixels: 0,
    signalPower: 0,
    noisePower: 0,
  };
  if (centreX === null || centreY === null) return empty;
  if (noisy.data.length !== clean.data.length) return empty;

  const firstX = Math.max(0, Math.floor(centreX - radius));
  const lastX = Math.min(noisy.width - 1, Math.ceil(centreX + radius));
  const firstY = Math.max(0, Math.floor(centreY - radius));
  const lastY = Math.min(noisy.height - 1, Math.ceil(centreY + radius));
  if (firstX > lastX || firstY > lastY) return empty;

  let signalPower = 0;
  let noisePower = 0;
  let aperturePixels = 0;

  for (let y = firstY; y <= lastY; y += 1) {
    const row = y * noisy.width;
    for (let x = firstX; x <= lastX; x += 1) {
      const index = row + x;
      // Signal is the target's own contribution: the clean image less the
      // background it sits on. Counting the background as signal would let a
      // brighter sky improve the SNR, which is the opposite of what it does.
      const signal = clean.data[index]! - background(x, y);
      const noise = noisy.data[index]! - clean.data[index]!;
      signalPower += signal * signal;
      noisePower += noise * noise;
      aperturePixels += 1;
    }
  }

  // Undefined at both ends, and for opposite reasons. With no noise the ratio
  // has no denominator: a run with nothing stochastic in it has no
  // signal-to-noise ratio, and "infinity dB" would imply a measurement came back
  // unbounded. With no signal the ratio is zero and its decibel value is
  // unbounded below; that happens whenever the target is out of frame or fully
  // extinguished, which is a fact about the target rather than a measurement of
  // the noise. Both are reported as absent rather than as a clamped stand-in.
  const defined = noisePower > 0 && signalPower > 0;

  return {
    snrDb: defined ? 10 * Math.log10(signalPower / noisePower) : null,
    aperturePixels,
    signalPower,
    noisePower,
  };
}
