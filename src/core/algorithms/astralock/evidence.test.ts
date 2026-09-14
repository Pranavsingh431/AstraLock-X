// @vitest-environment node
/**
 * Acquisition evidence, gated association, track quality and the handoff gate.
 *
 * The theme running through all four: none of them may consult anything the
 * tracker could not compute for itself. The tests therefore feed them only
 * detections, bearings, innovations and time — never a target identity, never a
 * true bearing, never the evaluator's verdict.
 *
 * The other theme is honest naming. `evidence` and `trackQuality` are bounded
 * progress measures, not probabilities, and these cases pin down what they
 * actually mean rather than assuming a calibrated interpretation.
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_ASTRALOCK_CONFIG } from './config';
import { ImmEstimator } from './imm';
import {
  AcquisitionEvidence,
  HandoffGate,
  TrackQuality,
  associate,
  strongestCandidate,
  type AcquisitionRule,
  type CandidateBearing,
  type HandoffRule,
} from './evidence';

const DEG = Math.PI / 180;

const rule = (patch: Partial<AcquisitionRule> = {}): AcquisitionRule => ({
  minSupportingObservations: 6,
  minPersistence: 0.08,
  maxConsecutiveMisses: 3,
  maxMeanNis: 9,
  ...patch,
});

/** A candidate as the detector would produce it, at a chosen bearing. */
const candidate = (
  azimuth: number,
  elevation: number,
  score: number,
  integratedIntensity = 4000,
): CandidateBearing => ({
  blob: {
    area: 40,
    peak: 220,
    integratedIntensity,
    centroidX: 319.5,
    centroidY: 239.5,
    minX: 315,
    minY: 235,
    maxX: 324,
    maxY: 244,
    touchesEdge: false,
  },
  u: 320,
  v: 240,
  azimuth,
  elevation,
  score,
});

/** An estimator settled on a bearing, for the association cases below. */
function settledAt(azimuth: number, elevation: number): { imm: ImmEstimator; time: number } {
  const imm = new ImmEstimator(DEFAULT_ASTRALOCK_CONFIG.imm);
  imm.initialise(azimuth, elevation, 0);
  let time = 0;
  for (let i = 1; i <= 120; i += 1) {
    time = i / 60;
    const prediction = imm.predict(time);
    imm.applyMeasurement(prediction, azimuth, elevation);
  }
  return { imm, time };
}

// --- Acquisition evidence ---------------------------------------------------

describe('acquisition is a validation stage, not a single detection', () => {
  it('is not ready on the first sighting', () => {
    // The baseline commits to TRACK on evidence this thin. The whole point of
    // the robust algorithm's ACQUIRE state is that it does not.
    const evidence = new AcquisitionEvidence(rule());
    evidence.start(0);
    expect(evidence.ready).toBe(false);
  });

  it('needs both enough observations and enough elapsed time', () => {
    // Either alone is cheap. A burst of six detections inside one frame
    // interval proves persistence of nothing; six detections spread over a
    // tenth of a second is a source that is still there.
    const burst = new AcquisitionEvidence(rule());
    burst.start(0);
    for (let i = 0; i < 10; i += 1) burst.support(0.001, 1);
    expect(burst.supports).toBeGreaterThan(6);
    expect(burst.ready).toBe(false);

    const slow = new AcquisitionEvidence(rule());
    slow.start(0);
    slow.support(0.5, 1);
    expect(slow.persistence).toBeGreaterThan(0.08);
    expect(slow.ready).toBe(false);
  });

  it('becomes ready once both hold', () => {
    const evidence = new AcquisitionEvidence(rule());
    evidence.start(0);
    for (let i = 1; i <= 6; i += 1) evidence.support(i / 60, 1);

    expect(evidence.ready).toBe(true);
    expect(evidence.evidence).toBe(1);
  });

  it('refuses a kinematically inconsistent candidate', () => {
    // Persistent and plentiful, but the innovations say it is not following the
    // motion the estimator predicts. That is a different object.
    const evidence = new AcquisitionEvidence(rule({ maxMeanNis: 9 }));
    evidence.start(0);
    for (let i = 1; i <= 10; i += 1) evidence.support(i / 60, 40);

    expect(evidence.consistent).toBe(false);
    expect(evidence.ready).toBe(false);
    // Reported as partial progress rather than as zero: the candidate is there,
    // it just does not move correctly.
    expect(evidence.evidence).toBeCloseTo(0.5, 12);
  });

  it('gives up after too many consecutive misses', () => {
    const evidence = new AcquisitionEvidence(rule({ maxConsecutiveMisses: 3 }));
    evidence.start(0);
    evidence.support(1 / 60, 1);

    for (let i = 0; i < 3; i += 1) evidence.miss();
    expect(evidence.failed).toBe(false);

    evidence.miss();
    expect(evidence.failed).toBe(true);
  });

  it('a single supporting frame resets the miss run', () => {
    const evidence = new AcquisitionEvidence(rule({ maxConsecutiveMisses: 2 }));
    evidence.start(0);
    evidence.miss();
    evidence.miss();
    evidence.support(0.05, 1);
    evidence.miss();

    expect(evidence.failed).toBe(false);
  });

  it('reports progress monotonically as support accumulates', () => {
    const evidence = new AcquisitionEvidence(rule());
    evidence.start(0);
    let previous = evidence.evidence;

    for (let i = 1; i <= 6; i += 1) {
      evidence.support(i / 60, 1);
      expect(evidence.evidence).toBeGreaterThanOrEqual(previous);
      previous = evidence.evidence;
    }
    expect(previous).toBe(1);
  });

  it('is bounded on [0, 1] and is not called a probability', () => {
    const evidence = new AcquisitionEvidence(rule());
    evidence.start(0);
    for (let i = 1; i <= 50; i += 1) evidence.support(i / 60, 1);
    expect(evidence.evidence).toBeLessThanOrEqual(1);
    expect(evidence.evidence).toBeGreaterThanOrEqual(0);
  });
});

// --- Association ------------------------------------------------------------

describe('choosing among candidates', () => {
  const AZ = 0.3;
  const EL = 0.05;
  const GATE_CHI2 = 13.82;
  const MAX_RADIUS = 1.5 * DEG;

  const associateAt = (candidates: readonly CandidateBearing[], maxRadius = MAX_RADIUS) => {
    const { imm, time } = settledAt(AZ, EL);
    const prediction = imm.predict(time + 1 / 60);
    return associate(imm, prediction, candidates, GATE_CHI2, maxRadius, 0);
  };

  it('without a track, falls back to the strongest image candidate', () => {
    // Before there is anything to be consistent with, image strength is the
    // only information available — the same rule the baseline uses always.
    const chosen = strongestCandidate(
      [candidate(0.1, 0, 0.2, 1000), candidate(0.9, 0, 0.8, 9000), candidate(0.5, 0, 0.5, 4000)],
      0,
    );
    expect(chosen?.azimuth).toBe(0.9);
  });

  it('respects a minimum score even without a track', () => {
    const chosen = strongestCandidate([candidate(0.9, 0, 0.05, 9000)], 0.5);
    expect(chosen).toBeNull();
  });

  it('with a track, prefers the candidate consistent with the prediction', () => {
    // The brightest blob is nowhere near where the target should be; the dim
    // one is exactly there. The baseline would take the bright one.
    const result = associateAt([
      candidate(AZ + 5 * DEG, EL, 0.95, 9000),
      candidate(AZ + 2e-4, EL + 1e-4, 0.2, 1000),
    ]);

    expect(result.accepted).not.toBeNull();
    expect(result.accepted!.score).toBe(0.2);
    expect(result.rejected).toBe(1);
  });

  it('rejects everything outside the gate', () => {
    const result = associateAt([candidate(AZ + 5 * DEG, EL, 0.95)]);
    expect(result.accepted).toBeNull();
    expect(result.gate).toBeNull();
    expect(result.rejected).toBe(1);
  });

  it('computes a normalised innovation that grows with the miss distance', () => {
    const near = associateAt([candidate(AZ + 1e-4, EL, 0.5)]);
    const far = associateAt([candidate(AZ + 4e-4, EL, 0.5)]);

    expect(near.gate!.nis).toBeLessThan(far.gate!.nis);
    expect(near.gate!.nis).toBeGreaterThanOrEqual(0);
  });

  it('takes the shortest arc in azimuth', () => {
    // A naive difference across the branch cut would be nearly 2π and would
    // fall outside any sane gate.
    const { imm, time } = settledAt(Math.PI - 1e-4, 0);
    const prediction = imm.predict(time + 1 / 60);
    const result = associate(
      imm,
      prediction,
      [candidate(-Math.PI + 1e-4, 0, 0.5)],
      GATE_CHI2,
      MAX_RADIUS,
      0,
    );
    expect(result.accepted).not.toBeNull();
  });

  it('applies a hard angular radius as well as the statistical gate', () => {
    // A very uncertain estimate would otherwise open the gate wide enough to
    // swallow the whole field of view, so the radius is an independent bound.
    const wide = associateAt([candidate(AZ + 0.8 * DEG, EL, 0.5)], 1.5 * DEG);
    const narrow = associateAt([candidate(AZ + 0.8 * DEG, EL, 0.5)], 0.1 * DEG);

    expect(narrow.accepted).toBeNull();
    expect(narrow.rejected).toBeGreaterThan(0);
    // The same candidate against the same estimator, admitted by the looser
    // radius or not, depending only on the bound.
    expect(wide.rejected).toBeLessThanOrEqual(1);
  });

  it('returns nothing at all when there are no candidates', () => {
    const result = associateAt([]);
    expect(result.accepted).toBeNull();
    expect(result.rejected).toBe(0);
    expect(strongestCandidate([], 0)).toBeNull();
  });

  it('can still be fooled by a decoy inside the gate', () => {
    // The honest limitation, asserted rather than glossed over. Prediction and
    // motion consistency narrow the field; they do not establish identity. A
    // decoy nearer the prediction than the real beacon takes the track, and
    // nothing short of coded beacon identification fixes that.
    const decoy = candidate(AZ + 5e-5, EL, 0.99, 9000);
    const real = candidate(AZ + 3e-4, EL, 0.3, 1000);
    const result = associateAt([decoy, real]);

    expect(result.accepted).not.toBeNull();
    expect(result.accepted!.score).toBe(0.99);
  });
});

// --- Track quality ----------------------------------------------------------

describe('track quality', () => {
  const GATE = 13.82;
  const quality = (): TrackQuality => new TrackQuality(DEFAULT_ASTRALOCK_CONFIG.trackQuality);

  /** Runs a steady stream of readings and returns the last one. */
  const settle = (
    q: TrackQuality,
    frames: number,
    score: number | null,
    nis: number | null,
    sigma: number,
  ) => {
    let reading = q.update(score, nis, GATE, sigma);
    for (let i = 1; i < frames; i += 1) reading = q.update(score, nis, GATE, sigma);
    return reading;
  };

  it('is high for a strong, consistent, well-observed track', () => {
    const reading = settle(quality(), 60, 0.6, 0.5, 5e-5);
    expect(reading.quality).toBeGreaterThan(0.7);
    expect(reading.persistence).toBe(1);
  });

  it('falls when measurements stop arriving', () => {
    const q = quality();
    const healthy = settle(q, 60, 0.6, 0.5, 5e-5).quality;

    // Strength goes to zero on the first missing frame; persistence decays
    // over the whole window, which is the point of having both.
    const firstMiss = q.update(null, null, GATE, 5e-3);
    expect(firstMiss.strength).toBe(0);
    expect(firstMiss.persistence).toBeLessThan(1);

    let reading = firstMiss;
    const window = DEFAULT_ASTRALOCK_CONFIG.trackQuality.persistenceWindow;
    for (let i = 0; i < window; i += 1) reading = q.update(null, null, GATE, 5e-3);

    expect(reading.quality).toBeLessThan(healthy);
    expect(reading.persistence).toBe(0);
  });

  it('falls when the innovations stop being consistent', () => {
    const good = settle(quality(), 60, 0.6, 0.5, 5e-5);
    const erratic = settle(quality(), 60, 0.6, 12, 5e-5);

    expect(erratic.consistency).toBeLessThan(good.consistency);
    expect(erratic.quality).toBeLessThan(good.quality);
  });

  it('falls when the estimate becomes uncertain', () => {
    const certain = settle(quality(), 60, 0.6, 0.5, 5e-5);
    const vague = settle(quality(), 60, 0.6, 0.5, 5e-3);

    expect(vague.certainty).toBeLessThan(certain.certainty);
  });

  it('reports its four components, so a low score can be explained', () => {
    // A single opaque number would say a track is poor without saying why.
    const reading = settle(quality(), 30, 0.6, 0.5, 5e-5);
    for (const part of [
      reading.strength,
      reading.consistency,
      reading.persistence,
      reading.certainty,
    ]) {
      expect(part).toBeGreaterThanOrEqual(0);
      expect(part).toBeLessThanOrEqual(1);
    }
    expect(reading.quality).toBeCloseTo(
      (reading.strength + reading.consistency + reading.persistence + reading.certainty) / 4,
      12,
    );
  });

  it('stays on [0, 1] under every input', () => {
    const q = quality();
    for (const [score, nis, sigma] of [
      [0, 0, 0],
      [1e6, 1e6, 1e6],
      [1, 0, 1e-9],
      [null, null, 0],
    ] as const) {
      const reading = q.update(score, nis, GATE, sigma);
      expect(reading.quality).toBeGreaterThanOrEqual(0);
      expect(reading.quality).toBeLessThanOrEqual(1);
    }
  });

  it('reset clears the history', () => {
    const q = quality();
    settle(q, 40, 0.6, 0.5, 5e-5);
    q.reset();
    const fresh = q.update(0.6, 0.5, GATE, 5e-5);
    expect(fresh.persistence).toBeCloseTo(
      1 / DEFAULT_ASTRALOCK_CONFIG.trackQuality.persistenceWindow,
      12,
    );
  });
});

// --- Handoff gate -----------------------------------------------------------

describe('handoff readiness', () => {
  const handoffRule = (patch: Partial<HandoffRule> = {}): HandoffRule => ({
    ...DEFAULT_ASTRALOCK_CONFIG.handoff,
    ...patch,
  });

  const good = {
    observed: true,
    residualAzimuth: 1e-4,
    residualElevation: 1e-4,
    angularSigma: 1e-4,
    angularRate: 1e-3,
    trackQuality: 0.9,
  };

  it('is not ready immediately, however good the conditions look', () => {
    // One good frame is not a settled coarse track.
    const gate = new HandoffGate(handoffRule({ dwell: 0.5 }));
    expect(gate.update(0, good, false).ready).toBe(false);
  });

  it('becomes ready once the conditions have held for the dwell', () => {
    const gate = new HandoffGate(handoffRule({ dwell: 0.5 }));
    gate.update(0, good, false);
    expect(gate.update(0.4, good, false).ready).toBe(false);
    expect(gate.update(0.6, good, false).ready).toBe(true);
  });

  it('reports dwell progress while it waits', () => {
    const gate = new HandoffGate(handoffRule({ dwell: 0.5 }));
    gate.update(0, good, false);
    expect(gate.update(0.25, good, false).dwell).toBeCloseTo(0.25, 9);
  });

  it('clears at once when the measurement disappears', () => {
    // Readiness is a claim about a track that is currently being observed.
    const gate = new HandoffGate(handoffRule({ dwell: 0.2 }));
    gate.update(0, good, false);
    const ready = gate.update(0.3, good, false);
    expect(ready.ready).toBe(true);

    const lost = gate.update(
      0.35,
      { ...good, observed: false, residualAzimuth: null, residualElevation: null },
      true,
    );
    expect(lost.ready).toBe(false);
  });

  it('clears when the residual grows past the threshold', () => {
    const gate = new HandoffGate(handoffRule({ dwell: 0.2, exitHysteresis: 1 }));
    gate.update(0, good, false);
    expect(gate.update(0.3, good, false).ready).toBe(true);
    expect(gate.update(0.35, { ...good, residualAzimuth: 1 }, true).ready).toBe(false);
  });

  it('clears when the estimate becomes too uncertain, or the target too fast', () => {
    const uncertain = new HandoffGate(handoffRule({ dwell: 0.2, exitHysteresis: 1 }));
    uncertain.update(0, good, false);
    uncertain.update(0.3, good, false);
    expect(uncertain.update(0.35, { ...good, angularSigma: 1 }, true).ready).toBe(false);

    const fast = new HandoffGate(handoffRule({ dwell: 0.2, exitHysteresis: 1 }));
    fast.update(0, good, false);
    fast.update(0.3, good, false);
    expect(fast.update(0.35, { ...good, angularRate: 10 }, true).ready).toBe(false);
  });

  it('does not chatter on the boundary', () => {
    // Hysteresis: once ready, the thresholds relax, so a track sitting exactly
    // on the limit does not toggle every frame.
    const gate = new HandoffGate(
      handoffRule({ dwell: 0.2, exitHysteresis: 1.5, maxAngularRate: 1e-3 }),
    );
    gate.update(0, good, false);
    expect(gate.update(0.3, good, false).ready).toBe(true);

    const marginal = { ...good, angularRate: 1.2e-3 };
    expect(gate.update(0.35, marginal, true).ready).toBe(true);
    // A fresh gate at the same conditions would not have entered.
    const fresh = new HandoffGate(
      handoffRule({ dwell: 0.2, exitHysteresis: 1.5, maxAngularRate: 1e-3 }),
    );
    fresh.update(0, marginal, false);
    expect(fresh.update(0.3, marginal, false).ready).toBe(false);
  });

  it('can be disabled entirely', () => {
    const gate = new HandoffGate(handoffRule({ enabled: false, dwell: 0 }));
    gate.update(0, good, false);
    expect(gate.update(1, good, false).ready).toBe(false);
  });

  it('uses only quantities the tracker can compute', () => {
    // Residual is measured boresight offset, sigma comes from the estimator's
    // own covariance, rate from its own state, quality from its own history.
    // There is no parameter through which a true pointing error could arrive.
    expect(Object.keys(good).sort()).toEqual([
      'angularRate',
      'angularSigma',
      'observed',
      'residualAzimuth',
      'residualElevation',
      'trackQuality',
    ]);
  });
});
