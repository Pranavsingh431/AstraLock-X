/**
 * Search: coverage-guaranteed global search, optional prior-guided ordering,
 * and covariance-scaled local search for RECOVER.
 *
 * Inputs are the search-region configuration, the believed camera field of
 * view, the measured mount state and simulated time. Never the target.
 *
 * **Coverage.** Pointings are a boustrophedon grid whose spacing is at most
 * (1 − overlap) of the field of view on each axis. A pointing counts as visited
 * only once the measured pose is within `settleTolerance` of it, so every
 * direction in the region lies within half a field minus the settle tolerance of
 * some visited pointing whenever
 *
 * ```
 *   spacing / 2 + settleTolerance ≤ FOV / 2
 * ```
 *
 * which {@link assertCoverage} checks at construction. Under the ideal sensor a
 * point beacon cannot fall between cells.
 *
 * **Prior.** With a coarse prior (centre and per-axis sigma), grid pointings
 * inside the `priorSigmaExtent`-sigma ellipse are visited first, in order of
 * Mahalanobis distance from the centre — an expanding, uncertainty-scaled
 * pattern — followed by the rest of the region. Deterministic; not claimed to be
 * Bayes-optimal.
 *
 * See docs/ASTRALOCK_PAT.md.
 */

import type { SearchPrior } from './config';

export interface Pointing {
  readonly azimuth: number;
  readonly elevation: number;
}

export interface SearchRegion {
  readonly panMin: number;
  readonly panMax: number;
  readonly tiltMin: number;
  readonly tiltMax: number;
}

export interface FieldOfView {
  readonly horizontal: number;
  readonly vertical: number;
}

/** Evenly spaced values from min to max inclusive, spacing at most `step`. */
function axisPoints(min: number, max: number, step: number): number[] {
  const span = max - min;
  const count = Math.max(1, Math.ceil(span / step - 1e-9)) + 1;
  return Array.from({ length: count }, (_, i) => min + (span * i) / (count - 1));
}

/** The spacing used on each axis. */
export function gridSpacing(fov: FieldOfView, overlap: number): FieldOfView {
  return { horizontal: fov.horizontal * (1 - overlap), vertical: fov.vertical * (1 - overlap) };
}

/** A boustrophedon grid covering the region. */
export function coverageWaypoints(
  region: SearchRegion,
  fov: FieldOfView,
  overlap: number,
): Pointing[] {
  const step = gridSpacing(fov, overlap);
  const pans = axisPoints(region.panMin, region.panMax, step.horizontal);
  const tilts = axisPoints(region.tiltMin, region.tiltMax, step.vertical);
  const out: Pointing[] = [];
  tilts.forEach((elevation, row) => {
    const ordered = row % 2 === 0 ? pans : [...pans].reverse();
    for (const azimuth of ordered) out.push({ azimuth, elevation });
  });
  return out;
}

/**
 * Prior-first ordering: grid pointings within the sigma extent, nearest
 * (Mahalanobis) first, then the rest of the coverage grid.
 */
export function priorWaypoints(
  prior: SearchPrior,
  region: SearchRegion,
  fov: FieldOfView,
  overlap: number,
  sigmaExtent: number,
): Pointing[] {
  const step = gridSpacing(fov, overlap);
  const halfWidth = sigmaExtent * prior.sigmaAzimuth;
  const halfHeight = sigmaExtent * prior.sigmaElevation;
  const local: { p: Pointing; d2: number; angle: number }[] = [];
  const nx = Math.ceil(halfWidth / step.horizontal);
  const ny = Math.ceil(halfHeight / step.vertical);
  for (let i = -nx; i <= nx; i += 1) {
    for (let j = -ny; j <= ny; j += 1) {
      const azimuth = prior.centreAzimuth + i * step.horizontal;
      const elevation = prior.centreElevation + j * step.vertical;
      const d2 =
        ((azimuth - prior.centreAzimuth) / prior.sigmaAzimuth) ** 2 +
        ((elevation - prior.centreElevation) / prior.sigmaElevation) ** 2;
      if (d2 > sigmaExtent ** 2 + 1e-9) continue;
      if (
        azimuth < region.panMin ||
        azimuth > region.panMax ||
        elevation < region.tiltMin ||
        elevation > region.tiltMax
      ) {
        continue;
      }
      local.push({ p: { azimuth, elevation }, d2, angle: Math.atan2(j, i) });
    }
  }
  local.sort((a, b) => a.d2 - b.d2 || a.angle - b.angle);
  const first = local.map((entry) => entry.p);
  const rest = coverageWaypoints(region, fov, overlap).filter(
    (c) =>
      !first.some(
        (p) =>
          Math.abs(p.azimuth - c.azimuth) <= step.horizontal / 2 &&
          Math.abs(p.elevation - c.elevation) <= step.vertical / 2,
      ),
  );
  return [...first, ...rest];
}

/**
 * Largest distance, per axis, from any direction in the region to the nearest
 * pointing. For the coverage guarantee and its test.
 */
export function coverageGap(
  waypoints: readonly Pointing[],
  region: SearchRegion,
  samples = 41,
): FieldOfView {
  let worstH = 0;
  let worstV = 0;
  for (let i = 0; i < samples; i += 1) {
    for (let j = 0; j < samples; j += 1) {
      const az = region.panMin + ((region.panMax - region.panMin) * i) / (samples - 1);
      const el = region.tiltMin + ((region.tiltMax - region.tiltMin) * j) / (samples - 1);
      let best: { h: number; v: number } | null = null;
      for (const w of waypoints) {
        const h = Math.abs(w.azimuth - az);
        const v = Math.abs(w.elevation - el);
        if (best === null || Math.max(h / 1, v / 1) < Math.max(best.h, best.v)) best = { h, v };
      }
      worstH = Math.max(worstH, best!.h);
      worstV = Math.max(worstV, best!.v);
    }
  }
  return { horizontal: worstH, vertical: worstV };
}

/** Throws if the grid and settle tolerance cannot guarantee coverage. */
export function assertCoverage(fov: FieldOfView, overlap: number, settleTolerance: number): void {
  const step = gridSpacing(fov, overlap);
  if (
    step.horizontal / 2 + settleTolerance > fov.horizontal / 2 ||
    step.vertical / 2 + settleTolerance > fov.vertical / 2
  ) {
    throw new Error(
      'Search overlap and settle tolerance leave gaps: spacing/2 + settleTolerance must not exceed FOV/2 on either axis',
    );
  }
}

export interface WaypointSearchConfig {
  readonly settleTolerance: number;
  readonly measuredRateTolerance: number;
  readonly dwellTime: number;
  readonly waypointTimeout: number;
}

/**
 * Steps through a waypoint list on measured arrival, dwell and timeout —
 * the same safe rule the baseline uses — and loops.
 */
export class WaypointSearch {
  private cursor = 0;
  private enteredAt: number | null = null;
  private settledAt: number | null = null;

  constructor(
    public readonly waypoints: readonly Pointing[],
    private readonly config: WaypointSearchConfig,
  ) {
    if (waypoints.length === 0) throw new Error('A search needs at least one waypoint');
  }

  public get index(): number {
    return this.cursor;
  }

  public get current(): Pointing {
    return this.waypoints[this.cursor]!;
  }

  public reset(): void {
    this.cursor = 0;
    this.enteredAt = null;
    this.settledAt = null;
  }

  /** Restarts from the pointing nearest a bearing, e.g. the last predicted one. */
  public startNearest(bearing: Pointing): void {
    let best = 0;
    let bestDistance = Number.POSITIVE_INFINITY;
    this.waypoints.forEach((w, i) => {
      const d = Math.hypot(w.azimuth - bearing.azimuth, w.elevation - bearing.elevation);
      if (d < bestDistance) {
        bestDistance = d;
        best = i;
      }
    });
    this.cursor = best;
    this.enteredAt = null;
    this.settledAt = null;
  }

  public step(
    time: number,
    measured: Pointing,
    rateAzimuth: number,
    rateElevation: number,
  ): Pointing {
    this.enteredAt ??= time;
    const target = this.current;
    const arrived =
      Math.max(
        Math.abs(measured.azimuth - target.azimuth),
        Math.abs(measured.elevation - target.elevation),
      ) <= this.config.settleTolerance &&
      Math.max(Math.abs(rateAzimuth), Math.abs(rateElevation)) <= this.config.measuredRateTolerance;
    if (arrived) this.settledAt ??= time;
    else this.settledAt = null;

    const dwelled = this.settledAt !== null && time - this.settledAt >= this.config.dwellTime;
    const timedOut = time - this.enteredAt >= this.config.waypointTimeout;
    if (dwelled || timedOut) {
      this.cursor = (this.cursor + 1) % this.waypoints.length;
      this.enteredAt = time;
      this.settledAt = null;
    }
    return this.current;
  }
}

/**
 * Unit local-search pattern: the prediction itself, then six pointings on a
 * half-radius ring, then twelve on the full radius.
 */
export const LOCAL_SEARCH_PATTERN: readonly (readonly [number, number])[] = [
  [0, 0],
  ...Array.from({ length: 6 }, (_, k) => {
    const a = (k * Math.PI) / 3;
    return [0.5 * Math.cos(a), 0.5 * Math.sin(a)] as const;
  }),
  ...Array.from({ length: 12 }, (_, k) => {
    const a = (k * Math.PI) / 6 + Math.PI / 12;
    return [Math.cos(a), Math.sin(a)] as const;
  }),
];

export interface LocalSearchConfig {
  readonly localSearchSigmaMultiple: number;
  readonly localSearchMinRadius: number;
  readonly localSearchMaxRadius: number;
  readonly localSearchDwell: number;
}

/** Local search radius from the estimator's angular sigma, clamped. */
export function localSearchRadius(angularSigma: number, config: LocalSearchConfig): number {
  return Math.min(
    config.localSearchMaxRadius,
    Math.max(config.localSearchMinRadius, config.localSearchSigmaMultiple * angularSigma),
  );
}

/**
 * The offset to add to the predicted bearing at a given time into local search.
 * Azimuth offsets are divided by cos(elevation) so the pattern has true angular
 * size on the sky.
 */
export function localSearchOffset(
  elapsed: number,
  radius: number,
  elevation: number,
  config: LocalSearchConfig,
): { azimuth: number; elevation: number; index: number } {
  const index =
    Math.floor(Math.max(0, elapsed) / config.localSearchDwell) % LOCAL_SEARCH_PATTERN.length;
  const [ux, uy] = LOCAL_SEARCH_PATTERN[index]!;
  return {
    azimuth: (radius * ux) / Math.max(Math.cos(elevation), 0.2),
    elevation: radius * uy,
    index,
  };
}
