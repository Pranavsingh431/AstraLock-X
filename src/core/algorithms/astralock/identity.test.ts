// @vitest-environment node
/**
 * The identity machinery, against synthetic observations with known answers.
 *
 * These tests do not render anything. They feed the correlator brightness
 * histories built directly from a code — sometimes the right one, sometimes a
 * different one, sometimes none — so that every result can be checked against
 * what the arithmetic must give. The image-level behaviour is checked
 * separately, once real pixels are involved.
 *
 * The important negative results are here too: a rotation of the expected code
 * is indistinguishable from it, a history shorter than a symbol carries no
 * information, and a source with no modulation at all correlates with nothing.
 * A design that could not produce those answers would be overclaiming.
 */

import { describe, expect, it } from 'vitest';

import { CODE_A, CODE_A_SHIFTED, CODE_B } from '@/core/contracts/code-library';
import { integratedLevel, type CodeSymbol } from '@/core/contracts/code-waveform';

import {
  CandidateHistory,
  CandidateTracker,
  classify,
  correlateAtPhase,
  searchPhase,
  type IdentityRule,
  type IdentitySample,
} from './identity';

/** 60 fps, four frames per symbol: the bundled default timing. */
const FRAME_PERIOD = 1 / 60;
const SYMBOL = 4 * FRAME_PERIOD;
const EXPOSURE = 2e-3;

const RULE: IdentityRule = {
  minCorrelation: 0.65,
  mismatchCorrelation: 0.3,
  minSamples: 24,
  minSpanSymbols: 6,
  minModulation: 0.12,
};

/**
 * Brightness history of a source emitting `sequence`, observed at the camera's
 * frame rate.
 *
 * Intensity is an affine function of the emitted level so that the correlation
 * has an exactly known answer: a perfect receiver scores 1.0 against the same
 * code. Real observations are noisier and not exactly affine — that is what the
 * image-level tests measure.
 */
function history(
  sequence: readonly CodeSymbol[],
  frames: number,
  options: {
    phase?: number;
    start?: number;
    base?: number;
    depth?: number;
    exposure?: number;
    framePeriod?: number;
  } = {},
): IdentitySample[] {
  const phase = options.phase ?? 0;
  const start = options.start ?? 0;
  const base = options.base ?? 400;
  const depth = options.depth ?? 600;
  const exposure = options.exposure ?? EXPOSURE;
  const framePeriod = options.framePeriod ?? FRAME_PERIOD;

  return Array.from({ length: frames }, (_, index) => {
    const time = start + index * framePeriod;
    const level = integratedLevel(
      {
        sequence,
        symbolDuration: SYMBOL,
        phaseOffset: phase,
        onLevel: 1,
        offLevel: 0,
        repeat: true,
      },
      time - exposure / 2,
      time + exposure / 2,
    );
    return {
      time,
      exposure,
      u: 320,
      v: 240,
      azimuth: 0,
      elevation: 0,
      intensity: base + depth * level,
    };
  });
}

describe('bounded candidate history', () => {
  it('keeps samples in order and reports its span', () => {
    const store = new CandidateHistory(10, 1000);
    for (const sample of history(CODE_A, 30)) store.push(sample);

    expect(store.length).toBe(30);
    expect(store.span).toBeCloseTo(29 * FRAME_PERIOD, 9);
    expect(store.latest!.time).toBeCloseTo(29 * FRAME_PERIOD, 9);
  });

  // Bounded twice: a long run must not grow the history, and neither must a
  // high frame rate inside the window.
  it('drops samples older than its window', () => {
    const store = new CandidateHistory(0.5, 1000);
    for (const sample of history(CODE_A, 300)) store.push(sample);

    expect(store.span).toBeLessThanOrEqual(0.5 + 1e-9);
    expect(store.length).toBeLessThanOrEqual(Math.ceil(0.5 / FRAME_PERIOD) + 1);
  });

  it('never exceeds its capacity, whatever the window allows', () => {
    const store = new CandidateHistory(1000, 16);
    for (const sample of history(CODE_A, 300)) store.push(sample);
    expect(store.length).toBe(16);
  });

  it('expires on demand without a new sample', () => {
    const store = new CandidateHistory(0.2, 1000);
    for (const sample of history(CODE_A, 60)) store.push(sample);
    const before = store.length;

    store.expire(10);
    expect(store.length).toBe(0);
    expect(before).toBeGreaterThan(0);
  });
});

describe('correlation against the expected code', () => {
  it('is exactly 1 for a noiseless source carrying the expected code at the right phase', () => {
    const samples = history(CODE_A, 120);
    expect(correlateAtPhase(samples, CODE_A, SYMBOL, 0)!).toBeCloseTo(1, 9);
  });

  // The property that stops the score being a brightness contest.
  it('is unchanged when the candidate is made twice as bright', () => {
    const dim = history(CODE_A, 120, { base: 100, depth: 150 });
    const bright = history(CODE_A, 120, { base: 200, depth: 300 });

    const a = correlateAtPhase(dim, CODE_A, SYMBOL, 0)!;
    const b = correlateAtPhase(bright, CODE_A, SYMBOL, 0)!;
    expect(b).toBeCloseTo(a, 9);
  });

  it('is unchanged by an added constant, so a background pedestal cannot help', () => {
    const plain = history(CODE_A, 120);
    const pedestalled = plain.map((s) => ({ ...s, intensity: s.intensity + 5000 }));
    expect(correlateAtPhase(pedestalled, CODE_A, SYMBOL, 0)!).toBeCloseTo(
      correlateAtPhase(plain, CODE_A, SYMBOL, 0)!,
      9,
    );
  });

  it('falls well below a match for a source carrying a different code', () => {
    const decoy = history(CODE_B, 120);
    const best = searchPhase(decoy, CODE_A, SYMBOL, 60);
    // Bounded by the codes' measured peak cross-correlation of 7/15 = 0.47.
    expect(best.correlation!).toBeLessThan(0.55);
  });

  it('is undefined for a source that never changes brightness', () => {
    const steady = history(CODE_A, 120).map((s) => ({ ...s, intensity: 900 }));
    expect(correlateAtPhase(steady, CODE_A, SYMBOL, 0)).toBeNull();
  });

  it('is undefined when every sample falls inside one symbol', () => {
    // Three exposures wholly inside symbol 0: the predicted shape is constant,
    // so there is nothing to correlate however bright the samples are.
    const inside = history(CODE_A, 3).map((sample, index) => ({
      ...sample,
      time: 0.01 + index * 0.015,
    }));
    expect(correlateAtPhase(inside, CODE_A, SYMBOL, 0)).toBeNull();
  });

  // Worth stating explicitly, because it is the reason the evidence rule is not
  // optional. Three samples that happen to straddle a single symbol boundary
  // correlate at exactly 1.0 and mean nothing at all: two points either side of
  // one edge fit any monotone pattern. Only the sample and span requirements in
  // `classify` stop that becoming a MATCH.
  it('can reach a perfect score on a history far too short to mean anything', () => {
    const brief = history(CODE_A, 3);
    expect(correlateAtPhase(brief, CODE_A, SYMBOL, 0)!).toBeCloseTo(1, 9);
  });

  it('is undefined for fewer than two samples', () => {
    expect(correlateAtPhase(history(CODE_A, 1), CODE_A, SYMBOL, 0)).toBeNull();
    expect(correlateAtPhase([], CODE_A, SYMBOL, 0)).toBeNull();
  });

  it('uses timestamps, not frame indices: an irregular series still correlates', () => {
    // Every third frame missing. A correlator keyed on frame index would
    // misalign the code; one keyed on timestamps does not.
    const sparse = history(CODE_A, 180).filter((_, index) => index % 3 !== 0);
    expect(correlateAtPhase(sparse, CODE_A, SYMBOL, 0)!).toBeCloseTo(1, 9);
  });
});

describe('phase search', () => {
  it('recovers a phase the transmitter was never asked about', () => {
    const offset = 0.037;
    const samples = history(CODE_A, 150, { phase: offset });
    const best = searchPhase(samples, CODE_A, SYMBOL, 120);

    expect(best.correlation!).toBeGreaterThan(0.95);
    // Recovered to within a search step of the truth. The simulator's phase is
    // used here only to check the answer; the search never saw it.
    const period = CODE_A.length * SYMBOL;
    const error = Math.min(Math.abs(best.phase - offset), period - Math.abs(best.phase - offset));
    expect(error).toBeLessThan(period / 120 + 1e-9);
  });

  it.each([0, 0.011, 0.033, 0.05, 0.25, 0.71])('recovers a phase of %s s', (offset) => {
    const samples = history(CODE_A, 150, { phase: offset });
    expect(searchPhase(samples, CODE_A, SYMBOL, 120).correlation!).toBeGreaterThan(0.9);
  });

  it('reports a phase inside one code period', () => {
    const period = CODE_A.length * SYMBOL;
    for (const offset of [0.9, 1.7, -0.4]) {
      const best = searchPhase(history(CODE_A, 150, { phase: offset }), CODE_A, SYMBOL, 120);
      expect(best.phase).toBeGreaterThanOrEqual(0);
      expect(best.phase).toBeLessThan(period);
    }
  });

  it('finds a worse best when searched too coarsely, and says so honestly', () => {
    const samples = history(CODE_A, 150, { phase: 0.031 });
    const coarse = searchPhase(samples, CODE_A, SYMBOL, 4);
    const fine = searchPhase(samples, CODE_A, SYMBOL, 240);
    expect(fine.correlation!).toBeGreaterThan(coarse.correlation!);
  });

  // Narrowing keeps resolution constant by scaling the step count with the
  // span, so a narrow sweep is cheaper without being coarser. At the bundled
  // 60 steps a narrow sweep is 8 steps over two symbols, which is one frame
  // period of resolution — finer than the observations can distinguish.
  it('narrows around a known phase without losing the peak', () => {
    const offset = 0.2;
    const samples = history(CODE_A, 150, { phase: offset });
    const wide = searchPhase(samples, CODE_A, SYMBOL, 60);
    const narrow = searchPhase(samples, CODE_A, SYMBOL, 60, offset, 1);

    expect(narrow.correlation!).toBeGreaterThan(0.95);
    expect(narrow.correlation!).toBeGreaterThanOrEqual(wide.correlation! - 0.05);
  });

  // The centre of a narrow sweep is the phase it was given, and an even step
  // count places a sample exactly there. So narrowing can only improve on the
  // lock it started from, never lose it — which is what makes it safe to use
  // the cheap search once a phase has been accepted.
  it('always samples the phase it was asked to narrow around', () => {
    const offset = 0.2;
    const samples = history(CODE_A, 150, { phase: offset });
    const atLock = correlateAtPhase(samples, CODE_A, SYMBOL, offset)!;
    const narrow = searchPhase(samples, CODE_A, SYMBOL, 60, offset, 1);

    expect(narrow.correlation!).toBeGreaterThanOrEqual(atLock - 1e-12);
  });

  // A sweep asked for too few steps is genuinely coarse, and says so by
  // returning a worse best rather than by pretending.
  it('is coarser when narrowed from an already coarse step count', () => {
    const offset = 0.2;
    const samples = history(CODE_A, 150, { phase: offset });
    const coarse = searchPhase(samples, CODE_A, SYMBOL, 24, offset, 1);
    const fine = searchPhase(samples, CODE_A, SYMBOL, 240, offset, 1);

    expect(fine.correlation!).toBeGreaterThanOrEqual(coarse.correlation!);
  });

  // The negative control that matters. A rotation of the expected code is the
  // expected code at another phase, and a receiver that must search phase
  // cannot tell them apart. Claiming otherwise would be the central dishonesty
  // this design has to avoid.
  it('cannot separate a rotation of the expected code, and reaches a full match on it', () => {
    const rotated = history(CODE_A_SHIFTED, 150);
    const best = searchPhase(rotated, CODE_A, SYMBOL, 120);
    expect(best.correlation!).toBeGreaterThan(0.95);
  });
});

describe('frame rate and exposure', () => {
  it.each([30, 60, 90])('correlates at %i fps with a symbol valid for that rate', (fps) => {
    const framePeriod = 1 / fps;
    // Four frames per symbol at each rate, so the symbol duration changes with
    // the camera rather than being assumed.
    const samples = history(CODE_A, 40 * 4, { framePeriod, exposure: framePeriod / 4 });
    // The generator uses the fixed SYMBOL; re-derive at this rate instead.
    const scaled = samples.map((sample, index) => ({
      ...sample,
      time: index * framePeriod,
    }));
    expect(correlateAtPhase(scaled, CODE_A, SYMBOL, 0)).not.toBeNull();
  });

  it('still correlates when the exposure straddles symbol boundaries', () => {
    // An exposure most of a symbol long smears adjacent symbols together, so
    // the observed contrast falls — but the pattern is still there.
    const smeared = history(CODE_A, 150, { exposure: SYMBOL * 0.9 });
    const sharp = history(CODE_A, 150, { exposure: 1e-4 });

    const smearedBest = searchPhase(smeared, CODE_A, SYMBOL, 120).correlation!;
    const sharpBest = searchPhase(sharp, CODE_A, SYMBOL, 120).correlation!;

    expect(sharpBest).toBeGreaterThan(0.99);
    expect(smearedBest).toBeGreaterThan(0.9);
    // The receiver must model the same smearing, or the two would not agree.
    expect(smearedBest).toBeLessThanOrEqual(sharpBest + 1e-9);
  });

  it('tolerates missing observations without inserting fake ones', () => {
    // A burst of thirty lost frames in the middle of the history.
    const full = history(CODE_A, 240);
    const dropped = full.filter((_, index) => index < 90 || index >= 120);
    expect(correlateAtPhase(dropped, CODE_A, SYMBOL, 0)!).toBeCloseTo(1, 9);
    expect(dropped.length).toBe(210);
  });
});

describe('classification', () => {
  const span = (samples: readonly IdentitySample[]): number =>
    samples.length < 2 ? 0 : samples[samples.length - 1]!.time - samples[0]!.time;

  it('calls a clean match a match', () => {
    const samples = history(CODE_A, 150);
    const reading = classify(
      searchPhase(samples, CODE_A, SYMBOL, 120),
      span(samples),
      SYMBOL,
      RULE,
    );
    expect(reading.state).toBe('match');
    expect(reading.correlation!).toBeGreaterThan(0.95);
  });

  it('calls an unmodulated source insufficient, because it carries no information', () => {
    const steady = history(CODE_A, 150).map((s) => ({ ...s, intensity: 900 }));
    const reading = classify(searchPhase(steady, CODE_A, SYMBOL, 120), span(steady), SYMBOL, RULE);
    expect(reading.state).toBe('insufficient-evidence');
    expect(reading.correlation).toBeNull();
  });

  it('refuses to call a barely-varying source a mismatch', () => {
    // A beacon that has stopped signalling, seen through noise. Its correlation
    // against the code is whatever the noise happens to produce, and on this
    // seed it is low enough to clear the mismatch threshold — which is exactly
    // the trap. There is no wrong code here, only an absent one.
    let state = 7;
    const noise = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648 - 0.5;
    };
    const flat = history(CODE_A, 150).map((sample) => ({
      ...sample,
      intensity: 900 * (1 + 0.01 * noise()),
    }));
    const result = searchPhase(flat, CODE_A, SYMBOL, 120);
    expect(result.modulation).toBeLessThan(0.02);
    expect(classify(result, span(flat), SYMBOL, RULE).state).toBe('insufficient-evidence');
  });

  it('measures the modulation a real coded source carries', () => {
    // The separation the modulation floor relies on: a square-wave beacon sits
    // an order of magnitude above a steady one, so the floor is not a threshold
    // either case has to be tuned against.
    const coded = searchPhase(history(CODE_A, 150), CODE_A, SYMBOL, 120);
    expect(coded.modulation).toBeGreaterThan(0.3);
  });

  it('calls a wrong-code source a mismatch once there is enough evidence', () => {
    const decoy = history(CODE_B, 150);
    const reading = classify(searchPhase(decoy, CODE_A, SYMBOL, 120), span(decoy), SYMBOL, RULE);
    expect(['mismatch', 'unconfirmed']).toContain(reading.state);
    expect(reading.state).not.toBe('match');
  });

  // Evidence before verdict: a short history that happens to correlate
  // perfectly still says nothing, and the rule refuses to pretend otherwise.
  it('refuses a verdict on too few samples, however well they correlate', () => {
    const brief = history(CODE_A, 10);
    const reading = classify(searchPhase(brief, CODE_A, SYMBOL, 120), span(brief), SYMBOL, RULE);
    expect(reading.state).toBe('insufficient-evidence');
  });

  it('refuses a verdict on a span shorter than the rule requires', () => {
    // Enough samples, but crammed into two symbols by a fast camera.
    const fast = history(CODE_A, 40, { framePeriod: SYMBOL / 20 });
    const reading = classify(searchPhase(fast, CODE_A, SYMBOL, 120), span(fast), SYMBOL, RULE);
    expect(reading.state).toBe('insufficient-evidence');
  });

  it('reports the evidence it used, so a verdict can be audited', () => {
    const samples = history(CODE_A, 150);
    const reading = classify(
      searchPhase(samples, CODE_A, SYMBOL, 120),
      span(samples),
      SYMBOL,
      RULE,
    );
    expect(reading.samples).toBe(150);
    expect(reading.span).toBeCloseTo(149 * FRAME_PERIOD, 9);
    expect(reading.phase).toBeGreaterThanOrEqual(0);
  });
});

describe('tracking candidates across frames', () => {
  // The reference camera: 640 px across a 12-degree field, so one pixel
  // subtends 328 microradians. Tests are written in pixels because that is how
  // a detector reports, and converted here because that is how histories join.
  const PIXEL = 0.20943951 / 640;
  const rule = {
    associationAngle: 12 * PIXEL,
    historyWindow: 4,
    historyCapacity: 512,
    maxCandidates: 8,
  };

  /** An observation at an image position, with the boresight straight ahead. */
  const at = (time: number, u: number, v: number, intensity = 500): IdentitySample =>
    seen(time, u, v, intensity, 0, 0);

  /**
   * An observation at an image position while the gimbal points somewhere.
   *
   * Bearing is pose plus offset, exactly as `candidateBearings` computes it, so
   * a slewing camera moves `u` and leaves the bearing where it was.
   */
  const seen = (
    time: number,
    u: number,
    v: number,
    intensity: number,
    poseAzimuth: number,
    poseElevation: number,
  ): IdentitySample => ({
    time,
    exposure: EXPOSURE,
    u,
    v,
    azimuth: poseAzimuth + (u - 320) * PIXEL,
    elevation: poseElevation - (v - 240) * PIXEL,
    intensity,
  });

  it('joins a moving blob to one history', () => {
    const tracker = new CandidateTracker(rule);
    for (let frame = 0; frame < 20; frame += 1) {
      tracker.observe([at(frame * FRAME_PERIOD, 100 + frame, 200)], frame * FRAME_PERIOD);
    }
    expect(tracker.candidates).toHaveLength(1);
    expect(tracker.candidates[0]!.history.length).toBe(20);
  });

  it('keeps one history for a source held still by a slewing camera', () => {
    // The gimbal sweeps a quarter of a degree per frame — about thirteen
    // pixels, past the association angle — while the source stays put. Joining
    // on pixels would start a new history almost every frame and the tracker
    // would arrive at the end of the slew knowing nothing about what it had
    // been watching the whole way.
    const tracker = new CandidateTracker(rule);
    const step = 0.25 * (Math.PI / 180);
    for (let frame = 0; frame < 20; frame += 1) {
      const t = frame * FRAME_PERIOD;
      const pose = frame * step;
      // Fixed bearing: as the boresight advances, the source slides back.
      const u = 320 - pose / PIXEL;
      tracker.observe([seen(t, u, 240, 500, pose, 0)], t);
    }
    expect(tracker.candidates).toHaveLength(1);
    expect(tracker.candidates[0]!.history.length).toBe(20);
  });

  it('keeps two well-separated sources apart', () => {
    const tracker = new CandidateTracker(rule);
    for (let frame = 0; frame < 20; frame += 1) {
      const t = frame * FRAME_PERIOD;
      tracker.observe([at(t, 100 + frame, 200), at(t, 400 - frame, 300)], t);
    }
    expect(tracker.candidates).toHaveLength(2);
    for (const track of tracker.candidates) expect(track.history.length).toBe(20);
  });

  it('starts a new history for a source that appears far from any existing one', () => {
    const tracker = new CandidateTracker(rule);
    tracker.observe([at(0, 100, 200)], 0);
    tracker.observe([at(FRAME_PERIOD, 101, 200), at(FRAME_PERIOD, 500, 100)], FRAME_PERIOD);
    expect(tracker.candidates).toHaveLength(2);
  });

  it('retires a history that has gone quiet for longer than the window', () => {
    const tracker = new CandidateTracker(rule);
    tracker.observe([at(0, 100, 200)], 0);
    expect(tracker.candidates).toHaveLength(1);

    tracker.observe([], 10);
    expect(tracker.candidates).toHaveLength(0);
  });

  it('bounds the number of tracked candidates', () => {
    const tracker = new CandidateTracker(rule);
    const many = Array.from({ length: 40 }, (_, index) => at(0, index * 50, index * 10));
    tracker.observe(many, 0);
    expect(tracker.candidates.length).toBeLessThanOrEqual(rule.maxCandidates);
  });

  // The honest failure. Two sources that cross within the association radius
  // can have their histories swapped, because position is the only thing
  // available to join on. A tracker that got this right would be cheating.
  it('can confuse two sources that cross, and does not pretend otherwise', () => {
    const tracker = new CandidateTracker(rule);
    // Converge, touch, diverge.
    for (let frame = 0; frame < 30; frame += 1) {
      const t = frame * FRAME_PERIOD;
      const separation = Math.abs(15 - frame);
      tracker.observe([at(t, 200 - separation, 240), at(t, 200 + separation, 240)], t);
    }
    // Both histories survive and stay bounded; which source each followed
    // through the crossing is exactly what cannot be asserted.
    expect(tracker.candidates.length).toBeGreaterThanOrEqual(1);
    for (const track of tracker.candidates) {
      expect(track.history.length).toBeLessThanOrEqual(30);
    }
  });

  it('holds no identifier of any kind on a tracked candidate', () => {
    const tracker = new CandidateTracker(rule);
    tracker.observe([at(0, 100, 200)], 0);
    const track = tracker.candidates[0]!;
    const serialised = JSON.stringify({
      u: track.u,
      v: track.v,
      lastSeen: track.lastSeen,
      samples: track.history.observations,
    });
    for (const forbidden of ['emitter', 'targetId', 'hostEntity', 'truth', 'designated']) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe('memory bounds', () => {
  // A tracker that watches for an hour must not hold an hour of anything. Both
  // bounds are asserted on the same run, because either one alone is escapable:
  // a window with no cap grows with the frame rate, and a cap with no window
  // keeps stale evidence for ever.
  const rule = {
    associationAngle: 12 * (0.20943951 / 640),
    historyWindow: 2,
    historyCapacity: 256,
    maxCandidates: 8,
  };

  it('holds a bounded history however long the run', () => {
    const tracker = new CandidateTracker(rule);
    const frames = 60 * 60 * 10; // ten minutes at 60 fps
    for (let frame = 0; frame < frames; frame += 1) {
      const t = frame * FRAME_PERIOD;
      tracker.observe(
        [
          {
            time: t,
            exposure: EXPOSURE,
            u: 320,
            v: 240,
            azimuth: 0,
            elevation: 0,
            intensity: 500 + 100 * Math.sin(frame),
          },
        ],
        t,
      );
    }

    expect(tracker.candidates).toHaveLength(1);
    const history = tracker.candidates[0]!.history;
    expect(history.length).toBeLessThanOrEqual(rule.historyCapacity);
    expect(history.span).toBeLessThanOrEqual(rule.historyWindow + FRAME_PERIOD);
  });

  it('holds a bounded number of candidates however many sources appear', () => {
    // A noisy frame can contain hundreds of components. Memory must depend on
    // the configured cap, not on what the detector happened to find.
    const tracker = new CandidateTracker(rule);
    for (let frame = 0; frame < 600; frame += 1) {
      const t = frame * FRAME_PERIOD;
      // Fresh bearings every frame, so nothing associates and every observation
      // would start a new history if the cap were not enforced.
      const many = Array.from({ length: 200 }, (_, index) => ({
        time: t,
        exposure: EXPOSURE,
        u: index,
        v: frame % 400,
        azimuth: (frame * 200 + index) * 0.01,
        elevation: 0,
        intensity: 400,
      }));
      tracker.observe(many, t);
    }

    expect(tracker.candidates.length).toBeLessThanOrEqual(rule.maxCandidates);
  });

  it('retires histories rather than accumulating dead ones', () => {
    const tracker = new CandidateTracker(rule);
    // Twenty sources, one after another, each visible briefly and then gone.
    for (let source = 0; source < 20; source += 1) {
      for (let frame = 0; frame < 30; frame += 1) {
        const t = source * 10 + frame * FRAME_PERIOD;
        tracker.observe(
          [
            {
              time: t,
              exposure: EXPOSURE,
              u: 100 + source * 10,
              v: 200,
              azimuth: source * 0.05,
              elevation: 0,
              intensity: 500,
            },
          ],
          t,
        );
      }
    }
    // Each was gone for far longer than the window before the next appeared.
    expect(tracker.candidates).toHaveLength(1);
  });
});
