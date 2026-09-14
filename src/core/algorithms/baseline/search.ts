/**
 * Deterministic raster search.
 *
 * The mount has to find a target it knows nothing about. This scan therefore
 * uses **no target prior of any kind** — not a bearing, not a hint, not a
 * region narrowed by anything the simulator knows. It sweeps the configured
 * region on a fixed lattice and the target is found when, and only when, the
 * camera physically points at it and the detector sees the pixels.
 *
 * Boustrophedon (serpentine) rather than a raster that returns to the start of
 * each row: the return sweep would spend half the scan traversing ground it
 * had already covered, and on a rate-limited mount that is half the acquisition
 * time thrown away. A spiral or an uncertainty-weighted pattern would be better
 * still and belongs to the robust algorithm; this one is chosen for being
 * obviously exhaustive.
 *
 * See docs/BASELINE_PAT.md.
 */

/** The region to sweep and how finely. */
export interface SearchConfig {
  readonly panMin: number;
  readonly panMax: number;
  readonly tiltMin: number;
  readonly tiltMax: number;
  /** Pan spacing between waypoints, radians. */
  readonly horizontalStep: number;
  /** Tilt spacing between rows, radians. */
  readonly verticalStep: number;
  /** Treat a waypoint as reached inside this angular error, radians. */
  readonly settleTolerance: number;
  /** ...and only when the measured rate is below this, rad/s. */
  readonly measuredRateTolerance: number;
  /** Hold a settled waypoint this long before moving on, seconds. */
  readonly dwellTime: number;
  /** Abandon a waypoint that will not settle after this long, seconds. */
  readonly waypointTimeout: number;
  /** Restart from the beginning when the region is exhausted. */
  readonly loop: boolean;
}

export interface SearchWaypoint {
  readonly pan: number;
  readonly tilt: number;
  readonly index: number;
}

/**
 * Builds the full waypoint list up front.
 *
 * Materialised rather than generated on demand so that "does this pattern cover
 * the region" is a question a test can answer directly, and so the sequence is
 * inspectable in the UI.
 *
 * The lattice always includes both ends of each axis: a region whose extent is
 * not an exact multiple of the step would otherwise leave an uncovered strip at
 * the far edge, which is the classic way a scan misses a target sitting in the
 * corner.
 */
export function buildWaypoints(config: SearchConfig): readonly SearchWaypoint[] {
  const panSpan = config.panMax - config.panMin;
  const tiltSpan = config.tiltMax - config.tiltMin;

  const columns = Math.max(1, Math.ceil(panSpan / config.horizontalStep) + 1);
  const rows = Math.max(1, Math.ceil(tiltSpan / config.verticalStep) + 1);

  const panAt = (column: number): number =>
    columns === 1 ? config.panMin : config.panMin + (panSpan * column) / (columns - 1);
  const tiltAt = (row: number): number =>
    rows === 1 ? config.tiltMin : config.tiltMin + (tiltSpan * row) / (rows - 1);

  const waypoints: SearchWaypoint[] = [];
  for (let row = 0; row < rows; row += 1) {
    const tilt = tiltAt(row);
    for (let step = 0; step < columns; step += 1) {
      // Serpentine: odd rows sweep back the way they came.
      const column = row % 2 === 0 ? step : columns - 1 - step;
      waypoints.push({ pan: panAt(column), tilt, index: waypoints.length });
    }
  }
  return waypoints;
}

/** Why the scan moved on from a waypoint. Recorded so a slow scan is explicable. */
export type WaypointOutcome = 'settled' | 'timeout';

/**
 * Walks the waypoint list, advancing only on algorithm-safe evidence.
 *
 * A new waypoint is **not** issued per frame. Commanding a fresh setpoint every
 * 16.7 ms would mean the mount never finishes a move before being told to do
 * something else, and the scan would crawl while looking busy. Instead the scan
 * holds a waypoint until the measured state says the mount arrived and stopped,
 * then dwells long enough for at least one clean frame.
 *
 * Everything the decision uses — commanded angle, measured angle, measured
 * rate, simulated time — is available to real control software. None of it is
 * the mount's true pose, and the scan never consults the world.
 */
export class SearchPattern {
  private readonly waypoints: readonly SearchWaypoint[];
  private cursor = 0;
  private enteredAt: number | null = null;
  private settledAt: number | null = null;
  private complete = false;
  private lastOutcome: WaypointOutcome | null = null;

  constructor(private readonly config: SearchConfig) {
    this.waypoints = buildWaypoints(config);
  }

  public get all(): readonly SearchWaypoint[] {
    return this.waypoints;
  }

  public get current(): SearchWaypoint {
    return this.waypoints[Math.min(this.cursor, this.waypoints.length - 1)]!;
  }

  public get isComplete(): boolean {
    return this.complete;
  }

  public get lastAdvanceReason(): WaypointOutcome | null {
    return this.lastOutcome;
  }

  public reset(): void {
    this.cursor = 0;
    this.enteredAt = null;
    this.settledAt = null;
    this.complete = false;
    this.lastOutcome = null;
  }

  /**
   * Decides which waypoint to command now.
   *
   * @param time current simulated time
   * @param measuredPan encoder-reported pan
   * @param measuredTilt encoder-reported tilt
   * @param measuredPanRate rate differenced from encoder readings
   * @param measuredTiltRate likewise
   */
  public step(
    time: number,
    measuredPan: number,
    measuredTilt: number,
    measuredPanRate: number,
    measuredTiltRate: number,
  ): SearchWaypoint {
    if (this.enteredAt === null) this.enteredAt = time;

    const target = this.current;
    const positionError = Math.max(
      Math.abs(measuredPan - target.pan),
      Math.abs(measuredTilt - target.tilt),
    );
    const rate = Math.max(Math.abs(measuredPanRate), Math.abs(measuredTiltRate));

    const arrived =
      positionError <= this.config.settleTolerance && rate <= this.config.measuredRateTolerance;

    if (arrived) {
      this.settledAt ??= time;
    } else {
      this.settledAt = null;
    }

    const dwelled = this.settledAt !== null && time - this.settledAt >= this.config.dwellTime;
    // The timeout is measured in *simulated* time and exists because a deadband
    // wider than the settle tolerance, or a setpoint the travel stops make
    // unreachable, would otherwise hold the scan on one waypoint for ever.
    const timedOut = time - this.enteredAt >= this.config.waypointTimeout;

    if (dwelled || timedOut) {
      this.lastOutcome = dwelled ? 'settled' : 'timeout';
      this.advance(time);
    }

    return this.current;
  }

  private advance(time: number): void {
    this.cursor += 1;
    this.enteredAt = time;
    this.settledAt = null;

    if (this.cursor >= this.waypoints.length) {
      if (this.config.loop) {
        this.cursor = 0;
      } else {
        this.cursor = this.waypoints.length - 1;
        this.complete = true;
      }
    }
  }
}
