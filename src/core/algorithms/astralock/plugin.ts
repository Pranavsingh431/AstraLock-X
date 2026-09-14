/**
 * `astralock-x` — AstraLock-X Reference PAT.
 *
 * The robust reference implementation, alongside the baseline rather than
 * replacing it. Pixels in, pointing intent out, through the same
 * `AlgorithmPlugin` contract and the same closed-loop runtime:
 *
 * ```
 *   GRAY8 ─▶ detector (the baseline's) ─▶ candidate bearings (measured pose)
 *        ─▶ gated association ─▶ IMM (NCV ⇄ NCA) ─▶ prediction to actuation time
 *        ─▶ feedback + feed-forward ─▶ position intent
 * ```
 *
 * States, with explicit transitions (docs/ASTRALOCK_PAT.md):
 *
 * ```
 *   SEARCH ──candidate──▶ ACQUIRE ──evidence──▶ TRACK ──conditions + dwell──▶ HANDOFF
 *     ▲                      │                  │  ▲                            │
 *     │               evidence broke            │  └──conditions lapse──────────┘
 *     ├──────────────────────┘          misses  ▼                               │
 *     └──timeout / uncertainty──────────── RECOVER ◀──────────misses────────────┘
 *                                           │
 *                                   gated reacquisition ──▶ TRACK
 * ```
 *
 * It receives only `TrackingInput`. There is no target identity, no truth, no
 * simulator — the barrier and the contract's type proofs apply to this directory
 * exactly as they do to the baseline. Its known weakness is identity: a
 * sufficiently plausible decoy inside the association gate can capture it.
 */

import type {
  AlgorithmInit,
  AlgorithmInstance,
  StageProfiler,
  TrackingInput,
  TrackingOutput,
} from '@/core/contracts/algorithm-plugin';
import { UNPROFILED, defineAlgorithm } from '@/core/contracts/algorithm-plugin';
import type { CommandIntent } from '@/core/contracts/control';
import type { TargetEstimate, TrackId } from '@/core/contracts/estimation';
import type { Matrix4x4 } from '@/core/contracts/geometry';
import type { Decibels } from '@/core/contracts/units';
import { notModelled } from '@/core/contracts/measurement';
import type { PATMode, PATState, PATTransitionReason } from '@/core/contracts/pat';
import type { ObservationId, TargetObservation } from '@/core/contracts/perception';
import type { CameraState } from '@/core/contracts/sensors';
import { normalized, pixels, radians, radiansPerSecond, seconds } from '@/core/contracts/units';

import { shortestAngle } from '../baseline/angles';
import { bearingToPixel } from '../baseline/bearing';
import { blobBounds, detect } from '../baseline/detector';
import type { AstraLockConfig } from './config';
import { DEFAULT_ASTRALOCK_CONFIG, astraLockConfigSchema } from './config';
import { PointingController } from './controller';
import type {
  Association,
  CandidateBearing,
  HandoffReading,
  TrackQualityReading,
} from './evidence';
import {
  AcquisitionEvidence,
  HandoffGate,
  TrackQuality,
  associate,
  candidateBearings,
  strongestCandidate,
} from './evidence';
import { ImmEstimator } from './imm';
import { eigen2 } from './matrix';
import type { Pointing } from './search';
import {
  WaypointSearch,
  assertCoverage,
  coverageWaypoints,
  localSearchOffset,
  localSearchRadius,
  priorWaypoints,
} from './search';

export type AstraLockState = 'search' | 'acquire' | 'track' | 'recover' | 'handoff';

const MODE_FOR: Record<AstraLockState, PATMode> = {
  search: 'scan',
  acquire: 'acquire',
  track: 'track',
  recover: 'reacquire',
  handoff: 'handoff',
};

/** An uncertainty ellipse projected onto the image, derived from estimator covariance. */
export interface UncertaintyEllipse {
  readonly centreX: number;
  readonly centreY: number;
  readonly semiMajorPx: number;
  readonly semiMinorPx: number;
  /** Major-axis angle in image coordinates (x right, y down), radians. */
  readonly angle: number;
  /** How many standard deviations the semi-axes represent. */
  readonly sigmas: number;
}

/**
 * Everything AstraLock-X reports about itself, from safe information only.
 *
 * The first block matches the baseline's debug fields so the operator interface
 * can show either algorithm; the second is specific to this one.
 */
export interface AstraLockDebug {
  readonly state: AstraLockState;
  readonly candidateCount: number;
  readonly componentsFound: number;
  readonly centroidX: number | null;
  readonly centroidY: number | null;
  readonly boundingBox: { x: number; y: number; width: number; height: number } | null;
  readonly candidateScore: number | null;
  readonly measuredAzimuth: number | null;
  readonly measuredElevation: number | null;
  readonly filteredAzimuth: number | null;
  readonly filteredElevation: number | null;
  readonly azimuthRate: number | null;
  readonly elevationRate: number | null;
  readonly predictedImageX: number | null;
  readonly predictedImageY: number | null;
  /** Feedback correction this frame, radians. */
  readonly panCorrection: number;
  readonly tiltCorrection: number;
  readonly consecutiveMisses: number;
  readonly searchWaypointIndex: number | null;
  readonly searchWaypointCount: number;
  readonly searchPan: number | null;
  readonly searchTilt: number | null;
  readonly framesProcessed: number;

  readonly algorithm: 'astralock-x';
  readonly trackQuality: number | null;
  readonly qualityComponents: Omit<TrackQualityReading, 'quality'> | null;
  readonly acquisitionEvidence: number | null;
  readonly acquisitionSupports: number | null;
  readonly innovationNis: number | null;
  readonly gateAccepted: boolean | null;
  readonly gateRejected: number;
  readonly immCvProbability: number | null;
  readonly immCaProbability: number | null;
  readonly azimuthAcceleration: number | null;
  readonly elevationAcceleration: number | null;
  readonly angularSigma: number | null;
  readonly predictionHorizon: number;
  readonly predictedAzimuth: number | null;
  readonly predictedElevation: number | null;
  readonly feedforwardPan: number | null;
  readonly feedforwardTilt: number | null;
  readonly recoveryAge: number | null;
  readonly localSearchRadius: number | null;
  readonly localSearchIndex: number | null;
  readonly handoffDwell: number | null;
  readonly handoffConditionsMet: boolean;
  readonly handoffRequiredDwell: number;
  readonly uncertaintyEllipse: UncertaintyEllipse | null;
  readonly priorSource: string | null;
}

let observationCounter = 0;
const nextObservationId = (): ObservationId => {
  observationCounter += 1;
  return `alx-obs-${String(observationCounter)}` as ObservationId;
};
const TRACK_ID = 'astralock-0' as TrackId;
const ELLIPSE_SIGMAS = 2;

interface FrameWork {
  association: Association | null;
  accepted: CandidateBearing | null;
  intentTarget: {
    azimuth: number;
    elevation: number;
    offsetAzimuth: number;
    offsetElevation: number;
  } | null;
  waypoint: Pointing | null;
  quality: TrackQualityReading | null;
  handoff: HandoffReading | null;
  recoveryAge: number | null;
  localRadius: number | null;
  localIndex: number | null;
}

class AstraLockInstance implements AlgorithmInstance<AstraLockDebug> {
  private readonly config: AstraLockConfig;
  private readonly camera: CameraState;
  private readonly profiler: StageProfiler;
  private readonly imm: ImmEstimator;
  private readonly controller: PointingController;
  private readonly evidence: AcquisitionEvidence;
  private readonly quality: TrackQuality;
  private readonly handoffGate: HandoffGate;
  private readonly search: WaypointSearch;

  private state: AstraLockState = 'search';
  private stateSince = 0;
  private lastReason: PATTransitionReason = 'commanded';
  private transitions = 0;
  private misses = 0;
  private lastFrameId = -1;
  private framesProcessed = 0;
  private lastCommandTime: number | null = null;
  private lastMeasurementTime = 0;
  private recoverStart = 0;
  private lastNis: number | null = null;
  private lastQuality: TrackQualityReading | null = null;

  constructor(init: AlgorithmInit<AstraLockConfig>) {
    this.config = init.config;
    this.camera = init.camera;
    this.profiler = init.profiler ?? UNPROFILED;
    this.imm = new ImmEstimator(init.config.imm);
    this.controller = new PointingController(init.config.controller);
    this.evidence = new AcquisitionEvidence(init.config.acquisition);
    this.quality = new TrackQuality(init.config.trackQuality);
    this.handoffGate = new HandoffGate(init.config.handoff);

    const fov = {
      horizontal: init.camera.horizontalFov as number,
      vertical: init.camera.verticalFov as number,
    };
    const s = init.config.search;
    assertCoverage(fov, s.overlapFraction, s.settleTolerance);
    const waypoints =
      s.prior === null
        ? coverageWaypoints(s, fov, s.overlapFraction)
        : priorWaypoints(s.prior, s, fov, s.overlapFraction, s.priorSigmaExtent);
    this.search = new WaypointSearch(waypoints, s);
  }

  public reset(): void {
    this.imm.reset();
    this.controller.reset();
    this.quality.reset();
    this.handoffGate.reset();
    this.search.reset();
    this.state = 'search';
    this.stateSince = 0;
    this.lastReason = 'commanded';
    this.transitions = 0;
    this.misses = 0;
    this.lastFrameId = -1;
    this.framesProcessed = 0;
    this.lastCommandTime = null;
    this.lastMeasurementTime = 0;
    this.recoverStart = 0;
    this.lastNis = null;
    this.lastQuality = null;
  }

  private transition(to: AstraLockState, reason: PATTransitionReason, time: number): void {
    if (this.state === to) return;
    this.state = to;
    this.stateSince = time;
    this.lastReason = reason;
    this.transitions += 1;
  }

  public update(input: TrackingInput): TrackingOutput<AstraLockDebug> {
    const frame = input.frame;
    const time = input.time as number;
    if (frame === null || frame.frameId === this.lastFrameId) {
      return this.output(input, null, emptyWork(), null, 0);
    }
    this.lastFrameId = frame.frameId;
    this.framesProcessed += 1;

    const c = this.config;
    const captureTime = frame.captureTime as number;
    const dt = this.lastCommandTime === null ? 0 : time - this.lastCommandTime;
    this.lastCommandTime = time;

    const detection = this.profiler.time('detector', () => detect(frame, c.detector));
    const candidates = this.profiler.time('bearing-transform', () =>
      candidateBearings(detection, frame, this.camera, c.detector.threshold),
    );

    const work = emptyWork();

    switch (this.state) {
      case 'search': {
        const best = strongestCandidate(candidates, c.acquisition.minCandidateScore);
        if (best !== null) {
          this.imm.initialise(best.azimuth, best.elevation, captureTime);
          this.evidence.start(captureTime);
          this.quality.reset();
          this.handoffGate.reset();
          this.controller.reset();
          this.lastNis = null;
          work.accepted = best;
          this.transition('acquire', 'candidate-detected', time);
          work.intentTarget = { azimuth: 0, elevation: 0, offsetAzimuth: 0, offsetElevation: 0 };
        } else {
          work.waypoint = this.profiler.time('controller', () =>
            this.search.step(
              time,
              { azimuth: input.gimbal.azimuth, elevation: input.gimbal.elevation },
              input.gimbal.azimuthRate,
              input.gimbal.elevationRate,
            ),
          );
        }
        break;
      }

      case 'acquire': {
        const prediction = this.profiler.time('estimator', () => this.imm.predict(captureTime));
        work.association = associate(
          this.imm,
          prediction,
          candidates,
          c.acquisition.gateChi2,
          c.acquisition.maxBearingDisplacement,
          c.acquisition.minCandidateScore,
        );
        const accepted = work.association.accepted;
        if (accepted !== null && work.association.gate !== null) {
          this.profiler.time('estimator', () =>
            this.imm.applyMeasurement(prediction, accepted.azimuth, accepted.elevation),
          );
          this.evidence.support(captureTime, work.association.gate.nis);
          this.lastNis = work.association.gate.nis;
          work.accepted = accepted;
        } else {
          this.imm.applyNoMeasurement(prediction);
          this.evidence.miss();
        }

        if (this.evidence.ready) {
          this.lastMeasurementTime = captureTime;
          this.misses = 0;
          this.transition('track', 'track-confirmed', time);
          work.intentTarget = { azimuth: 0, elevation: 0, offsetAzimuth: 0, offsetElevation: 0 };
        } else if (this.evidence.failed) {
          this.imm.reset();
          this.transition('search', 'track-lost', time);
          work.waypoint = this.search.current;
        } else {
          work.intentTarget = { azimuth: 0, elevation: 0, offsetAzimuth: 0, offsetElevation: 0 };
        }
        break;
      }

      case 'track':
      case 'handoff': {
        const prediction = this.profiler.time('estimator', () => this.imm.predict(captureTime));
        work.association = associate(
          this.imm,
          prediction,
          candidates,
          c.gating.trackGateChi2,
          c.gating.trackMaxGateRadius,
          c.acquisition.minCandidateScore,
        );
        const accepted = work.association.accepted;
        if (accepted !== null && work.association.gate !== null) {
          this.profiler.time('estimator', () =>
            this.imm.applyMeasurement(prediction, accepted.azimuth, accepted.elevation),
          );
          this.misses = 0;
          this.lastMeasurementTime = captureTime;
          this.lastNis = work.association.gate.nis;
          work.accepted = accepted;
        } else {
          this.imm.applyNoMeasurement(prediction);
          this.misses += 1;
        }

        const estimate = this.imm.estimate();
        const sigma = ImmEstimator.angularSigma(estimate.covariance);
        work.quality = this.quality.update(
          accepted?.score ?? null,
          accepted === null ? null : this.lastNis,
          c.gating.trackGateChi2,
          sigma,
        );
        this.lastQuality = work.quality;

        if (this.misses >= c.recovery.missesBeforeRecover) {
          this.recoverStart = this.lastMeasurementTime;
          this.handoffGate.reset();
          this.controller.reset();
          this.transition('recover', 'track-lost', time);
          work.recoveryAge = captureTime - this.recoverStart;
        } else {
          const rate = Math.hypot(
            estimate.state[2]! * Math.cos(estimate.state[1]!),
            estimate.state[3]!,
          );
          work.handoff = this.handoffGate.update(
            time,
            {
              observed: accepted !== null,
              residualAzimuth:
                accepted === null ? null : shortestAngle(accepted.azimuth, frame.pose.azimuth),
              residualElevation:
                accepted === null ? null : accepted.elevation - (frame.pose.elevation as number),
              angularSigma: sigma,
              angularRate: rate,
              trackQuality: work.quality.quality,
            },
            this.state === 'handoff',
          );
          if (this.state === 'track' && work.handoff.ready)
            this.transition('handoff', 'track-confirmed', time);
          else if (this.state === 'handoff' && !work.handoff.ready)
            this.transition('track', 'track-lost', time);
        }
        work.intentTarget = { azimuth: 0, elevation: 0, offsetAzimuth: 0, offsetElevation: 0 };
        break;
      }

      case 'recover': {
        const prediction = this.profiler.time('estimator', () => this.imm.predict(captureTime));
        work.association = associate(
          this.imm,
          prediction,
          candidates,
          c.gating.recoverGateChi2,
          c.gating.recoverMaxGateRadius,
          c.acquisition.minCandidateScore,
        );
        const accepted = work.association.accepted;
        if (accepted !== null && work.association.gate !== null) {
          this.profiler.time('estimator', () =>
            this.imm.applyMeasurement(prediction, accepted.azimuth, accepted.elevation),
          );
          this.misses = 0;
          this.lastMeasurementTime = captureTime;
          this.lastNis = work.association.gate.nis;
          work.accepted = accepted;
          work.quality = this.quality.update(
            accepted.score,
            this.lastNis,
            c.gating.trackGateChi2,
            ImmEstimator.angularSigma(this.imm.estimate().covariance),
          );
          this.lastQuality = work.quality;
          // The estimator is kept: reacquisition continues the track it had.
          this.transition('track', 'candidate-detected', time);
          work.intentTarget = { azimuth: 0, elevation: 0, offsetAzimuth: 0, offsetElevation: 0 };
          break;
        }

        this.imm.applyNoMeasurement(prediction);
        this.misses += 1;
        const estimate = this.imm.estimate();
        const sigma = ImmEstimator.angularSigma(estimate.covariance);
        const age = captureTime - this.recoverStart;
        work.recoveryAge = age;
        work.quality = this.quality.update(null, null, c.gating.trackGateChi2, sigma);
        this.lastQuality = work.quality;

        if (age > c.recovery.maxDuration || sigma > c.recovery.maxAngularSigma) {
          // Give up locally, but start the global search where the target was
          // last predicted rather than at the beginning of the pattern.
          this.search.startNearest({ azimuth: estimate.state[0]!, elevation: estimate.state[1]! });
          this.imm.reset();
          this.controller.reset();
          this.transition('search', 'search-exhausted', time);
          work.waypoint = this.search.current;
          break;
        }

        let offsetAzimuth = 0;
        let offsetElevation = 0;
        if (age >= c.recovery.localSearchDelay) {
          const radius = localSearchRadius(sigma, c.recovery);
          const offset = localSearchOffset(
            age - c.recovery.localSearchDelay,
            radius,
            estimate.state[1]!,
            c.recovery,
          );
          offsetAzimuth = offset.azimuth;
          offsetElevation = offset.elevation;
          work.localRadius = radius;
          work.localIndex = offset.index;
        }
        work.intentTarget = { azimuth: 0, elevation: 0, offsetAzimuth, offsetElevation };
        break;
      }
    }

    return this.output(input, detection, work, candidates, dt);
  }

  /** Builds the command and every reported field. */
  private output(
    input: TrackingInput,
    detection: ReturnType<typeof detect> | null,
    work: FrameWork,
    candidates: readonly CandidateBearing[] | null,
    dt: number,
  ): TrackingOutput<AstraLockDebug> {
    const time = input.time as number;
    const horizon = this.controller.horizon;
    const measured = {
      azimuth: input.gimbal.azimuth as number,
      elevation: input.gimbal.elevation as number,
    };
    const limits = { azimuth: input.gimbal.azimuthLimits, elevation: input.gimbal.elevationLimits };

    let intent: CommandIntent | null = null;
    let feedforward: { azimuth: number; elevation: number } | null = null;
    let feedback = { azimuth: 0, elevation: 0 };
    let predictedAhead: readonly number[] | null = null;
    let now: ReturnType<ImmEstimator['predict']> | null = null;

    if (work.intentTarget !== null && this.imm.isInitialised && detection !== null) {
      // Latency-aware: the target where it is at issue time, and where it will be
      // when this command takes effect.
      now = this.imm.predict(time);
      const ahead = this.imm.predict(time + horizon);
      predictedAhead = ahead.state;
      const { offsetAzimuth, offsetElevation } = work.intentTarget;
      const command = this.profiler.time('controller', () =>
        this.controller.step({
          target: {
            azimuth: now!.state[0]! + offsetAzimuth,
            elevation: now!.state[1]! + offsetElevation,
          },
          targetAtHorizon: {
            azimuth: ahead.state[0]! + offsetAzimuth,
            elevation: ahead.state[1]! + offsetElevation,
          },
          measured,
          dt,
          limits,
        }),
      );
      intent = {
        kind: 'position',
        azimuth: radians(command.setpointAzimuth),
        elevation: radians(command.setpointElevation),
      };
      feedforward = {
        azimuth: command.feedforwardAzimuth,
        elevation: command.feedforwardElevation,
      };
      feedback = { azimuth: command.feedbackAzimuth, elevation: command.feedbackElevation };
    } else if (work.waypoint !== null) {
      intent = {
        kind: 'position',
        azimuth: radians(work.waypoint.azimuth),
        elevation: radians(work.waypoint.elevation),
      };
    }

    const estimate = this.imm.isInitialised ? this.imm.estimate() : null;
    const sigma = estimate === null ? null : ImmEstimator.angularSigma(estimate.covariance);
    const accepted = work.accepted;

    const observations: TargetObservation[] =
      accepted === null || input.frame === null
        ? []
        : [
            {
              observationId: nextObservationId(),
              frameId: input.frame.frameId,
              time: input.frame.captureTime,
              centroid: { x: pixels(accepted.u), y: pixels(accepted.v) },
              boundingBox: blobBounds(accepted.blob),
              bearing: {
                frame: 'world-enu',
                azimuth: radians(accepted.azimuth),
                elevation: radians(accepted.elevation),
              },
              pixelCovariance: [
                [0.0625, 0],
                [0, 0.0625],
              ],
              peakIntensity: normalized(accepted.blob.peak / 255),
              snr: notModelled<Decibels>('dB'),
              confidence: normalized(accepted.score),
              method: 'intensity-centroid',
            },
          ];

    const estimates: readonly TargetEstimate[] =
      estimate === null ? [] : [this.buildEstimate(estimate, time)];

    let predictedImageX: number | null = null;
    let predictedImageY: number | null = null;
    let ellipse: UncertaintyEllipse | null = null;
    if (now !== null) {
      const projected = bearingToPixel(
        now.state[0]!,
        now.state[1]!,
        input.camera,
        measured.azimuth,
        measured.elevation,
      );
      if (projected !== null) {
        predictedImageX = projected.u;
        predictedImageY = projected.v;
        // Angular covariance mapped to the image by the small-angle Jacobian:
        // u moves fx·cos(el) per radian of azimuth, v moves −fy per radian of elevation.
        const fx = input.camera.intrinsics.focalLengthX as number;
        const fy = input.camera.intrinsics.focalLengthY as number;
        const ja = fx * Math.cos(now.state[1]!);
        const P = now.covariance;
        const e = eigen2([
          [ja * ja * P[0]![0]!, -ja * fy * P[0]![1]!],
          [-ja * fy * P[1]![0]!, fy * fy * P[1]![1]!],
        ]);
        ellipse = {
          centreX: projected.u,
          centreY: projected.v,
          semiMajorPx: ELLIPSE_SIGMAS * Math.sqrt(e.major),
          semiMinorPx: ELLIPSE_SIGMAS * Math.sqrt(e.minor),
          angle: e.angle,
          sigmas: ELLIPSE_SIGMAS,
        };
      }
    }

    const handoffDwell = work.handoff?.dwell ?? null;
    const debug: AstraLockDebug = {
      state: this.state,
      candidateCount: candidates?.length ?? 0,
      componentsFound: detection?.componentsFound ?? 0,
      centroidX: accepted?.u ?? null,
      centroidY: accepted?.v ?? null,
      boundingBox:
        accepted === null
          ? null
          : {
              x: accepted.blob.minX,
              y: accepted.blob.minY,
              width: accepted.blob.maxX - accepted.blob.minX + 1,
              height: accepted.blob.maxY - accepted.blob.minY + 1,
            },
      candidateScore: accepted?.score ?? null,
      measuredAzimuth: accepted?.azimuth ?? null,
      measuredElevation: accepted?.elevation ?? null,
      filteredAzimuth: estimate?.state[0] ?? null,
      filteredElevation: estimate?.state[1] ?? null,
      azimuthRate: estimate?.state[2] ?? null,
      elevationRate: estimate?.state[3] ?? null,
      predictedImageX,
      predictedImageY,
      panCorrection: feedback.azimuth,
      tiltCorrection: feedback.elevation,
      consecutiveMisses: this.misses,
      searchWaypointIndex: work.waypoint === null ? null : this.search.index,
      searchWaypointCount: this.search.waypoints.length,
      searchPan: work.waypoint?.azimuth ?? null,
      searchTilt: work.waypoint?.elevation ?? null,
      framesProcessed: this.framesProcessed,

      algorithm: 'astralock-x',
      trackQuality: this.state === 'search' ? null : (this.lastQuality?.quality ?? null),
      qualityComponents:
        this.state === 'search' || this.lastQuality === null
          ? null
          : {
              strength: this.lastQuality.strength,
              consistency: this.lastQuality.consistency,
              persistence: this.lastQuality.persistence,
              certainty: this.lastQuality.certainty,
            },
      acquisitionEvidence: this.state === 'acquire' ? this.evidence.evidence : null,
      acquisitionSupports: this.state === 'acquire' ? this.evidence.supports : null,
      innovationNis: work.association?.gate?.nis ?? null,
      gateAccepted: work.association === null ? null : work.association.accepted !== null,
      gateRejected: work.association?.rejected ?? 0,
      immCvProbability: estimate?.modelProbabilities[0] ?? null,
      immCaProbability: estimate?.modelProbabilities[1] ?? null,
      azimuthAcceleration: estimate?.state[4] ?? null,
      elevationAcceleration: estimate?.state[5] ?? null,
      angularSigma: sigma,
      predictionHorizon: horizon,
      predictedAzimuth: predictedAhead?.[0] ?? null,
      predictedElevation: predictedAhead?.[1] ?? null,
      feedforwardPan: feedforward?.azimuth ?? null,
      feedforwardTilt: feedforward?.elevation ?? null,
      recoveryAge: work.recoveryAge,
      localSearchRadius: work.localRadius,
      localSearchIndex: work.localIndex,
      handoffDwell,
      handoffConditionsMet: work.handoff?.conditionsMet ?? false,
      handoffRequiredDwell: this.config.handoff.dwell,
      uncertaintyEllipse: ellipse,
      priorSource: this.config.search.prior?.source ?? null,
    };

    return {
      observations,
      estimates,
      command: intent,
      pat: this.buildPatState(input, estimate),
      debug,
    };
  }

  private buildEstimate(
    estimate: ReturnType<ImmEstimator['estimate']>,
    time: number,
  ): TargetEstimate {
    const P = estimate.covariance;
    const covariance: Matrix4x4 = [
      [P[0]![0]!, P[0]![1]!, P[0]![2]!, P[0]![3]!],
      [P[1]![0]!, P[1]![1]!, P[1]![2]!, P[1]![3]!],
      [P[2]![0]!, P[2]![1]!, P[2]![2]!, P[2]![3]!],
      [P[3]![0]!, P[3]![1]!, P[3]![2]!, P[3]![3]!],
    ];
    return {
      trackId: TRACK_ID,
      time: seconds(time),
      bearing: {
        frame: 'world-enu',
        azimuth: radians(estimate.state[0]!),
        elevation: radians(estimate.state[1]!),
      },
      bearingRate: {
        frame: 'world-enu',
        azimuth: radiansPerSecond(estimate.state[2]!),
        elevation: radiansPerSecond(estimate.state[3]!),
      },
      covariance,
      status:
        this.state === 'track' || this.state === 'handoff'
          ? 'confirmed'
          : this.state === 'recover'
            ? 'coasting'
            : 'tentative',
      // Track quality, which is documented as non-probabilistic.
      confidence: normalized(this.lastQuality?.quality ?? 0),
      updateCount: this.framesProcessed,
      missedUpdates: this.misses,
      normalisedInnovationSquared: this.lastNis,
      range: null,
    };
  }

  private buildPatState(
    input: TrackingInput,
    estimate: ReturnType<ImmEstimator['estimate']> | null,
  ): PATState {
    const estimatedError =
      estimate === null
        ? null
        : Math.hypot(
            shortestAngle(estimate.state[0]!, input.gimbal.azimuth) * Math.cos(estimate.state[1]!),
            estimate.state[1]! - input.gimbal.elevation,
          );
    return {
      mode: MODE_FOR[this.state],
      since: seconds(this.stateSince),
      lastTransitionReason: this.lastReason,
      activeTrack:
        this.state === 'track' || this.state === 'handoff' || this.state === 'recover'
          ? TRACK_ID
          : null,
      estimatedPointingError: estimatedError === null ? null : radians(estimatedError),
      linkMargin: null,
      consecutiveMisses: this.misses,
      transitionCount: this.transitions,
    };
  }
}

function emptyWork(): FrameWork {
  return {
    association: null,
    accepted: null,
    intentTarget: null,
    waypoint: null,
    quality: null,
    handoff: null,
    recoveryAge: null,
    localRadius: null,
    localIndex: null,
  };
}

export const astraLockXPat = defineAlgorithm({
  manifest: {
    id: 'astralock-x',
    name: 'AstraLock-X Reference PAT',
    version: '1.0.0',
    description:
      'Robust reference PAT: validated acquisition, NCV/NCA interacting-multiple-model estimation, ' +
      'chi-square gated association, latency-aware feedback plus feed-forward pointing, ' +
      'predictive recovery with covariance-scaled local search, and coarse-to-fine handoff readiness. ' +
      'No beacon identity: a plausible decoy inside the gate can still capture it.',
    configSchema: astraLockConfigSchema,
    defaultConfig: DEFAULT_ASTRALOCK_CONFIG,
  },
  create: (init: AlgorithmInit<AstraLockConfig>): AlgorithmInstance<AstraLockDebug> =>
    new AstraLockInstance(init),
});
