/**
 * Classical beacon detection on raw GRAY8 pixels.
 *
 * Threshold, label connected components, measure each one, filter, choose. No
 * model, no training, no ground truth: the only input is the intensity buffer
 * the camera produced and the numbers in {@link BaselineDetectorConfig}.
 *
 * The detector is deliberately simple, and its selection rule — brightest by
 * integrated intensity — is deliberately naive. It has no way to tell a beacon
 * from any other bright compact object, which is exactly the weakness that
 * motivates coded beacon identification later. Making it cleverer now would
 * remove the baseline that the robust algorithm has to beat.
 *
 * See docs/BASELINE_PAT.md.
 */

import type { CameraSensorFrame, PixelBuffer } from '@/core/contracts/sensors';
import type { Pixels } from '@/core/contracts/units';
import { pixels } from '@/core/contracts/units';

/**
 * One labelled bright region, measured.
 *
 * Every field is derived from pixels. `centroid` uses first-order intensity
 * moments rather than the centre of the bounding box: a Gaussian point spread
 * straddling two pixels has its energy distributed between them, and the
 * moment recovers where the spot actually sits to a fraction of a pixel, while
 * the box centre quantises to half-pixel steps and would cap pointing accuracy
 * at the sensor's own pixel pitch.
 */
export interface BlobMeasurement {
  /** Number of pixels above threshold. */
  readonly area: number;
  /** Largest sample in the component, in raw format units. */
  readonly peak: number;
  /**
   * Sum of `sample − threshold` over the component.
   *
   * Background-subtracted on purpose: summing raw samples would make a large
   * dim region beat a small bright one purely by counting pedestal, which is
   * not what "brighter" means.
   */
  readonly integratedIntensity: number;
  /** Intensity-weighted centroid, in continuous image coordinates. */
  readonly centroidX: number;
  readonly centroidY: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
  /** True when the component touches the image border. */
  readonly touchesEdge: boolean;
}

/** What the detector decided about one frame. */
export interface DetectionResult {
  /** Components that passed every filter, in discovery order. */
  readonly candidates: readonly BlobMeasurement[];
  /** The one the selection rule picked, or `null` if none qualified. */
  readonly selected: BlobMeasurement | null;
  /**
   * Score of the selected candidate on [0, 1], or `null` when none was picked.
   *
   * **Not a probability.** It is the selected component's integrated intensity
   * expressed as a fraction of the brightest response the frame could
   * physically hold — `area × (fullScale − threshold)` — so it says how strong
   * this detection is relative to a saturated blob of the same size, and
   * nothing about how likely it is to be the real beacon. Calling it a
   * confidence would be inventing a statistic.
   */
  readonly score: number | null;
  /** Components found before filtering. Reported so rejection is visible. */
  readonly componentsFound: number;
}

/**
 * Detector thresholds, in the units the sensor actually reports.
 *
 * Intensities are raw format samples (0–255 for `mono8`), not normalised, so a
 * threshold means the same thing as a pixel value an operator can read off the
 * monitor.
 */
export interface BaselineDetectorConfig {
  /** Samples at or below this are background. */
  readonly threshold: number;
  /** Components smaller than this are noise. */
  readonly minArea: number;
  /** Components larger than this are not a point source. */
  readonly maxArea: number;
  /** Reject a component whose brightest pixel is below this. */
  readonly minPeak: number;
  /** Reject a component whose background-subtracted sum is below this. */
  readonly minIntegratedIntensity: number;
}

/** Largest value each supported format can hold. */
const FULL_SCALE: Record<string, number> = { mono8: 255, mono16: 65535 };

/**
 * Labels 8-connected components above `threshold` and measures each.
 *
 * 8-connectivity rather than 4: a Gaussian point spread sampled onto a pixel
 * grid routinely has diagonal neighbours in its skirt, and 4-connectivity
 * would split one beacon into several slivers, each below the minimum area.
 *
 * Iterative flood fill with an explicit stack, not recursion — a large
 * saturated region in a 640×480 frame is 300k pixels deep and would overflow
 * the call stack.
 */
export function findComponents(
  data: PixelBuffer,
  width: number,
  height: number,
  threshold: number,
): readonly BlobMeasurement[] {
  const total = width * height;
  const visited = new Uint8Array(total);
  const stack: number[] = [];
  const components: BlobMeasurement[] = [];

  for (let seed = 0; seed < total; seed += 1) {
    if (visited[seed] === 1) continue;
    const seedValue = data[seed]!;
    if (seedValue <= threshold) {
      visited[seed] = 1;
      continue;
    }

    let area = 0;
    let peak = 0;
    let weightSum = 0;
    let weightedX = 0;
    let weightedY = 0;
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;

    visited[seed] = 1;
    stack.push(seed);

    while (stack.length > 0) {
      const index = stack.pop()!;
      const value = data[index]!;
      const x = index % width;
      const y = (index - x) / width;

      const weight = value - threshold;
      area += 1;
      if (value > peak) peak = value;
      weightSum += weight;
      weightedX += weight * x;
      weightedY += weight * y;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;

      const left = x > 0;
      const right = x < width - 1;
      const up = y > 0;
      const down = y < height - 1;

      for (let dy = -1; dy <= 1; dy += 1) {
        if (dy === -1 && !up) continue;
        if (dy === 1 && !down) continue;
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dy === 0) continue;
          if (dx === -1 && !left) continue;
          if (dx === 1 && !right) continue;

          const neighbour = index + dy * width + dx;
          if (visited[neighbour] === 1) continue;
          visited[neighbour] = 1;
          if (data[neighbour]! > threshold) stack.push(neighbour);
        }
      }
    }

    // A component of pixels all exactly one unit above threshold still has a
    // positive weight sum; a zero sum is only possible if the component is
    // empty, which the seed check already excludes. Guarded anyway, because a
    // NaN centroid would propagate into the filter and never come back.
    const centroidX = weightSum > 0 ? weightedX / weightSum : (minX + maxX) / 2;
    const centroidY = weightSum > 0 ? weightedY / weightSum : (minY + maxY) / 2;

    components.push({
      area,
      peak,
      integratedIntensity: weightSum,
      centroidX,
      centroidY,
      minX,
      minY,
      maxX,
      maxY,
      touchesEdge: minX === 0 || minY === 0 || maxX === width - 1 || maxY === height - 1,
    });
  }

  return components;
}

/**
 * Runs the whole detector over one frame.
 *
 * Reads `frame.data` directly — the authoritative sensor buffer, not anything a
 * canvas produced.
 */
export function detect(frame: CameraSensorFrame, config: BaselineDetectorConfig): DetectionResult {
  const components = findComponents(frame.data, frame.width, frame.height, config.threshold);

  const candidates = components.filter(
    (blob) =>
      blob.area >= config.minArea &&
      blob.area <= config.maxArea &&
      blob.peak >= config.minPeak &&
      blob.integratedIntensity >= config.minIntegratedIntensity,
  );

  // The documented selection rule: strongest total signal. Purely image-based,
  // uses no identity, and is wrong whenever something brighter than the beacon
  // is in view — which is the point. Ties break on the earlier component so the
  // choice is deterministic under an equal-brightness pair.
  let selected: BlobMeasurement | null = null;
  for (const blob of candidates) {
    if (selected === null || blob.integratedIntensity > selected.integratedIntensity) {
      selected = blob;
    }
  }

  const fullScale = FULL_SCALE[frame.format] ?? 255;
  const headroom = fullScale - config.threshold;
  const score =
    selected === null || headroom <= 0
      ? null
      : Math.min(1, selected.integratedIntensity / (selected.area * headroom));

  return { candidates, selected, score, componentsFound: components.length };
}

/** Bounding box of a measurement, as image-space pixels. */
export const blobBounds = (
  blob: BlobMeasurement,
): { x: Pixels; y: Pixels; width: Pixels; height: Pixels } => ({
  x: pixels(blob.minX),
  y: pixels(blob.minY),
  width: pixels(blob.maxX - blob.minX + 1),
  height: pixels(blob.maxY - blob.minY + 1),
});
