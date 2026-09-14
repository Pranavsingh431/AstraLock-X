/**
 * Constant-velocity Kalman filter over target bearing.
 *
 * State, in world ENU angles:
 *
 * ```
 *   x = [ azimuth, elevation, azimuthRate, elevationRate ]ᵀ
 * ```
 *
 * Measurement: the two angles derived from a detection.
 *
 * ```
 *   z = [ azimuth, elevation ]ᵀ        H = [ I₂  0₂ ]
 * ```
 *
 * The two axes are modelled as independent. That is an approximation — the
 * angular rates of a target crossing at constant linear velocity are coupled
 * through the geometry — but a constant-velocity model in angle space is
 * already an approximation of that motion, and pretending to a cross-axis
 * correlation the model cannot actually predict would be false precision. The
 * consequence is a filter that lags slightly through the fastest part of a
 * crossing pass, which shows up honestly in the Phase 4 results.
 *
 * Nothing here ever sees a target position. The only input is a bearing
 * computed from pixels and the measured mount angle.
 *
 * See docs/BASELINE_PAT.md.
 */

import { shortestAngle, wrapAngle } from './angles';

/** Tuning for the filter. */
export interface KalmanConfig {
  /**
   * Continuous white-noise acceleration spectral density, in rad²/s³.
   *
   * The single knob that says how much the target is allowed to deviate from
   * constant angular velocity. Larger values track manoeuvres better and are
   * noisier on a steady target.
   */
  readonly processNoiseSpectralDensity: number;
  /**
   * Measurement noise standard deviation, in radians, per axis.
   *
   * Set from what the measurement chain actually contributes: centroid error
   * over the focal length, plus the encoder quantisation that enters through
   * the measured pose.
   */
  readonly measurementNoiseStdDev: number;
  /** Initial variance on the angles, rad². */
  readonly initialAngleVariance: number;
  /** Initial variance on the rates, (rad/s)². Rate is unobserved at t=0. */
  readonly initialRateVariance: number;
  /**
   * Largest propagation step, in seconds.
   *
   * A gap longer than this is propagated in several sub-steps. The transition
   * is exact for any dt, but the process-noise accumulation is not: `Q(dt)`
   * grows as `dt³`–`dt⁴` and a single huge step would inflate the covariance
   * far more than the same interval taken in pieces.
   */
  readonly maxPredictStep: number;
}

/** A 4-vector state. */
export type KalmanState = readonly [number, number, number, number];
/** Row-major 4x4. */
export type Matrix4 = number[][];

const IDENTITY_4 = (): Matrix4 => [
  [1, 0, 0, 0],
  [0, 1, 0, 0],
  [0, 0, 1, 0],
  [0, 0, 0, 1],
];

function multiply(a: Matrix4, b: Matrix4): Matrix4 {
  const out: Matrix4 = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (let i = 0; i < 4; i += 1) {
    for (let k = 0; k < 4; k += 1) {
      const aik = a[i]![k]!;
      if (aik === 0) continue;
      for (let j = 0; j < 4; j += 1) out[i]![j]! += aik * b[k]![j]!;
    }
  }
  return out;
}

function transpose(m: Matrix4): Matrix4 {
  const out: Matrix4 = [
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
    [0, 0, 0, 0],
  ];
  for (let i = 0; i < 4; i += 1) for (let j = 0; j < 4; j += 1) out[i]![j] = m[j]![i]!;
  return out;
}

/**
 * Forces exact symmetry.
 *
 * A covariance is symmetric by definition, but the arithmetic that produces it
 * is not exactly symmetric in floating point, and the asymmetry compounds over
 * thousands of updates until the matrix is no longer positive semi-definite and
 * the gain goes wrong. Averaging with the transpose after every update costs
 * sixteen operations and removes the failure mode entirely.
 */
function symmetrise(m: Matrix4): Matrix4 {
  for (let i = 0; i < 4; i += 1) {
    for (let j = i + 1; j < 4; j += 1) {
      const mean = (m[i]![j]! + m[j]![i]!) / 2;
      m[i]![j] = mean;
      m[j]![i] = mean;
    }
  }
  return m;
}

/**
 * Constant-velocity transition over `dt`.
 *
 * ```
 *   F = [ 1 0 dt 0 ]
 *       [ 0 1 0 dt ]
 *       [ 0 0 1  0 ]
 *       [ 0 0 0  1 ]
 * ```
 */
export function transitionMatrix(dt: number): Matrix4 {
  return [
    [1, 0, dt, 0],
    [0, 1, 0, dt],
    [0, 0, 1, 0],
    [0, 0, 0, 1],
  ];
}

/**
 * Process noise for continuous white-noise acceleration.
 *
 * Per axis, with spectral density `q`:
 *
 * ```
 *   Q_axis = q · [ dt⁴/4  dt³/2 ]
 *                [ dt³/2  dt²   ]
 *
 * ```
 *
 * which is the exact integral `∫₀^dt F(τ)·G·q·Gᵀ·F(τ)ᵀ dτ` for a model whose
 * acceleration is white noise, not an approximation of it. The two axes are
 * independent, so the 4x4 is the two 2x2 blocks placed at the (angle, rate)
 * index pairs — which for this state ordering means the corners rather than a
 * contiguous block.
 */
export function processNoiseMatrix(dt: number, spectralDensity: number): Matrix4 {
  const dt2 = dt * dt;
  const dt3 = dt2 * dt;
  const dt4 = dt2 * dt2;
  const q = spectralDensity;

  const pp = (q * dt4) / 4;
  const pv = (q * dt3) / 2;
  const vv = q * dt2;

  return [
    [pp, 0, pv, 0],
    [0, pp, 0, pv],
    [pv, 0, vv, 0],
    [0, pv, 0, vv],
  ];
}

/** What the filter believes right now. */
export interface KalmanEstimate {
  readonly azimuth: number;
  readonly elevation: number;
  readonly azimuthRate: number;
  readonly elevationRate: number;
  readonly covariance: Matrix4;
  /** Measurement updates applied since initialisation. */
  readonly updateCount: number;
  /** Normalised innovation squared from the last update, or `null`. */
  readonly normalisedInnovationSquared: number | null;
}

export class BearingKalmanFilter {
  private state: number[] = [0, 0, 0, 0];
  private covariance: Matrix4 = IDENTITY_4();
  private initialised = false;
  private updates = 0;
  private lastTime: number | null = null;
  private lastNis: number | null = null;

  constructor(private readonly config: KalmanConfig) {}

  public get isInitialised(): boolean {
    return this.initialised;
  }

  public get updateCount(): number {
    return this.updates;
  }

  /** Time of the most recent predict or update, or `null` before the first. */
  public get time(): number | null {
    return this.lastTime;
  }

  /**
   * Starts the filter from one measurement.
   *
   * Rate is initialised to zero with a large variance rather than being guessed
   * from a difference of the first two measurements: a difference of two noisy
   * angles over one frame interval is a very poor rate estimate, and seeding
   * the filter with it produces a violent first correction. Zero with an honest
   * covariance lets the next few updates find the rate properly.
   */
  public initialise(azimuth: number, elevation: number, time: number): void {
    this.state = [wrapAngle(azimuth), elevation, 0, 0];
    const a = this.config.initialAngleVariance;
    const r = this.config.initialRateVariance;
    this.covariance = [
      [a, 0, 0, 0],
      [0, a, 0, 0],
      [0, 0, r, 0],
      [0, 0, 0, r],
    ];
    this.initialised = true;
    this.updates = 1;
    this.lastTime = time;
    this.lastNis = null;
  }

  public reset(): void {
    this.state = [0, 0, 0, 0];
    this.covariance = IDENTITY_4();
    this.initialised = false;
    this.updates = 0;
    this.lastTime = null;
    this.lastNis = null;
  }

  /**
   * Propagates the state to `time` with no measurement.
   *
   * Used between frames and while coasting through a miss. Long gaps are
   * sub-stepped so the accumulated process noise matches the interval rather
   * than the single huge step.
   *
   * @throws {RangeError} if asked to run backwards.
   */
  public predictTo(time: number): void {
    if (!this.initialised) return;
    if (!Number.isFinite(time)) {
      throw new RangeError(`Filter time must be finite, received ${String(time)}`);
    }
    const from = this.lastTime ?? time;
    if (time < from) {
      throw new RangeError(
        `Filter cannot run backwards: at ${String(from)} s, asked for ${String(time)} s`,
      );
    }

    let remaining = time - from;
    const step = this.config.maxPredictStep;
    while (remaining > 0) {
      const dt = Math.min(remaining, step);
      this.predictStep(dt);
      remaining -= dt;
    }
    this.lastTime = time;
  }

  private predictStep(dt: number): void {
    if (dt <= 0) return;
    const f = transitionMatrix(dt);
    const q = processNoiseMatrix(dt, this.config.processNoiseSpectralDensity);

    const next: number[] = [
      this.state[0]! + this.state[2]! * dt,
      this.state[1]! + this.state[3]! * dt,
      this.state[2]!,
      this.state[3]!,
    ];
    // Keep azimuth on the principal branch so it cannot drift to ±1000 rad over
    // a long run and lose precision in the low bits.
    next[0] = wrapAngle(next[0]!);
    this.state = next;

    const fp = multiply(f, this.covariance);
    const fpft = multiply(fp, transpose(f));
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) fpft[i]![j]! += q[i]![j]!;
    }
    this.covariance = symmetrise(fpft);
  }

  /**
   * Applies one bearing measurement at `time`.
   *
   * Predicts to the measurement time first, then corrects. The innovation in
   * azimuth is taken as a shortest angular difference, so a measurement at
   * +179° against a state at −179° is a 2° innovation rather than a 358° one.
   *
   * The covariance update uses the **Joseph form**
   *
   * ```
   *   P⁺ = (I − K·H)·P⁻·(I − K·H)ᵀ + K·R·Kᵀ
   * ```
   *
   * rather than the shorter `(I − K·H)·P⁻`. Joseph costs two extra 4x4
   * multiplications and stays positive semi-definite under rounding and under a
   * gain that is not exactly optimal; the short form can drift to an indefinite
   * covariance over a long run, and a filter whose covariance has gone
   * indefinite produces confident nonsense rather than an obvious failure.
   */
  public update(azimuth: number, elevation: number, time: number): void {
    if (!this.initialised) {
      this.initialise(azimuth, elevation, time);
      return;
    }

    this.predictTo(time);

    const r = this.config.measurementNoiseStdDev * this.config.measurementNoiseStdDev;

    // Innovation. Azimuth on the shortest arc; elevation directly, because it
    // is bounded rather than periodic.
    const innovation = [shortestAngle(azimuth, this.state[0]!), elevation - this.state[1]!];

    // S = H·P·Hᵀ + R, with H = [I 0], so S is the top-left 2x2 of P plus R.
    const s00 = this.covariance[0]![0]! + r;
    const s01 = this.covariance[0]![1]!;
    const s10 = this.covariance[1]![0]!;
    const s11 = this.covariance[1]![1]! + r;

    const det = s00 * s11 - s01 * s10;
    if (!Number.isFinite(det) || Math.abs(det) < Number.MIN_VALUE) {
      // Singular innovation covariance: skip the correction rather than divide
      // by it. Leaves the prediction standing, which is the safe outcome.
      return;
    }

    const inv00 = s11 / det;
    const inv01 = -s01 / det;
    const inv10 = -s10 / det;
    const inv11 = s00 / det;

    // K = P·Hᵀ·S⁻¹, and P·Hᵀ is the first two columns of P.
    const k: number[][] = [];
    for (let i = 0; i < 4; i += 1) {
      const p0 = this.covariance[i]![0]!;
      const p1 = this.covariance[i]![1]!;
      k.push([p0 * inv00 + p1 * inv10, p0 * inv01 + p1 * inv11]);
    }

    this.state = [
      wrapAngle(this.state[0]! + k[0]![0]! * innovation[0]! + k[0]![1]! * innovation[1]!),
      this.state[1]! + k[1]![0]! * innovation[0]! + k[1]![1]! * innovation[1]!,
      this.state[2]! + k[2]![0]! * innovation[0]! + k[2]![1]! * innovation[1]!,
      this.state[3]! + k[3]![0]! * innovation[0]! + k[3]![1]! * innovation[1]!,
    ];

    // I − K·H, with H = [I 0]: subtract K from the first two columns of I.
    const ikh = IDENTITY_4();
    for (let i = 0; i < 4; i += 1) {
      ikh[i]![0]! -= k[i]![0]!;
      ikh[i]![1]! -= k[i]![1]!;
    }

    const left = multiply(multiply(ikh, this.covariance), transpose(ikh));
    // K·R·Kᵀ, with R = r·I₂.
    for (let i = 0; i < 4; i += 1) {
      for (let j = 0; j < 4; j += 1) {
        left[i]![j]! += r * (k[i]![0]! * k[j]![0]! + k[i]![1]! * k[j]![1]!);
      }
    }
    this.covariance = symmetrise(left);

    this.lastNis =
      innovation[0]! * (inv00 * innovation[0]! + inv01 * innovation[1]!) +
      innovation[1]! * (inv10 * innovation[0]! + inv11 * innovation[1]!);
    this.updates += 1;
    this.lastTime = time;
  }

  public estimate(): KalmanEstimate {
    return {
      azimuth: this.state[0]!,
      elevation: this.state[1]!,
      azimuthRate: this.state[2]!,
      elevationRate: this.state[3]!,
      covariance: this.covariance.map((row) => [...row]),
      updateCount: this.updates,
      normalisedInnovationSquared: this.lastNis,
    };
  }

  /**
   * Predicted bearing at `time` without disturbing the filter.
   *
   * For the overlay and for pointing ahead of the current estimate. Read-only:
   * it does not advance the state, so calling it has no effect on the track.
   */
  public predictedAt(time: number): { azimuth: number; elevation: number } {
    const dt = this.lastTime === null ? 0 : time - this.lastTime;
    return {
      azimuth: wrapAngle(this.state[0]! + this.state[2]! * dt),
      elevation: this.state[1]! + this.state[3]! * dt,
    };
  }
}
