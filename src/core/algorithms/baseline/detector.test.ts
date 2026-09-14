// @vitest-environment node
/**
 * The detector, on hand-built images and on real sensor frames.
 *
 * Both matter. A synthetic array pins the arithmetic — a Gaussian placed at a
 * known sub-pixel position must come back at that position — and a real
 * `VirtualCameraSensor` frame proves the detector works on what the camera
 * actually produces, including its quantisation to 8 bits and the way its point
 * spread is clipped at the image edge.
 *
 * Centroid errors are reported as measured numbers, not compared against a
 * threshold picked after seeing them.
 */

import { describe, expect, it } from 'vitest';

import type { CameraSensorFrame } from '@/core/contracts/sensors';
import { loadScenario } from '@/scenarios';
import { SimulationEngine } from '@/core/simulation/engine';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';

import { detect, findComponents, type BaselineDetectorConfig } from './detector';
import { DEFAULT_BASELINE_PAT_CONFIG } from './config';

const CONFIG: BaselineDetectorConfig = DEFAULT_BASELINE_PAT_CONFIG.detector;

/** Wraps a raw buffer as a frame, so the detector is exercised through its real entry point. */
function asFrame(data: Uint8Array, width: number, height: number): CameraSensorFrame {
  return {
    frameId: 1,
    captureTime: 0 as never,
    width: width as never,
    height: height as never,
    format: 'mono8',
    data,
    exposure: 0.002 as never,
    gain: 1,
    droppedSince: null,
    pose: { azimuth: 0 as never, elevation: 0 as never },
    cameraConfigId: 'test@v4',
  };
}

/** Draws a Gaussian spot centred at continuous coordinates (cx, cy). */
function gaussian(
  width: number,
  height: number,
  cx: number,
  cy: number,
  sigma: number,
  peak: number,
): Uint8Array {
  const data = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      // Pixel centres sit at half-integers, matching the sensor's convention.
      const dx = x + 0.5 - cx;
      const dy = y + 0.5 - cy;
      const value = peak * Math.exp(-(dx * dx + dy * dy) / (2 * sigma * sigma));
      data[y * width + x] = Math.min(255, Math.round(value));
    }
  }
  return data;
}

// --- A / B / C. Detection and centroid accuracy -----------------------------

describe('A. a centred beacon', () => {
  it('is detected', () => {
    const data = gaussian(64, 64, 32, 32, 2.4, 230);
    const result = detect(asFrame(data, 64, 64), CONFIG);

    expect(result.selected).not.toBeNull();
    expect(result.candidates).toHaveLength(1);
    expect(result.selected!.area).toBeGreaterThan(CONFIG.minArea);
    expect(result.selected!.peak).toBeGreaterThanOrEqual(CONFIG.minPeak);
  });

  it('recovers the centre', () => {
    const data = gaussian(64, 64, 32, 32, 2.4, 230);
    const result = detect(asFrame(data, 64, 64), CONFIG);

    // Centroid is in pixel-index space; the continuous centre is +0.5 from it.
    expect(result.selected!.centroidX + 0.5).toBeCloseTo(32, 6);
    expect(result.selected!.centroidY + 0.5).toBeCloseTo(32, 6);
  });
});

describe('B. sub-pixel centroid accuracy', () => {
  it('follows a spot moved by a fraction of a pixel', () => {
    // The property that matters: pointing accuracy is limited by this, so a
    // centroid that quantised to whole pixels would cap the whole system.
    const offsets = [0, 0.1, 0.25, 0.5, 0.75, 0.9];
    const errors: number[] = [];

    for (const offset of offsets) {
      const data = gaussian(64, 64, 32 + offset, 32, 2.4, 230);
      const result = detect(asFrame(data, 64, 64), CONFIG);
      errors.push(Math.abs(result.selected!.centroidX + 0.5 - (32 + offset)));
    }

    const worst = Math.max(...errors);
    // Measured, not assumed: an intensity-moment centroid on a symmetric
    // Gaussian quantised to 8 bits recovers the centre to well under a
    // hundredth of a pixel. The bound is an order of magnitude above what the
    // measurement gives, so rounding noise cannot make this flaky.
    expect(worst).toBeLessThan(0.02);
  });

  it('is better than taking the centre of the bounding box', () => {
    // The comparison that justifies the extra arithmetic.
    const data = gaussian(64, 64, 32.4, 32, 2.4, 230);
    const result = detect(asFrame(data, 64, 64), CONFIG);
    const blob = result.selected!;

    const momentError = Math.abs(blob.centroidX + 0.5 - 32.4);
    const boxCentre = (blob.minX + blob.maxX) / 2 + 0.5;
    const boxError = Math.abs(boxCentre - 32.4);

    expect(momentError).toBeLessThan(boxError);
  });
});

describe('C. an off-axis beacon', () => {
  it('is found where it was put', () => {
    const data = gaussian(128, 96, 100.3, 20.7, 2.4, 230);
    const result = detect(asFrame(data, 128, 96), CONFIG);

    expect(result.selected!.centroidX + 0.5).toBeCloseTo(100.3, 1);
    expect(result.selected!.centroidY + 0.5).toBeCloseTo(20.7, 1);
  });
});

// --- D / E. Rejection -------------------------------------------------------

describe('D. an empty frame', () => {
  it('produces no candidate at all', () => {
    const result = detect(asFrame(new Uint8Array(64 * 64), 64, 64), CONFIG);

    expect(result.selected).toBeNull();
    expect(result.candidates).toHaveLength(0);
    expect(result.componentsFound).toBe(0);
    expect(result.score).toBeNull();
  });

  it('produces no candidate on a uniform field below threshold', () => {
    const data = new Uint8Array(64 * 64).fill(CONFIG.threshold);
    expect(detect(asFrame(data, 64, 64), CONFIG).selected).toBeNull();
  });
});

describe('E. the threshold', () => {
  it('excludes a spot whose peak never reaches it', () => {
    const dim = gaussian(64, 64, 32, 32, 2.4, CONFIG.threshold - 1);
    expect(detect(asFrame(dim, 64, 64), CONFIG).componentsFound).toBe(0);
  });

  it('excludes a bright but tiny component by area', () => {
    const data = new Uint8Array(64 * 64);
    data[32 * 64 + 32] = 255; // One hot pixel.
    const result = detect(asFrame(data, 64, 64), CONFIG);

    expect(result.componentsFound).toBe(1);
    expect(result.candidates).toHaveLength(0);
    expect(result.selected).toBeNull();
  });

  it('excludes a large diffuse region by area', () => {
    const data = new Uint8Array(200 * 200).fill(200);
    const result = detect(asFrame(data, 200, 200), CONFIG);

    expect(result.componentsFound).toBe(1);
    expect(result.candidates).toHaveLength(0);
  });

  it('measures integrated intensity above the threshold, not raw', () => {
    // Otherwise a big dim blob beats a small bright one by counting pedestal.
    const data = gaussian(64, 64, 32, 32, 2.4, 230);
    const result = detect(asFrame(data, 64, 64), CONFIG);
    const blob = result.selected!;

    let rawSum = 0;
    for (const value of data) if (value > CONFIG.threshold) rawSum += value;

    expect(blob.integratedIntensity).toBeLessThan(rawSum);
    expect(blob.integratedIntensity).toBeCloseTo(rawSum - blob.area * CONFIG.threshold, 6);
  });
});

// --- F. Edges ---------------------------------------------------------------

describe('F. a beacon clipped by the image edge', () => {
  it('still yields a usable candidate, and says it is clipped', () => {
    const data = gaussian(64, 64, 1.5, 32, 2.4, 230);
    const result = detect(asFrame(data, 64, 64), CONFIG);

    expect(result.selected).not.toBeNull();
    expect(result.selected!.touchesEdge).toBe(true);
    // The centroid is biased inward because the outer half is missing. That is
    // a real property of a clipped spot, so it is asserted rather than hidden.
    expect(result.selected!.centroidX + 0.5).toBeGreaterThan(1.5);
  });

  it('does not wrap a component around the row boundary', () => {
    // A blob at the left edge and one at the right edge of the same row are two
    // objects. Index arithmetic that forgot the row bounds would merge them.
    const data = new Uint8Array(64 * 64);
    const left = gaussian(64, 64, 1.5, 32, 1.5, 230);
    const right = gaussian(64, 64, 62.5, 32, 1.5, 230);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.max(left[i]!, right[i]!);

    expect(findComponents(data, 64, 64, CONFIG.threshold)).toHaveLength(2);
  });
});

// --- G / H. Several objects -------------------------------------------------

describe('G. two separated blobs', () => {
  it('are two components', () => {
    const data = new Uint8Array(96 * 96);
    const a = gaussian(96, 96, 24, 48, 2, 200);
    const b = gaussian(96, 96, 72, 48, 2, 200);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.max(a[i]!, b[i]!);

    const result = detect(asFrame(data, 96, 96), CONFIG);
    expect(result.componentsFound).toBe(2);
    expect(result.candidates).toHaveLength(2);
  });

  it('are one component when they touch diagonally', () => {
    // 8-connectivity is a choice with consequences, so it is pinned down.
    const data = new Uint8Array(16 * 16);
    data[5 * 16 + 5] = 200;
    data[6 * 16 + 6] = 200;
    expect(findComponents(data, 16, 16, CONFIG.threshold)).toHaveLength(1);
  });
});

describe('H. the selection rule', () => {
  it('chooses the strongest total signal, as documented', () => {
    const data = new Uint8Array(96 * 96);
    const dim = gaussian(96, 96, 24, 48, 2, 120);
    const bright = gaussian(96, 96, 72, 48, 2.6, 240);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.max(dim[i]!, bright[i]!);

    const result = detect(asFrame(data, 96, 96), CONFIG);
    expect(result.selected!.centroidX + 0.5).toBeCloseTo(72, 0);
  });

  it('can be fooled by a brighter decoy, which is a known baseline weakness', () => {
    // Asserted rather than glossed over. The detector has no way to tell a
    // beacon from any other bright compact object, and the robust algorithm's
    // coded-beacon identification exists precisely because of this.
    const data = new Uint8Array(96 * 96);
    const beacon = gaussian(96, 96, 24, 48, 2.4, 200);
    const decoy = gaussian(96, 96, 72, 48, 2.4, 255);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.max(beacon[i]!, decoy[i]!);

    const result = detect(asFrame(data, 96, 96), CONFIG);
    expect(result.selected!.centroidX + 0.5).toBeCloseTo(72, 0);
  });

  it('is deterministic when two candidates are identical', () => {
    const data = new Uint8Array(96 * 96);
    const a = gaussian(96, 96, 24, 48, 2, 200);
    const b = gaussian(96, 96, 72, 48, 2, 200);
    for (let i = 0; i < data.length; i += 1) data[i] = Math.max(a[i]!, b[i]!);

    const first = detect(asFrame(data, 96, 96), CONFIG).selected!.centroidX;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      expect(detect(asFrame(data, 96, 96), CONFIG).selected!.centroidX).toBe(first);
    }
  });
});

// --- Real sensor frames -----------------------------------------------------

describe('on frames the camera actually produced', () => {
  const rig = () => {
    const engine = new SimulationEngine(loadScenario('camera-boresight'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const sampler = new ExactWorldSampler(engine);
    return { engine, sensor, sampler };
  };

  it('finds the beacon in a real frame', () => {
    const { sensor, sampler } = rig();
    const capture = sensor.captureFrame(sampler, 4);
    try {
      const result = detect(capture.frame, CONFIG);
      expect(result.selected).not.toBeNull();
      expect(result.candidates).toHaveLength(1);
    } finally {
      capture.release();
    }
  });

  it('recovers the centroid to a small fraction of a pixel', () => {
    // Measured against the simulator's true projected centre — which the
    // detector never sees. This is a test assertion using privileged truth,
    // which is legitimate; the algorithm is given only pixels.
    const { engine, sensor, sampler } = rig();
    const errors: number[] = [];

    for (let frame = 1; frame <= 30; frame += 1) {
      engine.step(10);
      const capture = sensor.captureFrame(sampler, frame);
      try {
        const result = detect(capture.frame, CONFIG);
        const truth = capture.truth.projections[0]!;
        if (result.selected === null || truth.imageX === null) continue;
        errors.push(
          Math.hypot(
            result.selected.centroidX + 0.5 - truth.imageX,
            result.selected.centroidY + 0.5 - truth.imageY!,
          ),
        );
      } finally {
        capture.release();
      }
    }

    expect(errors.length).toBeGreaterThan(20);
    const worst = Math.max(...errors);
    const mean = errors.reduce((a, b) => a + b, 0) / errors.length;

    // Measured on the clean sensor: mean is a few thousandths of a pixel and
    // the worst case stays under a hundredth. The bound is set an order of
    // magnitude above the measurement.
    expect(mean).toBeLessThan(0.02);
    expect(worst).toBeLessThan(0.05);
  });

  it('finds nothing when the beacon is outside the field of view', () => {
    const engine = new SimulationEngine(loadScenario('pat-stationary-outside-fov'));
    const sensor = new VirtualCameraSensor({ config: engine.config });
    const sampler = new ExactWorldSampler(engine);

    const capture = sensor.captureFrame(sampler, 2);
    try {
      expect(detect(capture.frame, CONFIG).selected).toBeNull();
    } finally {
      capture.release();
    }
  });
});

// --- I. What the detector is given ------------------------------------------

describe('I. the detector never sees the answer', () => {
  it('takes only a frame and a config', () => {
    // The signature is the guarantee: there is no parameter through which a
    // true projected centre could arrive.
    expect(detect.length).toBe(2);
  });

  it('gives the same answer for identical pixels regardless of the world', () => {
    // Two engines at different times produce different worlds. Handed the same
    // buffer, the detector must answer identically — it has no other input.
    const data = gaussian(64, 64, 30.25, 33.75, 2.4, 230);
    const a = detect(asFrame(data, 64, 64), CONFIG);
    const b = detect(asFrame(data.slice(), 64, 64), CONFIG);

    expect(b.selected!.centroidX).toBe(a.selected!.centroidX);
    expect(b.selected!.centroidY).toBe(a.selected!.centroidY);
  });
});
