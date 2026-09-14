/**
 * `baseline-kf-pid` — the first autonomous tracker.
 *
 * Pixels in, pointing intent out:
 *
 * ```
 *   GRAY8 frame ──▶ threshold + connected components ──▶ subpixel centroid
 *        ──▶ inverse pinhole with the MEASURED pose ──▶ bearing
 *        ──▶ constant-velocity Kalman filter ──▶ estimated bearing
 *        ──▶ PID against the measured pose ──▶ desired absolute setpoint
 * ```
 *
 * Three states, and no more: SEARCH, TRACK, LOST. There is no predictive local
 * recovery, no candidate confirmation beyond a frame count, no beacon identity,
 * no manoeuvre model. Those are the robust algorithm's job, and a baseline that
 * quietly acquired them would stop being a baseline.
 *
 * The algorithm never receives the simulator, the mount object, ground truth,
 * or the true optical pose. Its entire window on the world is `TrackingInput`,
 * which the contract proves ground-truth-free at compile time. It cannot stamp
 * a command time either: it returns an **intent** and the runtime decides when
 * that request entered the physical system (ADR-0013).
 *
 * See docs/BASELINE_PAT.md.
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
import type { PATState, PATTransitionReason } from '@/core/contracts/pat';
import type { ObservationId, TargetObservation } from '@/core/contracts/perception';
import type { Decibels } from '@/core/contracts/units';
import { notModelled } from '@/core/contracts/measurement';
import { normalized, pixels, radians, radiansPerSecond, seconds } from '@/core/contracts/units';

import { shortestAngle } from './angles';
import { blobBounds, detect, type DetectionResult } from './detector';
import { bearingToPixel, pixelToBearing } from './bearing';
import { BearingKalmanFilter } from './kalman';
import { PidController } from './pid';
import { SearchPattern, type SearchWaypoint } from './search';
import {
  baselinePatConfigSchema,
  DEFAULT_BASELINE_PAT_CONFIG,
  type BaselinePatConfig,
} from './config';

/** The baseline's own three states. Mapped onto the contract's `PATMode`. */
export type BaselineState = 'search' | 'track' | 'lost';

/**
 * Everything the UI may show about this algorithm.
 *
 * All of it derives from pixels, the believed calibration, the measured mount
 * state and the algorithm's own memory. There is no true bearing, no true
 * pointing error and no true projected centre: those exist only in evaluation,
 * and putting one here would turn the debug payload into the leak the whole
 * barrier is built to prevent.
 */
export interface BaselineDebug {
  readonly state: BaselineState;
  readonly candidateCount: number;
  readonly componentsFound: number;
  /** Selected centroid in continuous image coordinates, or `null`. */
  readonly centroidX: number | null;
  readonly centroidY: number | null;
  readonly boundingBox: { x: number; y: number; width: number; height: number } | null;
  readonly candidateScore: number | null;
  /** Bearing derived from this frame's detection, or `null`. */
  readonly measuredAzimuth: number | null;
  readonly measuredElevation: number | null;
  /** Filter output, or `null` before initialisation. */
  readonly filteredAzimuth: number | null;
  readonly filteredElevation: number | null;
  readonly azimuthRate: number | null;
  readonly elevationRate: number | null;
  /** Where the filter says the target should appear now, in pixels. */
  readonly predictedImageX: number | null;
  readonly predictedImageY: number | null;
  readonly panCorrection: number;
  readonly tiltCorrection: number;
  readonly consecutiveMisses: number;
  readonly searchWaypointIndex: number | null;
  readonly searchWaypointCount: number;
  readonly searchPan: number | null;
  readonly searchTilt: number | null;
  readonly framesProcessed: number;
}

let observationCounter = 0;
const nextObservationId = (): ObservationId => {
  observationCounter += 1;
  return `obs-${String(observationCounter)}` as ObservationId;
};

const BASELINE_TRACK_ID = 'baseline-0' as TrackId;

const MODE_FOR: Record<BaselineState, PATState['mode']> = {
  search: 'scan',
  track: 'track',
  lost: 'lost',
};

class BaselineInstance implements AlgorithmInstance<BaselineDebug> {
  private readonly config: BaselinePatConfig;
  private readonly filter: BearingKalmanFilter;
  private readonly panPid: PidController;
  private readonly tiltPid: PidController;
  private readonly search: SearchPattern;
  /** Write-only: work goes in, its result comes back, no duration ever does. */
  private readonly profiler: StageProfiler;

  private state: BaselineState = 'search';
  private stateSince = 0;
  private lastReason: PATTransitionReason = 'commanded';
  private transitions = 0;
  private misses = 0;
  private hits = 0;
  private framesProcessed = 0;
  private lastFrameId = -1;
  private lostSince = 0;

  constructor(init: AlgorithmInit<BaselinePatConfig>) {
    this.config = init.config;
    this.filter = new BearingKalmanFilter(init.config.kalman);
    this.panPid = new PidController(init.config.panPid);
    this.tiltPid = new PidController(init.config.tiltPid);
    this.search = new SearchPattern(init.config.search);
    this.profiler = init.profiler ?? UNPROFILED;
  }

  public reset(): void {
    this.filter.reset();
    this.panPid.reset();
    this.tiltPid.reset();
    this.search.reset();
    this.state = 'search';
    this.stateSince = 0;
    this.lastReason = 'commanded';
    this.transitions = 0;
    this.misses = 0;
    this.hits = 0;
    this.framesProcessed = 0;
    this.lastFrameId = -1;
    this.lostSince = 0;
  }

  private transition(to: BaselineState, reason: PATTransitionReason, time: number): void {
    if (this.state === to) return;
    this.state = to;
    this.stateSince = time;
    this.lastReason = reason;
    this.transitions += 1;
  }

  public update(input: TrackingInput): TrackingOutput<BaselineDebug> {
    const time = input.time;
    const frame = input.frame;

    // A frame is only new information once. The runtime may call on ticks with
    // no frame, and the same frame must not be counted twice as a detection or
    // a miss — that would make the miss counter a function of the tick rate
    // rather than of the sensor.
    const isNewFrame = frame !== null && frame.frameId !== this.lastFrameId;
    if (isNewFrame) {
      this.lastFrameId = frame.frameId;
      this.framesProcessed += 1;
    }

    const detection: DetectionResult | null = isNewFrame
      ? this.profiler.time('detector', () => detect(frame, this.config.detector))
      : null;

    const blob = detection?.selected ?? null;

    // Pixel -> bearing, using the pose the mount *reported* for this frame.
    let measured: { azimuth: number; elevation: number } | null = null;
    if (blob !== null && frame !== null) {
      measured = this.profiler.time('bearing-transform', () =>
        pixelToBearing(
          blob.centroidX + 0.5,
          blob.centroidY + 0.5,
          input.camera,
          frame.pose.azimuth,
          frame.pose.elevation,
        ),
      );
    }

    if (isNewFrame) {
      if (measured !== null) {
        this.hits += 1;
        this.misses = 0;
      } else {
        this.misses += 1;
        this.hits = 0;
      }
    }

    let intent: CommandIntent | null = null;
    let waypoint: SearchWaypoint | null = null;
    let panCorrection = 0;
    let tiltCorrection = 0;

    switch (this.state) {
      case 'search': {
        if (measured !== null && frame !== null && this.hits >= this.config.detectionsBeforeTrack) {
          const { azimuth, elevation } = measured;
          this.profiler.time('estimator', () => {
            this.filter.initialise(azimuth, elevation, frame.captureTime);
          });
          this.transition('track', 'candidate-detected', time);
          this.panPid.reset();
          this.tiltPid.reset();
          // Fall through to TRACK on the next call rather than commanding twice
          // in one update; the scan's last waypoint stands until then.
          waypoint = this.search.current;
          intent = {
            kind: 'position',
            azimuth: radians(waypoint.pan),
            elevation: radians(waypoint.tilt),
          };
          break;
        }
        waypoint = this.profiler.time('controller', () =>
          this.search.step(
            time,
            input.gimbal.azimuth,
            input.gimbal.elevation,
            input.gimbal.azimuthRate,
            input.gimbal.elevationRate,
          ),
        );
        intent = {
          kind: 'position',
          azimuth: radians(waypoint.pan),
          elevation: radians(waypoint.tilt),
        };
        break;
      }

      case 'track': {
        if (measured !== null && frame !== null) {
          const { azimuth, elevation } = measured;
          this.profiler.time('estimator', () => {
            this.filter.update(azimuth, elevation, frame.captureTime);
          });
        } else if (isNewFrame) {
          // Coast: propagate to now so the estimate stays usable through a gap.
          this.profiler.time('estimator', () => {
            this.filter.predictTo(time);
          });
        }

        if (this.misses >= this.config.missesBeforeLost) {
          this.transition('lost', 'track-lost', time);
          this.lostSince = time;
          intent = { kind: 'hold' };
          break;
        }

        const estimate = this.filter.estimate();
        const dt = isNewFrame ? this.frameInterval(input) : 0;

        // Error between where the filter says the target is and where the mount
        // says it is pointing. Both are algorithm-safe quantities.
        const panError = shortestAngle(estimate.azimuth, input.gimbal.azimuth);
        const tiltError = estimate.elevation - input.gimbal.elevation;

        if (isNewFrame) {
          [panCorrection, tiltCorrection] = this.profiler.time(
            'controller',
            (): [number, number] => [
              this.panPid.step(panError, dt).output,
              this.tiltPid.step(tiltError, dt).output,
            ],
          );

          intent = {
            kind: 'position',
            azimuth: radians(input.gimbal.azimuth + panCorrection),
            elevation: radians(input.gimbal.elevation + tiltCorrection),
          };
        }
        break;
      }

      case 'lost': {
        intent = { kind: 'hold' };
        if (time - this.lostSince >= this.config.lostHoldTime) {
          // Baseline recovery, in full: forget everything and scan again. No
          // predicted neighbourhood, no widened gate. Deliberately weak.
          this.filter.reset();
          this.panPid.reset();
          this.tiltPid.reset();
          this.search.reset();
          this.misses = 0;
          this.hits = 0;
          this.transition('search', 'track-lost', time);
        }
        break;
      }
    }

    const observations: TargetObservation[] =
      blob !== null && measured !== null && frame !== null
        ? [
            {
              observationId: nextObservationId(),
              frameId: frame.frameId,
              time: frame.captureTime,
              centroid: { x: pixels(blob.centroidX + 0.5), y: pixels(blob.centroidY + 0.5) },
              boundingBox: blobBounds(blob),
              bearing: {
                frame: 'world-enu',
                azimuth: radians(measured.azimuth),
                elevation: radians(measured.elevation),
              },
              // The centroid of a well-sampled point spread on a clean sensor is
              // good to a fraction of a pixel; a quarter-pixel standard
              // deviation is the measured figure from the detector tests, and
              // it is reported as a variance rather than a guess at confidence.
              pixelCovariance: [
                [0.0625, 0],
                [0, 0.0625],
              ],
              peakIntensity: normalized(blob.peak / 255),
              // The sensor has no noise model, so there is no ratio to
              // compute — not a small one, none. Reported as unmodelled rather
              // than as a number a reader would take at face value.
              snr: notModelled<Decibels>('dB'),
              confidence: normalized(detection?.score ?? 0),
              method: 'intensity-centroid',
            },
          ]
        : [];

    const estimates: readonly TargetEstimate[] = this.filter.isInitialised
      ? [this.buildEstimate(time)]
      : [];

    return {
      observations,
      estimates,
      command: intent,
      pat: this.buildPatState(input),
      debug: this.buildDebug(
        detection,
        blob,
        measured,
        waypoint,
        panCorrection,
        tiltCorrection,
        input,
      ),
    };
  }

  /**
   * Interval between the current frame and the filter's previous update.
   *
   * Taken from timestamps rather than assumed to be `1 / frameRate`: frames can
   * be dropped, the configured rate can be anything, and a controller that
   * assumed a cadence would compute the wrong derivative the moment one was
   * missed.
   */
  private frameInterval(input: TrackingInput): number {
    const filterTime = this.filter.time;
    const captureTime = input.frame?.captureTime ?? input.time;
    if (filterTime === null) return 0;
    const dt = captureTime - filterTime;
    return dt > 0 ? dt : 1 / Math.max(1, input.camera.frameRate);
  }

  private buildEstimate(time: number): TargetEstimate {
    const e = this.filter.estimate();
    const c = e.covariance;
    const covariance: Matrix4x4 = [
      [c[0]![0]!, c[0]![1]!, c[0]![2]!, c[0]![3]!],
      [c[1]![0]!, c[1]![1]!, c[1]![2]!, c[1]![3]!],
      [c[2]![0]!, c[2]![1]!, c[2]![2]!, c[2]![3]!],
      [c[3]![0]!, c[3]![1]!, c[3]![2]!, c[3]![3]!],
    ];

    return {
      trackId: BASELINE_TRACK_ID,
      time: seconds(time),
      bearing: { frame: 'world-enu', azimuth: radians(e.azimuth), elevation: radians(e.elevation) },
      bearingRate: {
        frame: 'world-enu',
        azimuth: radiansPerSecond(e.azimuthRate),
        elevation: radiansPerSecond(e.elevationRate),
      },
      covariance,
      status: this.state === 'track' ? 'confirmed' : this.misses > 0 ? 'coasting' : 'tentative',
      // Reported as the inverse of the angular uncertainty relative to the
      // initial variance: a real, computed number rather than a fabricated
      // score. It is not a probability and is not described as one.
      confidence: normalized(
        Math.max(0, Math.min(1, 1 - c[0]![0]! / this.config.kalman.initialAngleVariance)),
      ),
      updateCount: e.updateCount,
      missedUpdates: this.misses,
      normalisedInnovationSquared: e.normalisedInnovationSquared,
      range: null,
    };
  }

  private buildPatState(input: TrackingInput): PATState {
    // The tracker's own view of how far off boresight the target is: its
    // filtered bearing against the pose the encoders report. Emphatically not
    // the true pointing error — an over-confident filter reports a small number
    // here while missing badly, and noticing that gap is one of the things
    // evaluation exists to do.
    let estimatedError: number | null = null;
    if (this.filter.isInitialised) {
      const e = this.filter.estimate();
      estimatedError = Math.hypot(
        shortestAngle(e.azimuth, input.gimbal.azimuth),
        e.elevation - input.gimbal.elevation,
      );
    }

    return {
      mode: MODE_FOR[this.state],
      since: seconds(this.stateSince),
      lastTransitionReason: this.lastReason,
      activeTrack: this.state === 'track' ? BASELINE_TRACK_ID : null,
      estimatedPointingError: estimatedError === null ? null : radians(estimatedError),
      // No link budget is modelled, so there is no margin to report.
      linkMargin: null,
      consecutiveMisses: this.misses,
      transitionCount: this.transitions,
    };
  }

  private buildDebug(
    detection: DetectionResult | null,
    blob: ReturnType<typeof detect>['selected'],
    measured: { azimuth: number; elevation: number } | null,
    waypoint: SearchWaypoint | null,
    panCorrection: number,
    tiltCorrection: number,
    input: TrackingInput,
  ): BaselineDebug {
    const estimate = this.filter.isInitialised ? this.filter.estimate() : null;
    let predictedImageX: number | null = null;
    let predictedImageY: number | null = null;

    if (estimate !== null) {
      const predicted = this.filter.predictedAt(input.time);
      const projected = bearingToPixel(
        predicted.azimuth,
        predicted.elevation,
        input.camera,
        input.gimbal.azimuth,
        input.gimbal.elevation,
      );
      predictedImageX = projected?.u ?? null;
      predictedImageY = projected?.v ?? null;
    }

    return {
      state: this.state,
      candidateCount: detection?.candidates.length ?? 0,
      componentsFound: detection?.componentsFound ?? 0,
      centroidX: blob === null ? null : blob.centroidX + 0.5,
      centroidY: blob === null ? null : blob.centroidY + 0.5,
      boundingBox:
        blob === null
          ? null
          : {
              x: blob.minX,
              y: blob.minY,
              width: blob.maxX - blob.minX + 1,
              height: blob.maxY - blob.minY + 1,
            },
      candidateScore: detection?.score ?? null,
      measuredAzimuth: measured?.azimuth ?? null,
      measuredElevation: measured?.elevation ?? null,
      filteredAzimuth: estimate?.azimuth ?? null,
      filteredElevation: estimate?.elevation ?? null,
      azimuthRate: estimate?.azimuthRate ?? null,
      elevationRate: estimate?.elevationRate ?? null,
      predictedImageX,
      predictedImageY,
      panCorrection,
      tiltCorrection,
      consecutiveMisses: this.misses,
      searchWaypointIndex: waypoint?.index ?? null,
      searchWaypointCount: this.search.all.length,
      searchPan: waypoint?.pan ?? null,
      searchTilt: waypoint?.tilt ?? null,
      framesProcessed: this.framesProcessed,
    };
  }
}

export const baselineKfPidPat = defineAlgorithm({
  manifest: {
    id: 'baseline-kf-pid',
    name: 'Baseline KF + PID',
    version: '1.0.0',
    description:
      'Threshold and connected-component beacon detection, inverse pinhole to bearing, ' +
      'constant-velocity Kalman filter, PID outer pointing loop, raster search. ' +
      'The reference baseline: deliberately simple, with no beacon identity and no predictive recovery.',
    configSchema: baselinePatConfigSchema,
    defaultConfig: DEFAULT_BASELINE_PAT_CONFIG,
  },
  create: (init: AlgorithmInit<BaselinePatConfig>): AlgorithmInstance<BaselineDebug> =>
    new BaselineInstance(init),
});
