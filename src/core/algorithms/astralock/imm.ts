/**
 * Interacting Multiple Model estimator for a target bearing.
 *
 * **State.** One common state for both models, world ENU:
 *
 * ```
 *   x = [ az, el, ȧz, ėl, äz, ël ]      rad, rad, rad/s, rad/s, rad/s², rad/s²
 * ```
 *
 * **Models.** Each acts on that same state, per axis, with transition F and
 * process noise Q over an interval dt:
 *
 * - **NCV — nearly constant velocity.** Position integrates rate; rate is a
 *   random walk driven by white acceleration of spectral density q_a; the
 *   acceleration component is not propagated (its row of F is zero) and is held
 *   near zero by a small residual variance σ_r². This is the standard way to
 *   give a velocity model the six-element state an IMM needs to mix with an
 *   acceleration model, and it is still a velocity model: it predicts no
 *   acceleration.
 *
 *   ```
 *   F = [1 dt 0; 0 1 0; 0 0 0]
 *   Q = q_a·[dt³/3 dt²/2 0; dt²/2 dt 0; 0 0 0] + diag(0, 0, σ_r²)
 *   ```
 *
 * - **NCA — nearly constant acceleration (Wiener-process acceleration).**
 *   Acceleration is a random walk driven by white jerk of spectral density q_j.
 *
 *   ```
 *   F = [1 dt dt²/2; 0 1 dt; 0 0 1]
 *   Q = q_j·[dt⁵/20 dt⁴/8 dt³/6; dt⁴/8 dt³/3 dt²/2; dt³/6 dt²/2 dt]
 *   ```
 *
 * **Measurement.** z = [az, el] from a detection, H picks the first two states,
 * R = σ_m²·I. The azimuth innovation uses the shortest angle.
 *
 * **One IMM cycle** (Blom & Bar-Shalom), from posterior k−1 to posterior k:
 *
 * 1. predicted model probabilities  c̄_j = Σ_i p_ij μ_i
 * 2. mixing probabilities           μ_i|j = p_ij μ_i / c̄_j
 * 3. mixed initial conditions       x0_j = Σ_i μ_i|j x_i,
 *                                   P0_j = Σ_i μ_i|j [P_i + (x_i − x0_j)(x_i − x0_j)ᵀ]
 * 4. model prediction               x_j⁻ = F_j x0_j,  P_j⁻ = F_j P0_j F_jᵀ + Q_j
 * 5. model update                   Joseph form, innovation ν_j, covariance S_j
 * 6. likelihood                     ln Λ_j = −½ (ν_jᵀ S_j⁻¹ ν_j + ln det(2π S_j))
 * 7. model probabilities            μ_j ∝ c̄_j Λ_j, normalised in the log domain
 * 8. fusion                         x = Σ_j μ_j x_j,
 *                                   P = Σ_j μ_j [P_j + (x_j − x)(x_j − x)ᵀ]
 *
 * With no measurement, steps 5–7 are skipped and μ_j = c̄_j.
 *
 * **Transition matrix.** Specified per reference interval and converted to the
 * actual interval through each model's continuous-time switching rate, so the
 * chain means the same thing under irregular frame spacing:
 *
 * ```
 *   λ_i = −ln(p_ii,ref) / dt_ref        p_ii(dt) = exp(−λ_i dt)
 * ```
 *
 * Every difference of azimuths — innovation, mixing spread, fusion spread — is
 * taken with the shortest angle, and azimuth is kept wrapped, so nothing is
 * averaged naively across ±π.
 *
 * See docs/ASTRALOCK_PAT.md and ADR-0017.
 */

import { shortestAngle, wrapAngle } from '../baseline/angles';
import type { Matrix } from './matrix';
import {
  add,
  apply,
  clone,
  identity,
  invert2,
  isFiniteMatrix,
  largestEigenvalue2,
  multiply,
  outer,
  scale,
  subtract,
  symmetrize,
  transpose,
  zeros,
} from './matrix';

export const STATE_SIZE = 6;
export const MODEL_NAMES = ['ncv', 'nca'] as const;
export type ModelName = (typeof MODEL_NAMES)[number];

/** Indices of each axis's (position, rate, acceleration) in the state. */
const AXES: readonly (readonly [number, number, number])[] = [
  [0, 2, 4],
  [1, 3, 5],
];

export interface ImmConfig {
  /** Standard deviation of one bearing measurement, per axis, radians. */
  readonly measurementNoiseStdDev: number;
  /** NCV white-acceleration spectral density q_a, rad²/s³. */
  readonly ncvAccelerationSpectralDensity: number;
  /** NCV residual acceleration standard deviation σ_r, rad/s². */
  /**
   * Variance held on the acceleration element of the NCV model's state, rad/s².
   *
   * Numerical, not dynamical. The shared six-element state gives both models an
   * acceleration element, but NCV's transition matrix zeroes it — that is what
   * "nearly constant velocity" means — and its position and rate rows carry no
   * acceleration term. So this value cannot influence what NCV predicts. It
   * exists to keep that block of the covariance non-singular, which matters
   * because the mixing step inverts across models.
   *
   * It was originally named for a residual acceleration it does not model. The
   * sweep that caught this is in the Phase 6 notes.
   */
  readonly ncvAccelerationStateVariance: number;
  /** NCA white-jerk spectral density q_j, rad²/s⁵. */
  readonly ncaJerkSpectralDensity: number;
  /** Probability of remaining in NCV over one reference interval. */
  readonly stayNcv: number;
  /** Probability of remaining in NCA over one reference interval. */
  readonly stayNca: number;
  /** The interval the stay probabilities are specified for, seconds. */
  readonly transitionReferenceInterval: number;
  /** [NCV, NCA] probabilities at initialisation. */
  readonly initialNcvProbability: number;
  readonly initialAngleVariance: number;
  readonly initialRateVariance: number;
  readonly initialAccelerationVariance: number;
  /** Largest prediction sub-step, seconds. Long gaps are split. */
  readonly maxPredictStep: number;
}

interface ModelState {
  x: number[];
  P: Matrix;
}

/** A prediction to some time, not yet committed. */
export interface ImmPrediction {
  readonly time: number;
  readonly models: readonly ModelState[];
  /** c̄: model probabilities propagated through the chain, before any measurement. */
  readonly priorProbabilities: readonly number[];
  readonly state: readonly number[];
  readonly covariance: Matrix;
}

/** The statistical distance of a candidate measurement from a prediction. */
export interface GateResult {
  /** [az, el] innovation, radians; azimuth by shortest angle. */
  readonly innovation: readonly [number, number];
  readonly innovationCovariance: Matrix;
  /** Normalised innovation squared, dᵀS⁻¹d. Chi-square with 2 dof if consistent. */
  readonly nis: number;
}

export interface ImmUpdate {
  readonly nis: number;
  readonly logLikelihoods: readonly number[];
  readonly modelProbabilities: readonly number[];
}

export interface ImmEstimate {
  readonly time: number;
  readonly state: readonly number[];
  readonly covariance: Matrix;
  /** [NCV, NCA]. */
  readonly modelProbabilities: readonly number[];
}

/** Per-axis 3×3 blocks placed into the 6×6 state. */
function assemble(block: (axis: 0 | 1) => Matrix): Matrix {
  const out = zeros(STATE_SIZE, STATE_SIZE);
  for (const axis of [0, 1] as const) {
    const b = block(axis);
    const idx = AXES[axis]!;
    for (let r = 0; r < 3; r += 1) {
      for (let c = 0; c < 3; c += 1) out[idx[r]!]![idx[c]!] = b[r]![c]!;
    }
  }
  return out;
}

export function transition(model: ModelName, dt: number): Matrix {
  return model === 'ncv'
    ? assemble(() => [
        [1, dt, 0],
        [0, 1, 0],
        [0, 0, 0],
      ])
    : assemble(() => [
        [1, dt, 0.5 * dt * dt],
        [0, 1, dt],
        [0, 0, 1],
      ]);
}

export function processNoise(model: ModelName, dt: number, config: ImmConfig): Matrix {
  if (model === 'ncv') {
    const q = config.ncvAccelerationSpectralDensity;
    // Keeps the unused acceleration block non-singular; see the field comment.
    const r = config.ncvAccelerationStateVariance;
    return assemble(() => [
      [(q * dt ** 3) / 3, (q * dt ** 2) / 2, 0],
      [(q * dt ** 2) / 2, q * dt, 0],
      [0, 0, r],
    ]);
  }
  const q = config.ncaJerkSpectralDensity;
  return assemble(() => [
    [(q * dt ** 5) / 20, (q * dt ** 4) / 8, (q * dt ** 3) / 6],
    [(q * dt ** 4) / 8, (q * dt ** 3) / 3, (q * dt ** 2) / 2],
    [(q * dt ** 3) / 6, (q * dt ** 2) / 2, q * dt],
  ]);
}

/**
 * The model transition matrix over an interval: p_ij = P(model j now | model i before).
 */
export function transitionProbabilities(config: ImmConfig, dt: number): Matrix {
  const rate = (stay: number): number => -Math.log(stay) / config.transitionReferenceInterval;
  const stayNcv = Math.exp(-rate(config.stayNcv) * dt);
  const stayNca = Math.exp(-rate(config.stayNca) * dt);
  return [
    [stayNcv, 1 - stayNcv],
    [1 - stayNca, stayNca],
  ];
}

const H: Matrix = [
  [1, 0, 0, 0, 0, 0],
  [0, 1, 0, 0, 0, 0],
];
const HT = transpose(H);

/** x_a − x_b with the azimuth component wrapped. */
function stateDifference(a: readonly number[], b: readonly number[]): number[] {
  const d = a.map((value, i) => value - b[i]!);
  d[0] = shortestAngle(a[0]!, b[0]!);
  return d;
}

/** Probability-weighted mean of states, azimuth averaged about a reference. */
function weightedMean(
  states: readonly (readonly number[])[],
  weights: readonly number[],
  reference: number,
): number[] {
  const mean = new Array<number>(STATE_SIZE).fill(0);
  let azimuthOffset = 0;
  states.forEach((x, k) => {
    const w = weights[k]!;
    for (let i = 1; i < STATE_SIZE; i += 1) mean[i]! += w * x[i]!;
    azimuthOffset += w * shortestAngle(x[0]!, reference);
  });
  mean[0] = wrapAngle(reference + azimuthOffset);
  return mean;
}

/** Σ_k w_k [P_k + (x_k − m)(x_k − m)ᵀ]. */
function spreadCovariance(
  models: readonly ModelState[],
  weights: readonly number[],
  mean: readonly number[],
): Matrix {
  let P = zeros(STATE_SIZE, STATE_SIZE);
  models.forEach((model, k) => {
    const d = stateDifference(model.x, mean);
    P = add(P, scale(add(model.P, outer(d, d)), weights[k]!));
  });
  return symmetrize(P);
}

/** Log-sum-exp normalisation of log weights into probabilities. */
function normaliseLog(logWeights: readonly number[]): number[] {
  const max = Math.max(...logWeights);
  const sum = logWeights.reduce((total, lw) => total + Math.exp(lw - max), 0);
  const logTotal = max + Math.log(sum);
  // A tiny floor keeps a model recoverable after a long stretch of evidence
  // against it; the Markov chain would restore it anyway, but an exact zero
  // would make the mixing weights 0/0 on the next cycle.
  const floored = logWeights.map((lw) => Math.max(Math.exp(lw - logTotal), 1e-12));
  const total = floored.reduce((a, b) => a + b, 0);
  return floored.map((p) => p / total);
}

export class ImmEstimator {
  private models: ModelState[] = [];
  private probabilities: number[] = [];
  private currentTime: number | null = null;

  constructor(private readonly config: ImmConfig) {}

  public get isInitialised(): boolean {
    return this.currentTime !== null;
  }

  public get time(): number | null {
    return this.currentTime;
  }

  public reset(): void {
    this.models = [];
    this.probabilities = [];
    this.currentTime = null;
  }

  /** Starts a track from one bearing measurement, at rest with broad rate uncertainty. */
  public initialise(azimuth: number, elevation: number, time: number): void {
    const c = this.config;
    const x = [wrapAngle(azimuth), elevation, 0, 0, 0, 0];
    const P = zeros(STATE_SIZE, STATE_SIZE);
    P[0]![0] = c.initialAngleVariance;
    P[1]![1] = c.initialAngleVariance;
    P[2]![2] = c.initialRateVariance;
    P[3]![3] = c.initialRateVariance;
    P[4]![4] = c.initialAccelerationVariance;
    P[5]![5] = c.initialAccelerationVariance;
    this.models = [
      { x: x.slice(), P: clone(P) },
      { x: x.slice(), P: clone(P) },
    ];
    this.probabilities = [c.initialNcvProbability, 1 - c.initialNcvProbability];
    this.currentTime = time;
  }

  /**
   * Predicts to `time` without committing: mixing and model prediction, split
   * into sub-steps no longer than `maxPredictStep`.
   */
  public predict(time: number): ImmPrediction {
    if (this.currentTime === null) throw new Error('IMM used before initialisation');
    let models = this.models.map((m) => ({ x: m.x.slice(), P: clone(m.P) }));
    let probabilities = this.probabilities.slice();
    let remaining = Math.max(0, time - this.currentTime);

    // Always run at least one (possibly zero-length) cycle so the prediction
    // carries mixed states and propagated probabilities.
    do {
      const dt = Math.min(remaining, this.config.maxPredictStep);
      const cycle = this.mixAndPredict(models, probabilities, dt);
      models = cycle.models;
      probabilities = cycle.prior;
      remaining -= dt;
    } while (remaining > 1e-12);

    const state = weightedMean(
      models.map((m) => m.x),
      probabilities,
      models[probabilities[0]! >= probabilities[1]! ? 0 : 1]!.x[0]!,
    );
    return {
      time,
      models,
      priorProbabilities: probabilities,
      state,
      covariance: spreadCovariance(models, probabilities, state),
    };
  }

  /** Gates a candidate bearing against a prediction, using the fused prediction. */
  public gate(prediction: ImmPrediction, azimuth: number, elevation: number): GateResult | null {
    const innovation: [number, number] = [
      shortestAngle(azimuth, prediction.state[0]!),
      elevation - prediction.state[1]!,
    ];
    const S = this.innovationCovariance(prediction.covariance);
    const inverse = invert2(S);
    if (inverse === null) return null;
    const Si = inverse.inverse;
    const nis =
      innovation[0] * (Si[0]![0]! * innovation[0] + Si[0]![1]! * innovation[1]) +
      innovation[1] * (Si[1]![0]! * innovation[0] + Si[1]![1]! * innovation[1]);
    return { innovation, innovationCovariance: S, nis };
  }

  /** Commits a prediction with a measurement: model updates, likelihoods, fusion. */
  public applyMeasurement(
    prediction: ImmPrediction,
    azimuth: number,
    elevation: number,
  ): ImmUpdate {
    const logWeights: number[] = [];
    const logLikelihoods: number[] = [];
    const updated: ModelState[] = [];

    prediction.models.forEach((model, j) => {
      const innovation = [shortestAngle(azimuth, model.x[0]!), elevation - model.x[1]!];
      const S = this.innovationCovariance(model.P);
      const inverse = invert2(S);
      if (inverse === null) throw new Error('Singular innovation covariance');
      const K = multiply(multiply(model.P, HT), inverse.inverse);
      const correction = apply(K, innovation);
      const x = model.x.map((value, i) => value + correction[i]!);
      x[0] = wrapAngle(x[0]!);
      // Joseph form: stays symmetric positive semidefinite under rounding.
      const IKH = subtract(identity(STATE_SIZE), multiply(K, H));
      const R = this.measurementCovariance();
      const P = symmetrize(
        add(
          multiply(multiply(IKH, model.P), transpose(IKH)),
          multiply(multiply(K, R), transpose(K)),
        ),
      );
      updated.push({ x, P });

      const nis =
        innovation[0]! *
          (inverse.inverse[0]![0]! * innovation[0]! + inverse.inverse[0]![1]! * innovation[1]!) +
        innovation[1]! *
          (inverse.inverse[1]![0]! * innovation[0]! + inverse.inverse[1]![1]! * innovation[1]!);
      const logLikelihood = -0.5 * (nis + Math.log((2 * Math.PI) ** 2 * inverse.determinant));
      logLikelihoods.push(logLikelihood);
      logWeights.push(Math.log(prediction.priorProbabilities[j]!) + logLikelihood);
    });

    const fusedGate = this.gate(prediction, azimuth, elevation);
    this.commit(updated, normaliseLog(logWeights), prediction.time);
    return {
      nis: fusedGate?.nis ?? Number.NaN,
      logLikelihoods,
      modelProbabilities: this.probabilities.slice(),
    };
  }

  /** Commits a prediction with no measurement: probabilities follow the chain alone. */
  public applyNoMeasurement(prediction: ImmPrediction): void {
    this.commit(
      prediction.models.map((m) => ({ x: m.x.slice(), P: clone(m.P) })),
      prediction.priorProbabilities.slice(),
      prediction.time,
    );
  }

  /** The fused posterior. */
  public estimate(): ImmEstimate {
    if (this.currentTime === null) throw new Error('IMM used before initialisation');
    const reference = this.models[this.probabilities[0]! >= this.probabilities[1]! ? 0 : 1]!.x[0]!;
    const state = weightedMean(
      this.models.map((m) => m.x),
      this.probabilities,
      reference,
    );
    return {
      time: this.currentTime,
      state,
      covariance: spreadCovariance(this.models, this.probabilities, state),
      modelProbabilities: this.probabilities.slice(),
    };
  }

  /** Each model's own posterior, for diagnostics and tests. */
  public modelStates(): readonly {
    readonly state: readonly number[];
    readonly covariance: Matrix;
  }[] {
    return this.models.map((m) => ({ state: m.x.slice(), covariance: clone(m.P) }));
  }

  /** √(largest eigenvalue of the angular covariance block), radians. */
  public static angularSigma(covariance: Matrix): number {
    return Math.sqrt(
      Math.max(
        0,
        largestEigenvalue2([
          [covariance[0]![0]!, covariance[0]![1]!],
          [covariance[1]![0]!, covariance[1]![1]!],
        ]),
      ),
    );
  }

  private measurementCovariance(): Matrix {
    const r = this.config.measurementNoiseStdDev ** 2;
    return [
      [r, 0],
      [0, r],
    ];
  }

  private innovationCovariance(P: Matrix): Matrix {
    return symmetrize(add(multiply(multiply(H, P), HT), this.measurementCovariance()));
  }

  /** Steps 1–4 of one cycle over dt. */
  private mixAndPredict(
    models: readonly ModelState[],
    probabilities: readonly number[],
    dt: number,
  ): { models: ModelState[]; prior: number[] } {
    const p = transitionProbabilities(this.config, dt);
    const prior = [0, 1].map((j) => p[0]![j]! * probabilities[0]! + p[1]![j]! * probabilities[1]!);

    const predicted = MODEL_NAMES.map((name, j) => {
      const weights = [0, 1].map((i) => (p[i]![j]! * probabilities[i]!) / prior[j]!);
      const x0 = weightedMean(
        models.map((m) => m.x),
        weights,
        models[j]!.x[0]!,
      );
      const P0 = spreadCovariance(models, weights, x0);
      const F = transition(name, dt);
      const x = apply(F, x0);
      x[0] = wrapAngle(x[0]!);
      const P = symmetrize(
        add(multiply(multiply(F, P0), transpose(F)), processNoise(name, dt, this.config)),
      );
      return { x, P };
    });

    return { models: predicted, prior };
  }

  private commit(models: ModelState[], probabilities: number[], time: number): void {
    // Numerical guard: a non-finite result would poison every later cycle, so it
    // is refused loudly rather than stored.
    for (const model of models) {
      if (!model.x.every(Number.isFinite) || !isFiniteMatrix(model.P)) {
        throw new Error('IMM produced a non-finite state');
      }
    }
    this.models = models;
    this.probabilities = probabilities;
    this.currentTime = time;
  }
}
