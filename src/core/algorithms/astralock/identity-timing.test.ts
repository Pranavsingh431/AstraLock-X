// @vitest-environment node
/**
 * Identity against camera timing it was not tuned for.
 *
 * Two questions, both about whether the correlator is doing real arithmetic or
 * has quietly baked in the bundled 60 fps / 2 ms configuration.
 *
 * **Frame rate.** Nothing in the receiver counts frames. It works in
 * timestamps, exposures and seconds, so a scenario at 30 or 90 fps with symbols
 * scaled to match should behave the same. A receiver that had assumed a frame
 * rate would fail here, and would have looked perfectly correct at 60.
 *
 * **Exposure length.** A short exposure rarely straddles a symbol boundary, so
 * a design that sampled the code at the capture instant instead of integrating
 * it would look right at the bundled 2 ms. Lengthen the exposure until a large
 * share of frames span a transition and the two designs diverge; the measured
 * correlation is printed, because what matters is how much is lost and whether
 * the verdict survives it.
 */

import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_ASTRALOCK_CONFIG, astraLockXPat } from '@/core/algorithms';
import { CODE_A } from '@/core/contracts/code-library';
import { parseSimulationConfig, type SimulationConfig } from '@/core/contracts/simulation';
import { ClosedLoopRuntime } from '@/core/runtime/closed-loop';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';
import { SimulationEngine } from '@/core/simulation/engine';
import { loadScenario } from '@/scenarios';

import type { AstraLockDebug } from './plugin';

vi.setConfig({ testTimeout: 900_000 });

/**
 * `code-clean` retimed: a given frame rate, a given exposure, and symbols a
 * fixed number of frames long.
 *
 * Only the timing changes. The geometry, the code, the intensities and the seed
 * are the scenario's own, so a difference in the result is a difference the
 * timing caused.
 */
function retimed(frameRate: number, framesPerSymbol: number, exposure: number): SimulationConfig {
  const base = loadScenario('code-clean');
  const symbolDuration = framesPerSymbol / frameRate;
  return parseSimulationConfig({
    ...base,
    camera: { ...base.camera, frameRate, exposure },
    targets: base.targets.map((target) => ({
      ...target,
      beacon:
        target.beacon === null
          ? null
          : {
              ...target.beacon,
              identityCode:
                target.beacon.identityCode === null
                  ? null
                  : { ...target.beacon.identityCode, symbolDuration },
            },
    })),
  });
}

/** Runs a retimed scenario to the end and reports the correlator's verdict. */
function verdictOf(config: SimulationConfig, symbolDuration: number, seconds: number) {
  const engine = new SimulationEngine(config);
  const sensor = new VirtualCameraSensor({ config });
  // The receiver is told the symbol duration the retimed transmitter uses —
  // the test sets both from the same parameters, explicitly. It does not read
  // the scenario to find out.
  const runtime = new ClosedLoopRuntime({
    engine,
    sensor,
    sampler: new ExactWorldSampler(engine),
    plugin: astraLockXPat,
    config: {
      ...DEFAULT_ASTRALOCK_CONFIG,
      identity: {
        ...DEFAULT_ASTRALOCK_CONFIG.identity,
        enabled: true,
        expectedSequence: [...CODE_A],
        symbolDuration,
      },
    },
  });

  let matched = 0;
  let frames = 0;
  for (let tick = 0; tick < seconds * (config.tickRate as number); tick += 1) {
    runtime.step(1);
    const debug = runtime.algorithmOutput?.debug as AstraLockDebug | undefined;
    if (debug === undefined) continue;
    frames += 1;
    if (debug.identityState === 'match') matched += 1;
  }

  const debug = runtime.algorithmOutput!.debug as AstraLockDebug;
  return {
    state: debug.identityState,
    correlation: debug.codeCorrelation,
    matchedFraction: frames === 0 ? 0 : matched / frames,
    mode: runtime.algorithmOutput!.pat.mode,
  };
}

describe('camera frame rate', () => {
  it('recognises the beacon at 30, 60 and 90 fps alike', () => {
    // Four frames per symbol in each case, so the code is equally observable
    // and only the clock differs. A receiver that had assumed 60 would be
    // reading the wrong symbol boundaries at the other two.
    const results = [30, 60, 90].map((fps) => ({
      fps,
      ...verdictOf(retimed(fps, 4, 0.002), 4 / fps, 32),
    }));

    // eslint-disable-next-line no-console -- the measured figures are the point
    console.log(
      results
        .map(
          (r) =>
            `  ${String(r.fps)} fps: ${String(r.state)} at ${r.correlation?.toFixed(3) ?? '—'}, matched on ${(r.matchedFraction * 100).toFixed(0)}% of frames`,
        )
        .join('\n'),
    );

    for (const result of results) {
      expect(result.state, `${String(result.fps)} fps`).toBe('match');
      expect(result.correlation!, `${String(result.fps)} fps`).toBeGreaterThan(0.8);
    }
  });

  it('refuses to load a code the camera could not resolve', () => {
    // One frame per symbol is below the Nyquist floor. The scenario is rejected
    // at load rather than rendered into an image nobody could read.
    expect(() => retimed(60, 1, 0.002)).toThrow(/at least two camera frame periods/);
    // Two frames per symbol is the floor, and is accepted.
    expect(() => retimed(60, 2, 0.002)).not.toThrow();
  });
});

describe('exposure length', () => {
  it('still recognises the beacon when most exposures straddle a symbol', () => {
    // Two frames per symbol — the Nyquist floor — with the shutter open for
    // almost the whole frame period: a 16 ms exposure against a 33.3 ms symbol.
    // Just under half of a symbol per frame, so a large share of exposures span
    // a transition and see an intermediate level. Sampling the code at the
    // capture instant would report a level the sensor never collected;
    // integrating it reports what it did.
    const brief = verdictOf(retimed(60, 2, 0.002), 2 / 60, 32);
    const long = verdictOf(retimed(60, 2, 0.016), 2 / 60, 32);

    // eslint-disable-next-line no-console -- the measured figures are the point
    console.log(
      `  2 ms exposure:  ${String(brief.state)} at ${brief.correlation?.toFixed(3) ?? '—'}\n` +
        `  16 ms exposure: ${String(long.state)} at ${long.correlation?.toFixed(3) ?? '—'}`,
    );

    expect(long.state).toBe('match');
    // Smearing costs contrast, so the score is expected to fall. It must fall
    // rather than stay put — an unchanged score would mean the exposure was not
    // being integrated at all.
    expect(long.correlation!).toBeLessThan(brief.correlation!);
  });
});
