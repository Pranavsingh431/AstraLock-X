/**
 * Small dense linear algebra for the AstraLock-X estimator.
 *
 * Plain arrays of rows. The estimator's matrices are at most 6×6 and there are
 * two models, so clarity beats a numeric library, and a dependency would be a
 * hard thing to justify in the most restricted directory in the project.
 */

export type Matrix = number[][];

export const zeros = (rows: number, cols: number): Matrix =>
  Array.from({ length: rows }, () => new Array<number>(cols).fill(0));

export const identity = (n: number): Matrix => {
  const m = zeros(n, n);
  for (let i = 0; i < n; i += 1) m[i]![i] = 1;
  return m;
};

export const clone = (m: Matrix): Matrix => m.map((row) => row.slice());

export function multiply(a: Matrix, b: Matrix): Matrix {
  const rows = a.length;
  const cols = b[0]!.length;
  const inner = b.length;
  const out = zeros(rows, cols);
  for (let i = 0; i < rows; i += 1) {
    const ai = a[i]!;
    const oi = out[i]!;
    for (let k = 0; k < inner; k += 1) {
      const aik = ai[k]!;
      if (aik === 0) continue;
      const bk = b[k]!;
      for (let j = 0; j < cols; j += 1) oi[j]! += aik * bk[j]!;
    }
  }
  return out;
}

export const transpose = (m: Matrix): Matrix => m[0]!.map((_, j) => m.map((row) => row[j]!));

export function add(a: Matrix, b: Matrix): Matrix {
  return a.map((row, i) => row.map((value, j) => value + b[i]![j]!));
}

export function subtract(a: Matrix, b: Matrix): Matrix {
  return a.map((row, i) => row.map((value, j) => value - b[i]![j]!));
}

export const scale = (m: Matrix, s: number): Matrix => m.map((row) => row.map((v) => v * s));

/** A·v for a column vector. */
export const apply = (m: Matrix, v: readonly number[]): number[] =>
  m.map((row) => row.reduce((sum, value, j) => sum + value * v[j]!, 0));

/** v·vᵀ. */
export const outer = (a: readonly number[], b: readonly number[]): Matrix =>
  a.map((ai) => b.map((bj) => ai * bj));

/** (M + Mᵀ)/2, removing the asymmetry rounding introduces. */
export function symmetrize(m: Matrix): Matrix {
  const n = m.length;
  const out = zeros(n, n);
  for (let i = 0; i < n; i += 1) {
    for (let j = 0; j < n; j += 1) out[i]![j] = 0.5 * (m[i]![j]! + m[j]![i]!);
  }
  return out;
}

/** Inverse and determinant of a 2×2, or `null` when singular. */
export function invert2(m: Matrix): { inverse: Matrix; determinant: number } | null {
  const a = m[0]![0]!;
  const b = m[0]![1]!;
  const c = m[1]![0]!;
  const d = m[1]![1]!;
  const determinant = a * d - b * c;
  if (!(determinant > 0) || !Number.isFinite(determinant)) return null;
  return {
    inverse: [
      [d / determinant, -b / determinant],
      [-c / determinant, a / determinant],
    ],
    determinant,
  };
}

/** Largest eigenvalue of a symmetric 2×2. */
export function largestEigenvalue2(m: Matrix): number {
  const a = m[0]![0]!;
  const b = 0.5 * (m[0]![1]! + m[1]![0]!);
  const d = m[1]![1]!;
  const mean = 0.5 * (a + d);
  const radius = Math.hypot(0.5 * (a - d), b);
  return mean + radius;
}

/** Eigen-decomposition of a symmetric 2×2: semi-axes variances and the major-axis angle. */
export function eigen2(m: Matrix): { major: number; minor: number; angle: number } {
  const a = m[0]![0]!;
  const b = 0.5 * (m[0]![1]! + m[1]![0]!);
  const d = m[1]![1]!;
  const mean = 0.5 * (a + d);
  const radius = Math.hypot(0.5 * (a - d), b);
  return {
    major: mean + radius,
    minor: Math.max(0, mean - radius),
    angle: 0.5 * Math.atan2(2 * b, a - d),
  };
}

/** Whether every entry is finite. */
export const isFiniteMatrix = (m: Matrix): boolean =>
  m.every((row) => row.every((value) => Number.isFinite(value)));
