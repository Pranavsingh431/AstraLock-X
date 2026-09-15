/**
 * The non-probabilistic signals AstraLock-X decides with: acquisition evidence,
 * track quality and handoff readiness, plus gated measurement association.
 *
 * None of these is a probability, and none is named as one. Each is a documented
 * combination of safe quantities — detector scores, innovations, persistence,
 * estimator covariance, measured residuals. No target identity or truth enters.
 */

import type { BlobMeasurement, DetectionResult } from '../baseline/detector';
import { pixelToBearing } from '../baseline/bearing';
import type { CameraSensorFrame, CameraState } from '@/core/contracts/sensors';

import type { GateResult, ImmEstimator, ImmPrediction } from './imm';
import type { IdentityState } from './identity';

const clamp01 = (value: number): number => (value < 0 ? 0 : value > 1 ? 1 : value);

// --- Candidates and association ---------------------------------------------

export interface CandidateBearing {
  readonly blob: BlobMeasurement;
  /** Continuous image coordinates. */
  readonly u: number;
  readonly v: number;
  readonly azimuth: number;
  readonly elevation: number;
  /** Detector strength on [0, 1]: integrated intensity over a saturated blob of the same area. */
  readonly score: number;
}

const FULL_SCALE: Record<string, number> = { mono8: 255, mono16: 65535 };

/** Every candidate as a world bearing, using the pose the mount reported for this frame. */
export function candidateBearings(
  detection: DetectionResult,
  frame: CameraSensorFrame,
  camera: CameraState,
  threshold: number,
): CandidateBearing[] {
  const headroom = (FULL_SCALE[frame.format] ?? 255) - threshold;
  return detection.candidates.map((blob) => {
    const u = blob.centroidX + 0.5;
    const v = blob.centroidY + 0.5;
    const bearing = pixelToBearing(u, v, camera, frame.pose.azimuth, frame.pose.elevation);
    return {
      blob,
      u,
      v,
      azimuth: bearing.azimuth,
      elevation: bearing.elevation,
      score: headroom > 0 ? clamp01(blob.integratedIntensity / (blob.area * headroom)) : 0,
    };
  });
}

/**
 * Ranking for SEARCH: strongest integrated intensity above a score floor,
 * skipping anything identity has already turned down.
 *
 * The brightness ranking is Phase 6's and is unchanged when `identityOf` is
 * absent. What it adds is memory: identity evidence accumulates on every frame
 * whatever state the machine is in, so by the time SEARCH looks at a source it
 * has often been watched long enough to know it is the wrong one. Ignoring that
 * would make the machine oscillate — SEARCH hands the brightest source to
 * ACQUIRE, ACQUIRE refuses it on identity, SEARCH offers the same source again
 * — and the real beacon, being dimmer, would never get a turn.
 *
 * Only settled refusals are skipped. A source identity has not yet judged is
 * still eligible, because refusing to start on an unjudged source would mean
 * never starting at all: the evidence only exists once something has been
 * watched.
 */
export function strongestCandidate(
  candidates: readonly CandidateBearing[],
  minScore: number,
  identityOf: ((candidate: CandidateBearing) => IdentityState | null) | null = null,
): CandidateBearing | null {
  let best: CandidateBearing | null = null;
  for (const c of candidates) {
    if (c.score < minScore) continue;
    if (identityOf !== null) {
      const state = identityOf(c);
      if (state === 'mismatch' || state === 'ambiguous') continue;
    }
    if (best === null || c.blob.integratedIntensity > best.blob.integratedIntensity) best = c;
  }
  return best;
}

export interface Association {
  readonly accepted: CandidateBearing | null;
  readonly gate: GateResult | null;
  /** Candidates that were considered and not taken. */
  readonly rejected: number;
  /** Of those, how many were turned down on identity rather than on geometry. */
  readonly identityRejected: number;
}

/**
 * Nearest-neighbour association in normalised innovation squared.
 *
 * A candidate is admissible if its NIS is within the chi-square gate and its
 * angular innovation within `maxRadius`; the admissible candidate with the
 * smallest NIS is chosen. This prefers what the estimator expects over what is
 * brightest.
 *
 * On its own it does **not** establish identity: a decoy inside the gate with a
 * smaller NIS than the real beacon will be taken, which is precisely the
 * failure Phase 7 measured. When `identityOf` is supplied the choice becomes
 * staged — the gate still decides what is admissible, and identity then decides
 * between the admissible — and a candidate the correlator has rejected is not
 * taken at all.
 */
export function associate(
  imm: ImmEstimator,
  prediction: ImmPrediction,
  candidates: readonly CandidateBearing[],
  gateChi2: number,
  maxRadius: number,
  minScore: number,
  /**
   * Identity verdict for a candidate, or `null` when identity is not in use.
   *
   * Supplied as a lookup rather than carried on the candidate so that the
   * geometric association stays exactly what it was when identity is disabled:
   * the same function, the same comparisons, the same result.
   */
  identityOf: ((candidate: CandidateBearing) => IdentityState | null) | null = null,
): Association {
  let accepted: CandidateBearing | null = null;
  let acceptedGate: GateResult | null = null;
  let acceptedRank = -1;
  let rejected = 0;
  let identityRejected = 0;

  for (const c of candidates) {
    if (c.score < minScore) continue;
    const gate = imm.gate(prediction, c.azimuth, c.elevation);
    if (gate === null) continue;
    const radius = Math.hypot(gate.innovation[0] * Math.cos(c.elevation), gate.innovation[1]);

    // Physics first, and physics is never overridden. A candidate outside the
    // motion gate is not where the target can be, and no amount of code
    // correlation makes it so — a decoy that somehow carried the right pattern
    // still cannot have teleported.
    if (gate.nis > gateChi2 || radius > maxRadius) {
      rejected += 1;
      continue;
    }

    const state = identityOf === null ? null : identityOf(c);

    // A candidate the correlator has positively rejected is not taken, even if
    // it is the only one left. Following it would mean holding a source the
    // evidence says is the wrong one; declining leaves the estimator coasting,
    // which is what RECOVER is for and is the better failure.
    //
    // A mismatch needs enough evidence to be reached at all, so a transient
    // cannot cause this.
    if (state === 'mismatch') {
      rejected += 1;
      identityRejected += 1;
      continue;
    }

    // Staged, not weighted. Identity chooses between candidates the physics has
    // already admitted; within one identity class the smallest innovation wins,
    // exactly as before. There is no arithmetic trading a correlation against a
    // chi-square, because the two are not commensurable and a weight would only
    // hide that.
    const rank = state === 'match' ? 1 : 0;
    if (
      acceptedGate === null ||
      rank > acceptedRank ||
      (rank === acceptedRank && gate.nis < acceptedGate.nis)
    ) {
      accepted = c;
      acceptedGate = gate;
      acceptedRank = rank;
    }
  }
  return { accepted, gate: acceptedGate, rejected, identityRejected };
}

// --- Acquisition evidence -----------------------------------------------------

export interface AcquisitionRule {
  readonly minSupportingObservations: number;
  readonly minPersistence: number;
  readonly maxConsecutiveMisses: number;
  readonly maxMeanNis: number;
}

/**
 * Evidence that a candidate is a persistent, kinematically consistent source.
 *
 * `evidence = min(1, supports / minSupports) · min(1, persistence / minPersistence)`,
 * reduced to half while the mean support NIS exceeds its limit. A progress
 * measure for the operator, not a probability of anything.
 */
export class AcquisitionEvidence {
  private firstTime = 0;
  private lastTime = 0;
  private supportCount = 0;
  private nisSum = 0;
  private nisCount = 0;
  private misses = 0;

  constructor(private readonly rule: AcquisitionRule) {}

  public start(time: number): void {
    this.firstTime = time;
    this.lastTime = time;
    this.supportCount = 1;
    this.nisSum = 0;
    this.nisCount = 0;
    this.misses = 0;
  }

  public support(time: number, nis: number): void {
    this.supportCount += 1;
    this.lastTime = time;
    this.nisSum += nis;
    this.nisCount += 1;
    this.misses = 0;
  }

  public miss(): void {
    this.misses += 1;
  }

  public get supports(): number {
    return this.supportCount;
  }

  public get meanNis(): number | null {
    return this.nisCount === 0 ? null : this.nisSum / this.nisCount;
  }

  public get failed(): boolean {
    return this.misses > this.rule.maxConsecutiveMisses;
  }

  public get persistence(): number {
    return this.lastTime - this.firstTime;
  }

  public get consistent(): boolean {
    const mean = this.meanNis;
    return mean === null || mean <= this.rule.maxMeanNis;
  }

  public get ready(): boolean {
    return (
      this.supportCount >= this.rule.minSupportingObservations &&
      this.persistence >= this.rule.minPersistence &&
      this.meanNis !== null &&
      this.consistent
    );
  }

  public get evidence(): number {
    const count = Math.min(1, this.supportCount / this.rule.minSupportingObservations);
    const time =
      this.rule.minPersistence <= 0 ? 1 : Math.min(1, this.persistence / this.rule.minPersistence);
    return count * time * (this.consistent ? 1 : 0.5);
  }
}

// --- Track quality ------------------------------------------------------------

export interface TrackQualityConfig {
  readonly scoreReference: number;
  readonly sigmaReference: number;
  readonly persistenceWindow: number;
  readonly nisSmoothing: number;
}

export interface TrackQualityReading {
  readonly quality: number;
  readonly strength: number;
  readonly consistency: number;
  readonly persistence: number;
  readonly certainty: number;
}

/**
 * `trackQuality = (strength + consistency + persistence + certainty) / 4`, each on [0, 1]:
 *
 * - strength    = clamp(candidateScore / scoreReference), 0 with no accepted measurement
 * - consistency = clamp(1 − NIS_ewma / gateChi2), NIS smoothed over accepted measurements
 * - persistence = accepted measurements in the last `persistenceWindow` frames / window
 * - certainty   = clamp(1 − angularSigma / sigmaReference)
 *
 * Non-probabilistic. Not calibrated against labelled data and not described as
 * the probability of anything.
 */
export class TrackQuality {
  private readonly hits: boolean[] = [];
  private nisEwma: number | null = null;

  constructor(private readonly config: TrackQualityConfig) {}

  public reset(): void {
    this.hits.length = 0;
    this.nisEwma = null;
  }

  public update(
    acceptedScore: number | null,
    nis: number | null,
    gateChi2: number,
    angularSigma: number,
  ): TrackQualityReading {
    this.hits.push(acceptedScore !== null);
    if (this.hits.length > this.config.persistenceWindow) this.hits.shift();
    if (nis !== null && Number.isFinite(nis)) {
      this.nisEwma =
        this.nisEwma === null
          ? nis
          : this.nisEwma + this.config.nisSmoothing * (nis - this.nisEwma);
    }
    const strength =
      acceptedScore === null ? 0 : clamp01(acceptedScore / this.config.scoreReference);
    const consistency = this.nisEwma === null ? 0 : clamp01(1 - this.nisEwma / gateChi2);
    const persistence = this.hits.filter(Boolean).length / this.config.persistenceWindow;
    const certainty = clamp01(1 - angularSigma / this.config.sigmaReference);
    return {
      quality: (strength + consistency + persistence + certainty) / 4,
      strength,
      consistency,
      persistence,
      certainty,
    };
  }
}

// --- Handoff readiness --------------------------------------------------------

export interface HandoffRule {
  readonly enabled: boolean;
  readonly maxResidualAzimuth: number;
  readonly maxResidualElevation: number;
  readonly maxAngularSigma: number;
  readonly maxAngularRate: number;
  readonly minTrackQuality: number;
  readonly dwell: number;
  readonly exitHysteresis: number;
}

export interface HandoffInputs {
  /** Whether a measurement was associated on this frame. */
  readonly observed: boolean;
  /** Measured boresight residual of that measurement, radians; `null` without one. */
  readonly residualAzimuth: number | null;
  readonly residualElevation: number | null;
  readonly angularSigma: number;
  readonly angularRate: number;
  readonly trackQuality: number;
}

export interface HandoffReading {
  readonly ready: boolean;
  readonly conditionsMet: boolean;
  /** How long the conditions have held continuously, seconds. */
  readonly dwell: number;
}

/**
 * Coarse-to-fine handoff readiness from safe quantities only.
 *
 * Ready once every condition has held continuously for `dwell`. While ready, the
 * thresholds are relaxed by `exitHysteresis`, so readiness does not chatter on
 * the boundary; a missing measurement clears it at once.
 */
export class HandoffGate {
  private since: number | null = null;

  constructor(private readonly rule: HandoffRule) {}

  public reset(): void {
    this.since = null;
  }

  public update(time: number, inputs: HandoffInputs, currentlyReady: boolean): HandoffReading {
    const r = this.rule;
    const f = currentlyReady ? r.exitHysteresis : 1;
    const met =
      r.enabled &&
      inputs.observed &&
      inputs.residualAzimuth !== null &&
      inputs.residualElevation !== null &&
      Math.abs(inputs.residualAzimuth) <= r.maxResidualAzimuth * f &&
      Math.abs(inputs.residualElevation) <= r.maxResidualElevation * f &&
      inputs.angularSigma <= r.maxAngularSigma * f &&
      inputs.angularRate <= r.maxAngularRate * f &&
      inputs.trackQuality >= r.minTrackQuality / f;

    if (!met) {
      this.since = null;
      return { ready: false, conditionsMet: false, dwell: 0 };
    }
    this.since ??= time;
    const dwell = time - this.since;
    return { ready: currentlyReady || dwell >= r.dwell, conditionsMet: true, dwell };
  }
}
