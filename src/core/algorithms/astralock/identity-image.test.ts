// @vitest-environment node
/**
 * Beacon identity on **real pixels**.
 *
 * The unit tests in `identity.test.ts` feed the correlator a brightness series
 * built by arithmetic, which proves the mathematics and nothing else. These
 * tests run the whole chain instead: a scenario's emitter is modulated in the
 * simulator, integrated over a finite camera exposure, rasterised into a GRAY8
 * frame, found by the ordinary detector, and only then correlated.
 *
 * That chain is where the real losses are. The detector reports a
 * background-subtracted integral, which is a *nonlinear* function of the
 * emitted level — as a source dims, pixels drop below the threshold and stop
 * contributing at all — so an ideal 1.0 is not achievable and the measured
 * figure here is the honest one.
 *
 * Nothing in this file is given to the tracker. The scenario's true code and
 * phase are read only to check the recovered answer against them, which is what
 * a test is allowed to do and the algorithm is not.
 */

import { describe, expect, it } from 'vitest';

import { detect } from '@/core/algorithms/baseline/detector';
import { DEFAULT_ASTRALOCK_CONFIG } from '@/core/algorithms';
import type { CodeSymbol } from '@/core/contracts/code-waveform';
import { VirtualCameraSensor } from '@/core/sensors/virtual-camera';
import { ExactWorldSampler } from '@/core/sensors/world-sampler';
import { SimulationEngine } from '@/core/simulation/engine';
import { loadScenario } from '@/scenarios';

import { CandidateTracker, classify, searchPhase, type IdentitySample } from './identity';

const CONFIG = DEFAULT_ASTRALOCK_CONFIG;
const RULE = CONFIG.identity;

/**
 * Watches a scenario through the real sensor and returns each source's history.
 *
 * Sources are separated exactly the way the tracker separates them — by
 * nearest-neighbour association on bearing — and not by consulting truth. Two
 * sources that merge in the image merge here too, which is the point.
 *
 * The mount does not move here. These scenarios fly their sources across a
 * fixed boresight, so the window has to be one during which the source of
 * interest is actually inside the twelve-degree field: the coded beacon crosses
 * the axis at about 24 s, and watching from t = 0 would be watching an empty
 * sky. A closed-loop run finds it by slewing instead, which is what the
 * ablation tests exercise.
 */
function watch(
  scenarioId: Parameters<typeof loadScenario>[0],
  from: number,
  to: number,
): readonly (readonly IdentitySample[])[] {
  const config = loadScenario(scenarioId);
  const engine = new SimulationEngine(config);
  const sensor = new VirtualCameraSensor({ config });
  const sampler = new ExactWorldSampler(engine);
  const tracker = new CandidateTracker({
    associationAngle: RULE.associationAngle,
    // The whole observation, so a test can assert on everything that was seen
    // rather than on whatever survived the tracker's window.
    historyWindow: to - from + 1,
    historyCapacity: 100_000,
    maxCandidates: 16,
  });

  const rate = config.camera.frameRate as number;
  const first = Math.ceil(from * rate);
  const last = Math.floor(to * rate);
  for (let index = first; index <= last; index += 1) {
    // The same question the closed loop asks. A dropped frame is simply absent:
    // nothing is recorded for it and nothing is invented in its place.
    if (sensor.isFrameDropped(index)) continue;
    const captureTime = sensor.clock.captureTime(index) as number;
    const capture = sensor.captureFrame(sampler, index);
    try {
      const frame = capture.frame;
      const detection = detect(frame, CONFIG.detector);
      const samples: IdentitySample[] = detection.candidates.map((blob) => {
        const u = blob.centroidX + 0.5;
        const v = blob.centroidY + 0.5;
        return {
          time: captureTime,
          exposure: frame.exposure,
          u,
          v,
          // The boresight never moves in these runs, so image offset and
          // bearing differ by a fixed scale. Computed from the frame, not from
          // the scenario.
          azimuth: (frame.pose.azimuth as number) + (u - frame.width / 2) / 3044.6,
          elevation: (frame.pose.elevation as number) - (v - frame.height / 2) / 3044.6,
          intensity: blob.integratedIntensity,
        };
      });
      tracker.observe(samples, captureTime);
    } finally {
      capture.release();
    }
  }

  return tracker.candidates.map((candidate) => candidate.history.observations);
}

const span = (samples: readonly IdentitySample[]): number =>
  samples.length < 2 ? 0 : samples[samples.length - 1]!.time - samples[0]!.time;

/** The verdict the tracker's own rule would reach on a history. */
const verdict = (samples: readonly IdentitySample[], sequence: readonly CodeSymbol[]) =>
  classify(
    searchPhase(samples, sequence, RULE.symbolDuration, RULE.phaseSearchSteps),
    span(samples),
    RULE.symbolDuration,
    RULE,
  );

/** The longest history seen, which is the designated beacon in these runs. */
const longest = (histories: readonly (readonly IdentitySample[])[]) =>
  [...histories].sort((a, b) => b.length - a.length)[0]!;

describe('recognising a coded beacon through the camera', () => {
  const histories = watch('code-clean', 18, 27);

  it('sees one source, and it is modulating', () => {
    expect(histories).toHaveLength(1);
    const intensities = histories[0]!.map((sample) => sample.intensity);
    // The beacon is never lost: an off symbol dims it, it does not extinguish
    // it. A history with gaps would mean the off level had fallen below the
    // detector's floor and the scenario, not the correlator, would be wrong.
    expect(Math.min(...intensities)).toBeGreaterThan(0);
    expect(Math.max(...intensities) / Math.min(...intensities)).toBeGreaterThan(2);
  });

  it('recognises the expected pattern on the pixels it produced', () => {
    const reading = verdict(histories[0]!, CONFIG.identity.expectedSequence);
    expect(reading.state).toBe('match');
    // Measured, not aspirational. The detector's integral is nonlinear in the
    // emitted level, which costs correlation that no amount of receiver design
    // recovers: see docs/BEACON_IDENTITY.md.
    expect(reading.correlation!).toBeGreaterThan(0.85);
    expect(reading.correlation!).toBeLessThan(1);
  });

  it('recovers the transmitter’s phase to within a frame period', () => {
    const reading = verdict(histories[0]!, CONFIG.identity.expectedSequence);
    const truePhase = loadScenario('code-clean').targets[0]!.beacon!.identityCode!
      .phaseOffset as number;
    const period = CONFIG.identity.expectedSequence.length * RULE.symbolDuration;

    // Phase is periodic: 0.99 of a period away from 0.01 is 0.02 apart, not
    // 0.98. Compared the short way round.
    const delta = Math.abs(((reading.phase - truePhase) % period) + period) % period;
    const error = Math.min(delta, period - delta);
    expect(error).toBeLessThan(1 / 60 + 1e-9);
  });
});

describe('refusing a source sending something else', () => {
  const histories = watch('code-decoy-wrong', 17.5, 20);

  it('watches both sources without being told there are two', () => {
    expect(histories.length).toBeGreaterThanOrEqual(2);
  });

  it('recognises one and refuses the other', () => {
    const readings = histories
      .filter((history) => history.length >= RULE.minSamples)
      .map((history) => verdict(history, CONFIG.identity.expectedSequence));

    expect(readings.filter((reading) => reading.state === 'match')).toHaveLength(1);
    expect(readings.some((reading) => reading.state === 'mismatch')).toBe(true);
  });

  it('does not reward the decoy for being brighter', () => {
    // The intruder is the brighter source in this scenario. A raw correlation
    // would follow brightness; a normalised one cannot.
    const scored = histories
      .filter((history) => history.length >= RULE.minSamples)
      .map((history) => ({
        mean: history.reduce((sum, s) => sum + s.intensity, 0) / history.length,
        reading: verdict(history, CONFIG.identity.expectedSequence),
      }));

    const brightest = [...scored].sort((a, b) => b.mean - a.mean)[0]!;
    expect(brightest.reading.state).not.toBe('match');
  });
});

describe('an unmodulated source', () => {
  it('is never recognised, however bright it is', () => {
    // The intruder here carries no code at all. Its brightness varies only with
    // range and noise, so there is no pattern to find and none is invented.
    const histories = watch('code-decoy-uncoded', 17.5, 20).filter(
      (history) => history.length >= RULE.minSamples,
    );
    const readings = histories.map((history) => verdict(history, CONFIG.identity.expectedSequence));
    expect(readings.filter((reading) => reading.state === 'match')).toHaveLength(1);
  });
});

describe('a source replaying a rotation of the expected code', () => {
  it('cannot be told apart from the real one, and the score says so', () => {
    // The negative control. A receiver that must recover phase cannot
    // distinguish a code from a time-shifted copy of itself; both correlate
    // near 1.0 and the honest answer is that identity does not decide here.
    const readings = watch('code-ambiguous', 17.5, 20)
      .filter((history) => history.length >= RULE.minSamples)
      .map((history) => verdict(history, CONFIG.identity.expectedSequence));

    expect(readings.filter((reading) => reading.state === 'match').length).toBeGreaterThanOrEqual(
      2,
    );
  });
});

describe('a beacon that stops signalling', () => {
  it('is recognised while it signals and unjudgeable afterwards', () => {
    // Twenty seconds of code, then a steady source. The evidence does not turn
    // into evidence against: a flat series is insufficient, not a mismatch.
    const histories = watch('code-insufficient', 17.9, 28);
    const all = longest(histories);
    // Signalling stops at t = 20 s: twenty passes of the code, then a steady
    // source. Split either side of it, leaving a margin for the last symbol.
    const during = all.filter((sample) => sample.time < 19.9);
    const after = all.filter((sample) => sample.time > 20.5);

    expect(verdict(during, CONFIG.identity.expectedSequence).state).toBe('match');
    expect(verdict(after, CONFIG.identity.expectedSequence).state).toBe('insufficient-evidence');
  });
});

describe('gaps in the observation series', () => {
  it('correlates across dropped frames without inventing samples', () => {
    // Bursty frame loss: the history has holes in it. Each sample still carries
    // its own timestamp, so the code is integrated over the exposure that
    // actually happened and a gap costs evidence rather than corrupting it.
    const histories = watch('code-frame-loss', 18, 28);
    const beacon = longest(histories);
    const framePeriod = 1 / 60;

    // Frames were genuinely lost, and the losses came in bursts rather than
    // singly — that is what the scenario configures, and a test that passed
    // without them would be testing nothing.
    const gaps = beacon
      .slice(1)
      .map((sample, index) => sample.time - beacon[index]!.time)
      .filter((gap) => gap > framePeriod * 1.5);
    expect(gaps.length).toBeGreaterThan(0);
    expect(Math.max(...gaps)).toBeGreaterThan(framePeriod * 3);

    // Every retained sample is a frame that really arrived: the series is
    // shorter than the window, and nothing was interpolated to fill it.
    expect(beacon.length).toBeLessThan(10 * 60);
    expect(verdict(beacon, CONFIG.identity.expectedSequence).state).toBe('match');
  });
});
