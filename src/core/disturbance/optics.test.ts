// @vitest-environment node
/**
 * The optical and radiometric models, against answers derivable by hand.
 *
 * Every claim in docs/DISTURBANCE_MODEL.md that can be checked arithmetically is
 * checked here rather than asserted: an attenuation that uses the wrong decibel
 * convention still dims the image, a broadening that does not conserve energy
 * still looks blurred, and an exposure model that integrates the wrong window
 * still produces a streak. All three would be wrong and all three look right.
 */

import { describe, expect, it } from 'vitest';

import { CLEAN_DISTURBANCES, type DisturbanceConfig } from '@/core/contracts/disturbance';
import type { SimulationSeed } from '@/core/contracts/simulation';
import {
  addGaussianPointSourceFloat,
  energyPreservingPeak,
  type FloatRasterTarget,
} from '@/core/sensors/psf';

import { DisturbanceStack } from './stack';

const seed = (value: number): SimulationSeed => value as SimulationSeed;

function stackWith(patch: (base: DisturbanceConfig) => DisturbanceConfig): DisturbanceStack {
  return new DisturbanceStack(patch(structuredClone(CLEAN_DISTURBANCES)), seed(99), 60);
}

describe('atmospheric attenuation', () => {
  const withDb = (dbPerKm: number) =>
    stackWith((base) => ({
      ...base,
      atmosphere: { ...base.atmosphere, attenuation: { enabled: true, dbPerKm } },
    }));

  // The whole point of stating the convention: decibels here are intensity, so
  // exactly half is 10*log10(2) = 3.0103 dB. Under the 20log10 field convention
  // that same figure would be 0.707, and the difference between the two is
  // invisible in a rendered frame.
  it('halves the intensity at 10*log10(2) dB of path loss', () => {
    expect(withDb(10 * Math.log10(2)).transmittanceOver(1000)).toBeCloseTo(0.5, 12);
  });

  it('gives a round 3 dB the 0.5012 it actually implies, not a tidied 0.5', () => {
    expect(withDb(3).transmittanceOver(1000)).toBeCloseTo(0.501_187_233_6, 9);
  });

  it.each([
    [10, 1000, 0.1],
    [20, 1000, 0.01],
    [10, 500, 0.316_227_766],
    [1, 2000, 0.630_957_344],
  ])('gives %s dB/km over %s m a transmittance of %s', (dbPerKm, range, expected) => {
    expect(withDb(dbPerKm).transmittanceOver(range)).toBeCloseTo(expected, 8);
  });

  it('is exactly one at zero range and with the effect disabled', () => {
    expect(withDb(50).transmittanceOver(0)).toBe(1);
    expect(stackWith((base) => base).transmittanceOver(5000)).toBe(1);
  });

  it('stays within (0, 1] over any range a scenario could ask for', () => {
    const stack = withDb(7);
    for (const range of [0, 1, 100, 10_000, 100_000]) {
      const transmittance = stack.transmittanceOver(range);
      expect(transmittance).toBeGreaterThan(0);
      expect(transmittance).toBeLessThanOrEqual(1);
    }
  });

  // A limit of double precision, not of the model, and the honest answer
  // anyway: 7000 dB of path loss extinguishes the beacon completely. Recorded
  // as a test so it is a known property rather than a surprise.
  it('underflows to exactly zero at absurd path loss rather than to a denormal', () => {
    const transmittance = withDb(7).transmittanceOver(1e6);
    expect(transmittance).toBe(0);
    expect(Number.isNaN(transmittance)).toBe(false);
  });
});

describe('scintillation', () => {
  const withSigma = (logAmplitudeSigma: number, correlationTime = 0.05) =>
    stackWith((base) => ({
      ...base,
      atmosphere: {
        ...base.atmosphere,
        scintillation: {
          enabled: true,
          logAmplitudeSigma,
          correlationTime: correlationTime as never,
        },
      },
    }));

  function gains(stack: DisturbanceStack, count: number): number[] {
    return Array.from({ length: count }, (_, index) => stack.scintillationAt(index));
  }

  // The -sigma^2/2 normalisation. Without it, enabling scintillation would also
  // brighten the image, and the effect would be inseparable from a gain change.
  it('has mean gain near one, so it changes variance and not brightness', () => {
    const values = gains(withSigma(0.3), 40_000);
    const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
    expect(mean).toBeGreaterThan(0.96);
    expect(mean).toBeLessThan(1.04);
  });

  it('fluctuates more deeply the larger its configured strength', () => {
    const spread = (sigma: number): number => {
      const values = gains(withSigma(sigma), 30_000);
      const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
      return Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / values.length);
    };
    expect(spread(0.1)).toBeLessThan(spread(0.3));
    expect(spread(0.3)).toBeLessThan(spread(0.6));
  });

  it('is temporally correlated rather than redrawn each frame', () => {
    const slow = gains(withSigma(0.3, 1), 5000);
    let sameSign = 0;
    for (let index = 1; index < slow.length; index += 1) {
      if (Math.sign(slow[index]! - 1) === Math.sign(slow[index - 1]! - 1)) sameSign += 1;
    }
    // Independent draws would cross the mean about half the time. A one-second
    // correlation at 60 fps should stay on one side far longer.
    expect(sameSign / (slow.length - 1)).toBeGreaterThan(0.9);
  });

  it('correlates over the time it was told to', () => {
    const crossings = (correlationTime: number): number => {
      const values = gains(withSigma(0.3, correlationTime), 20_000);
      let count = 0;
      for (let index = 1; index < values.length; index += 1) {
        if (values[index]! > 1 !== values[index - 1]! > 1) count += 1;
      }
      return count;
    };
    expect(crossings(0.02)).toBeGreaterThan(crossings(0.5));
  });

  it('is exactly one when disabled', () => {
    const stack = stackWith((base) => base);
    for (let index = 0; index < 100; index += 1) expect(stack.scintillationAt(index)).toBe(1);
  });

  it('is always strictly positive: a log-normal gain cannot go dark', () => {
    const stack = withSigma(0.9);
    let nonPositive = 0;
    for (let index = 0; index < 20_000; index += 1) {
      if (!(stack.scintillationAt(index) > 0)) nonPositive += 1;
    }
    expect(nonPositive).toBe(0);
  });
});

describe('angular wander', () => {
  const withWander = (rms: number, correlationTime = 0.5) =>
    stackWith((base) => ({
      ...base,
      atmosphere: {
        ...base.atmosphere,
        wander: { enabled: true, rms: rms as never, correlationTime: correlationTime as never },
      },
    }));

  it('has the RMS it was configured with, on both components', () => {
    const stack = withWander(50e-6);
    const azimuth: number[] = [];
    const elevation: number[] = [];
    for (let index = 0; index < 40_000; index += 1) {
      const offset = stack.wanderAt(index);
      azimuth.push(offset.azimuth);
      elevation.push(offset.elevation);
    }
    const rms = (values: number[]): number =>
      Math.sqrt(values.reduce((sum, value) => sum + value * value, 0) / values.length);

    expect(rms(azimuth)).toBeGreaterThan(40e-6);
    expect(rms(azimuth)).toBeLessThan(60e-6);
    expect(rms(elevation)).toBeGreaterThan(40e-6);
    expect(rms(elevation)).toBeLessThan(60e-6);
  });

  it('keeps its two components independent', () => {
    const stack = withWander(50e-6);
    let dot = 0;
    let azimuthEnergy = 0;
    let elevationEnergy = 0;
    for (let index = 0; index < 30_000; index += 1) {
      const offset = stack.wanderAt(index);
      dot += offset.azimuth * offset.elevation;
      azimuthEnergy += offset.azimuth * offset.azimuth;
      elevationEnergy += offset.elevation * offset.elevation;
    }
    const correlation = dot / Math.sqrt(azimuthEnergy * elevationEnergy);
    expect(Math.abs(correlation)).toBeLessThan(0.05);
  });

  it('is exactly zero when disabled', () => {
    const stack = stackWith((base) => base);
    expect(stack.wanderAt(42)).toEqual({ azimuth: 0, elevation: 0 });
  });
});

describe('defocus and point-spread broadening', () => {
  it('adds in quadrature', () => {
    const stack = stackWith((base) => ({
      ...base,
      optics: { ...base.optics, defocus: { enabled: true, extraSigma: 4 as never } },
    }));
    expect(stack.spreadFor(3)).toBeCloseTo(5, 12);
  });

  it('leaves the spread alone when disabled', () => {
    expect(stackWith((base) => base).spreadFor(2.5)).toBe(2.5);
  });

  // Broadening at a fixed peak would create light. The integral of a Gaussian is
  // peak * 2*pi*sigma^2, so the peak has to fall as sigma^2 rises.
  it('preserves total energy when a spot is broadened', () => {
    const target = (): FloatRasterTarget => ({
      data: new Float64Array(201 * 201),
      width: 201,
      height: 201,
    });
    const total = (image: FloatRasterTarget): number =>
      image.data.reduce((sum, value) => sum + value, 0);

    const sharp = target();
    addGaussianPointSourceFloat(sharp, 100.5, 100.5, 200, 2);

    const broad = target();
    addGaussianPointSourceFloat(broad, 100.5, 100.5, energyPreservingPeak(200, 2, 6), 6);

    // Both kernels are truncated at three sigma, so a few per cent of the tail
    // is missing from each; the comparison is between the energies that landed.
    expect(total(broad) / total(sharp)).toBeGreaterThan(0.97);
    expect(total(broad) / total(sharp)).toBeLessThan(1.03);
  });

  it('lowers the peak as the spot widens', () => {
    expect(energyPreservingPeak(100, 2, 4)).toBeCloseTo(25, 10);
    expect(energyPreservingPeak(100, 2, 2)).toBeCloseTo(100, 10);
  });
});

describe('ambient background', () => {
  const withBackground = (level: number, gradient: number, gradientAngle = 0) =>
    stackWith((base) => ({
      ...base,
      optics: {
        ...base.optics,
        background: {
          enabled: true,
          level: level as never,
          gradient: gradient as never,
          gradientAngle: gradientAngle as never,
        },
      },
    }));

  it('is uniform with no gradient', () => {
    const stack = withBackground(0.2, 0);
    expect(stack.backgroundAt(0, 0, 640, 480, 255)).toBeCloseTo(51, 10);
    expect(stack.backgroundAt(639, 479, 640, 480, 255)).toBeCloseTo(51, 10);
  });

  // A gradient changes the shape of the background, not how much of it there is.
  it('keeps its mean level when a gradient is added', () => {
    const stack = withBackground(0.2, 0.1);
    let total = 0;
    for (let y = 0; y < 480; y += 1) {
      for (let x = 0; x < 640; x += 1) total += stack.backgroundAt(x, y, 640, 480, 255);
    }
    expect(total / (640 * 480)).toBeCloseTo(51, 1);
  });

  it('ramps along the configured direction', () => {
    const horizontal = withBackground(0.3, 0.2, 0);
    expect(horizontal.backgroundAt(0, 240, 640, 480, 255)).toBeLessThan(
      horizontal.backgroundAt(639, 240, 640, 480, 255),
    );
    // Rotated a quarter turn, the ramp runs down the image instead of across it.
    const vertical = withBackground(0.3, 0.2, Math.PI / 2);
    expect(vertical.backgroundAt(320, 0, 640, 480, 255)).toBeLessThan(
      vertical.backgroundAt(320, 479, 640, 480, 255),
    );
  });

  it('never goes negative', () => {
    const stack = withBackground(0.02, 1);
    for (let x = 0; x < 640; x += 37) {
      expect(stack.backgroundAt(x, 10, 640, 480, 255)).toBeGreaterThanOrEqual(0);
    }
  });

  it('contributes nothing when disabled', () => {
    expect(stackWith((base) => base).backgroundAt(10, 10, 640, 480, 255)).toBe(0);
  });
});

describe('frame dropouts', () => {
  const independent = (probability: number) =>
    stackWith((base) => ({
      ...base,
      dropouts: { ...base.dropouts, mode: 'independent', probability: probability as never },
    }));

  it('drops nothing at zero probability', () => {
    const stack = independent(0);
    for (let index = 0; index < 5000; index += 1) expect(stack.isDroppedAt(index)).toBe(false);
  });

  it('drops everything at probability one', () => {
    const stack = independent(1);
    for (let index = 0; index < 5000; index += 1) expect(stack.isDroppedAt(index)).toBe(true);
  });

  it('drops about the configured fraction', () => {
    const stack = independent(0.25);
    let dropped = 0;
    for (let index = 0; index < 40_000; index += 1) if (stack.isDroppedAt(index)) dropped += 1;
    expect(dropped / 40_000).toBeGreaterThan(0.23);
    expect(dropped / 40_000).toBeLessThan(0.27);
  });

  it('is a pure function of the frame index, so skipping frames cannot change it', () => {
    const stack = independent(0.3);
    const forwards = Array.from({ length: 500 }, (_, index) => stack.isDroppedAt(index));
    const again = new DisturbanceStack(
      {
        ...CLEAN_DISTURBANCES,
        dropouts: {
          ...CLEAN_DISTURBANCES.dropouts,
          mode: 'independent',
          probability: 0.3 as never,
        },
      },
      seed(99),
      60,
    );
    // Asked only about the last index, with every earlier one skipped.
    expect(again.isDroppedAt(499)).toBe(forwards[499]);
  });

  it('drops nothing in none mode whatever the probability says', () => {
    const stack = stackWith((base) => ({
      ...base,
      dropouts: { ...base.dropouts, mode: 'none', probability: 0.9 as never },
    }));
    for (let index = 0; index < 1000; index += 1) expect(stack.isDroppedAt(index)).toBe(false);
  });
});

describe('the stack as a whole', () => {
  it('reports a clean configuration as clean and allocates nothing for it', () => {
    expect(stackWith((base) => base).isClean).toBe(true);
  });

  it('gives every stream a distinct derived seed, recorded for the experiment', () => {
    const seeds = stackWith((base) => base).streamSeeds();
    expect(Object.keys(seeds)).toHaveLength(6);
    expect(new Set(Object.values(seeds)).size).toBe(6);
  });

  it('reproduces its whole realization from the seed alone', () => {
    const build = () =>
      new DisturbanceStack(
        {
          ...CLEAN_DISTURBANCES,
          preset: 'TEST',
          atmosphere: {
            attenuation: { enabled: true, dbPerKm: 2 },
            scintillation: { enabled: true, logAmplitudeSigma: 0.2, correlationTime: 0.1 as never },
            wander: { enabled: true, rms: 30e-6 as never, correlationTime: 0.5 as never },
          },
        },
        seed(31_337),
        60,
      );

    const first = build();
    const second = build();
    for (let index = 0; index < 400; index += 1) {
      expect(second.realizationAt(index, index / 60)).toEqual(
        first.realizationAt(index, index / 60),
      );
    }
  });

  it('refuses a frame rate that is not positive', () => {
    expect(() => new DisturbanceStack(CLEAN_DISTURBANCES, seed(1), 0)).toThrow(RangeError);
  });
});
