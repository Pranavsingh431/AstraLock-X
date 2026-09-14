/**
 * The human-readable run report.
 *
 * Generated **from the stored artifacts** — manifest, configuration snapshots,
 * event log, telemetry, evaluation and the summary computed from them — never
 * from whatever the interface happens to be showing. The same files produce the
 * same report, months later, on a machine that never ran the simulation.
 *
 * Entirely self-contained: no script, no web font, no network reference of any
 * kind. Plots are inline SVG computed here from the recorded samples. Sample
 * files are streamed, and each plotted series is reduced to at most
 * {@link PLOT_BUCKETS} min/max pairs, so a long run's report stays small
 * without dropping the extremes a reader most needs to see.
 *
 * See docs/REPORTING.md.
 */

import type { Measurement } from '@/core/contracts/measurement';
import { formatMeasurement } from '@/core/contracts/measurement';

import { LockAnalyser, isTrackable, lockConditionMet } from './metrics';
import { performanceLog } from './performance-log';
import { displayStatus, readManifest } from './recompute';
import type {
  ExperimentEvent,
  ExperimentManifest,
  ExperimentSummary,
  SummaryStatistics,
} from './schema';
import { evaluationParser, parseEventLine, telemetryParser } from './serialisation';
import { RUN_FILES } from './storage';
import type { ExperimentStorage } from './storage';

/** Time buckets per plotted series. Each keeps its minimum and maximum. */
export const PLOT_BUCKETS = 500;

/** Notable events listed in the report; the rest are in events.jsonl. */
const EVENT_TABLE_LIMIT = 150;

const DEG = 180 / Math.PI;

const escape = (text: string): string =>
  text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// --- Series reduction -------------------------------------------------------

/**
 * A plotted series reduced to min/max per time bucket.
 *
 * Plain decimation — every nth sample — would silently drop a one-frame spike,
 * which is exactly what a pointing-error plot must not hide. Keeping each
 * bucket's minimum and maximum preserves the envelope at any length of run.
 */
export class ReducedSeries {
  private readonly min: Float64Array;
  private readonly max: Float64Array;
  private readonly minTime: Float64Array;
  private readonly maxTime: Float64Array;
  private readonly filled: Uint8Array;
  public count = 0;

  constructor(
    private readonly t0: number,
    private readonly t1: number,
    private readonly buckets = PLOT_BUCKETS,
  ) {
    this.min = new Float64Array(buckets);
    this.max = new Float64Array(buckets);
    this.minTime = new Float64Array(buckets);
    this.maxTime = new Float64Array(buckets);
    this.filled = new Uint8Array(buckets);
  }

  public push(time: number, value: number): void {
    if (!Number.isFinite(value)) return;
    const span = this.t1 - this.t0;
    const index =
      span > 0
        ? Math.min(
            this.buckets - 1,
            Math.max(0, Math.floor(((time - this.t0) / span) * this.buckets)),
          )
        : 0;
    this.count += 1;
    if (this.filled[index] === 0) {
      this.filled[index] = 1;
      this.min[index] = value;
      this.max[index] = value;
      this.minTime[index] = time;
      this.maxTime[index] = time;
      return;
    }
    if (value < this.min[index]!) {
      this.min[index] = value;
      this.minTime[index] = time;
    }
    if (value > this.max[index]!) {
      this.max[index] = value;
      this.maxTime[index] = time;
    }
  }

  /** The reduced points in time order. */
  public points(): readonly (readonly [number, number])[] {
    const out: (readonly [number, number])[] = [];
    for (let index = 0; index < this.buckets; index += 1) {
      if (this.filled[index] === 0) continue;
      const a = [this.minTime[index]!, this.min[index]!] as const;
      const b = [this.maxTime[index]!, this.max[index]!] as const;
      if (a[0] === b[0] && a[1] === b[1]) out.push(a);
      else if (a[0] <= b[0]) out.push(a, b);
      else out.push(b, a);
    }
    return out;
  }
}

/** Contiguous spans of a categorical value over time. */
class Bands {
  public readonly spans: { from: number; to: number; value: string }[] = [];

  public push(time: number, value: string): void {
    const last = this.spans[this.spans.length - 1];
    if (last !== undefined) last.to = time;
    if (last?.value !== value) this.spans.push({ from: time, to: time, value });
  }
}

// --- Rendering helpers ------------------------------------------------------

function show(measurement: Measurement, digits = 3): string {
  if (measurement.value === null) {
    return `<span class="absent">${escape(formatMeasurement(measurement))}</span>`;
  }
  if (measurement.unit === 'rad') {
    const urad = measurement.value * 1e6;
    return `${urad.toFixed(1)} µrad <span class="sub">(${measurement.value.toExponential(4)} rad)</span>`;
  }
  if (measurement.unit === '1') return `${(measurement.value * 100).toFixed(2)} %`;
  return escape(formatMeasurement(measurement, digits));
}

/**
 * A frame rate, quoted to a precision its measurement window can support.
 *
 * Every rate here is a count divided by a window, so one frame either way moves
 * it by `1 / window` fps. Over a minute that is a sixtieth of a frame per
 * second and three decimals are meaningful; over a fifth of a second it is five
 * fps and even the units digit is arguable. Printing a fixed three decimals in
 * both cases claims a precision that does not exist in the second.
 *
 * The measured value is never altered — not clamped, not rounded to something
 * tidier, not replaced by the configured rate. A short window earns fewer
 * digits and a footnote saying what a single frame is worth, and the count and
 * the window are both shown so the division can be checked by hand.
 */
function rateCell(rate: Measurement, window: Measurement, count: number, noun: string): string {
  const frames = `${String(count)} ${noun}`;
  if (rate.value === null || window.value === null || window.value <= 0) {
    return `${show(rate, 3)} <span class="sub">${frames}</span>`;
  }

  const perFrame = 1 / window.value;
  // Digits down to the ±1 frame resolution, capped at three: beyond that the
  // column is wider than it is informative.
  const digits = Math.max(0, Math.min(3, Math.ceil(-Math.log10(perFrame))));
  const worth = perFrame >= 10 ? perFrame.toFixed(0) : perFrame.toFixed(1);
  const footnote =
    perFrame >= 0.5
      ? ` <span class="sub">Short window: one frame either way is ${worth} fps, so this is quoted to ${String(digits)} decimal${digits === 1 ? '' : 's'}.</span>`
      : '';

  return `${rate.value.toFixed(digits)} fps <span class="sub">${frames} over ${window.value.toFixed(3)} s</span>${footnote}`;
}

const statRow = (label: string, stats: SummaryStatistics, digits = 3): string => `
  <tr><th>${escape(label)}</th><td>${String(stats.count)}</td><td>${show(stats.mean, digits)}</td><td>${show(stats.rms, digits)}</td><td>${show(stats.median, digits)}</td><td>${show(stats.p95, digits)}</td><td>${show(stats.max, digits)}</td></tr>`;

const statHead = (first: string): string =>
  `<thead><tr><th>${escape(first)}</th><th>n</th><th>Mean</th><th>RMS</th><th>Median</th><th>P95</th><th>Max</th></tr></thead>`;

interface PlotSeries {
  readonly label: string;
  readonly colour: string;
  readonly points: readonly (readonly [number, number])[];
}

const WIDTH = 760;
const HEIGHT = 190;
const PAD = { left: 64, right: 12, top: 10, bottom: 24 };

function lineChart(options: {
  title: string;
  unit: string;
  series: readonly PlotSeries[];
  t0: number;
  t1: number;
  logarithmic?: boolean;
  threshold?: { value: number; label: string };
  note?: string;
}): string {
  const { title, unit, series, t0, t1 } = options;
  const log = options.logarithmic ?? false;
  const all = series.flatMap((s) => s.points);
  if (all.length < 2) {
    return `<figure><figcaption>${escape(title)}</figcaption><p class="empty">No samples to plot.</p></figure>`;
  }

  // Values at or below zero have no logarithm; they are drawn at the floor and
  // the caption says so, rather than being dropped from the plot.
  const floor = 1e-3;
  const transform = (y: number): number => (log ? Math.log10(Math.max(y, floor)) : y);
  const ys = all.map(([, y]) => transform(y));
  if (options.threshold !== undefined) ys.push(transform(options.threshold.value));
  let y0 = Math.min(...ys);
  let y1 = Math.max(...ys);
  if (log) {
    y0 = Math.floor(y0);
    y1 = Math.ceil(y1);
  }
  if (y1 === y0) y1 = y0 + 1;
  const xSpan = t1 - t0 || 1;

  const px = (x: number): number => PAD.left + ((x - t0) / xSpan) * (WIDTH - PAD.left - PAD.right);
  const py = (y: number): number =>
    HEIGHT - PAD.bottom - ((transform(y) - y0) / (y1 - y0)) * (HEIGHT - PAD.top - PAD.bottom);

  const paths = series
    .filter((s) => s.points.length > 1)
    .map(
      (s) =>
        `<path d="${s.points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${px(x).toFixed(1)} ${py(y).toFixed(1)}`).join(' ')}" fill="none" stroke="${s.colour}" stroke-width="1.1"/>`,
    )
    .join('');

  const ticks: string[] = [];
  const tickValues = log
    ? Array.from({ length: y1 - y0 + 1 }, (_, i) => 10 ** (y0 + i))
    : [y0, (y0 + y1) / 2, y1];
  const tickText = (v: number): string =>
    log ? v.toExponential(0) : Math.abs(v) >= 1e4 ? v.toExponential(2) : v.toPrecision(3);
  for (const value of tickValues) {
    const y = py(value);
    ticks.push(
      `<line x1="${String(PAD.left)}" x2="${String(WIDTH - PAD.right)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" class="grid"/><text x="${String(PAD.left - 4)}" y="${(y + 3).toFixed(1)}" class="axis" text-anchor="end">${escape(tickText(value))}</text>`,
    );
  }

  const threshold =
    options.threshold === undefined
      ? ''
      : `<line x1="${String(PAD.left)}" x2="${String(WIDTH - PAD.right)}" y1="${py(options.threshold.value).toFixed(1)}" y2="${py(options.threshold.value).toFixed(1)}" class="threshold"/><text x="${String(WIDTH - PAD.right - 2)}" y="${(py(options.threshold.value) - 3).toFixed(1)}" class="axis" text-anchor="end">${escape(options.threshold.label)}</text>`;

  const legend = series
    .map((s) => `<span class="key"><i style="background:${s.colour}"></i>${escape(s.label)}</span>`)
    .join(' ');

  return `<figure>
<figcaption>${escape(title)} <span class="unit">[${escape(unit)}${log ? ', log scale' : ''}]</span> ${legend}</figcaption>
<svg viewBox="0 0 ${String(WIDTH)} ${String(HEIGHT)}" role="img" aria-label="${escape(title)}">
${ticks.join('')}${threshold}${paths}
<text x="${String(PAD.left)}" y="${String(HEIGHT - 6)}" class="axis">${t0.toFixed(2)} s</text>
<text x="${String(WIDTH - PAD.right)}" y="${String(HEIGHT - 6)}" class="axis" text-anchor="end">${t1.toFixed(2)} s simulated</text>
</svg>
${options.note === undefined ? '' : `<p class="note">${escape(options.note)}</p>`}
</figure>`;
}

function bandChart(
  title: string,
  rows: readonly { label: string; bands: Bands; colours: Record<string, string> }[],
  t0: number,
  t1: number,
): string {
  const rowHeight = 22;
  const height = rows.length * (rowHeight + 6) + 18;
  const span = t1 - t0 || 1;
  const x = (t: number): number => PAD.left + ((t - t0) / span) * (WIDTH - PAD.left - PAD.right);

  const body = rows
    .map((row, index) => {
      const y = 4 + index * (rowHeight + 6);
      const rects = row.bands.spans
        .map(
          (s) =>
            `<rect x="${x(s.from).toFixed(1)}" y="${String(y)}" width="${Math.max(0.6, x(s.to) - x(s.from)).toFixed(1)}" height="${String(rowHeight)}" fill="${row.colours[s.value] ?? '#a1a1aa'}"><title>${escape(s.value)} ${s.from.toFixed(3)}–${s.to.toFixed(3)} s</title></rect>`,
        )
        .join('');
      return `<text x="${String(PAD.left - 4)}" y="${String(y + 15)}" class="axis" text-anchor="end">${escape(row.label)}</text>${rects}`;
    })
    .join('');

  const legend = rows
    .flatMap((row) => Object.entries(row.colours))
    .map(
      ([name, colour]) =>
        `<span class="key"><i style="background:${colour}"></i>${escape(name)}</span>`,
    )
    .join(' ');

  return `<figure>
<figcaption>${escape(title)} ${legend}</figcaption>
<svg viewBox="0 0 ${String(WIDTH)} ${String(height)}" role="img" aria-label="${escape(title)}">
${body}
<text x="${String(PAD.left)}" y="${String(height - 3)}" class="axis">${t0.toFixed(2)} s</text>
<text x="${String(WIDTH - PAD.right)}" y="${String(height - 3)}" class="axis" text-anchor="end">${t1.toFixed(2)} s simulated</text>
</svg>
</figure>`;
}

/** Flattens a configuration object into dotted key/value rows. */
const scalarText = (value: unknown): string =>
  typeof value === 'string' ? value : (JSON.stringify(value) ?? 'undefined');

function flatten(value: unknown, prefix = '', out: [string, string][] = []): [string, string][] {
  if (value === null || typeof value !== 'object') {
    out.push([prefix, scalarText(value)]);
    return out;
  }
  if (Array.isArray(value)) {
    if (value.every((entry) => entry === null || typeof entry !== 'object')) {
      out.push([prefix, `[${value.map(scalarText).join(', ')}]`]);
      return out;
    }
    value.forEach((entry, index) => flatten(entry, `${prefix}[${String(index)}]`, out));
    return out;
  }
  for (const [key, entry] of Object.entries(value)) {
    flatten(entry, prefix === '' ? key : `${prefix}.${key}`, out);
  }
  return out;
}

/** Every summary measurement that carries no value, with its reason. */
function absentMeasurements(summary: ExperimentSummary): [string, string][] {
  const out: [string, string][] = [];
  const walk = (value: unknown, path: string): void => {
    if (value === null || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if ('status' in record && 'unit' in record && 'value' in record) {
      if (record['value'] === null) out.push([path, String(record['status'])]);
      return;
    }
    for (const [key, entry] of Object.entries(record)) {
      if (key === 'metricsConfig' || key === 'episodes') continue;
      walk(entry, path === '' ? key : `${path}.${key}`);
    }
  };
  walk(summary, '');
  return out;
}

// --- The report -------------------------------------------------------------

/**
 * Renders a run's report by streaming its stored artifacts.
 *
 * @param finalStatus the status the run is being finalised as. A report is
 *   written *before* the manifest's status changes — that change is the last,
 *   atomic step that makes a run count as completed — so the manifest on disk
 *   still reads `running` at this moment and must not be what the report says.
 */
export async function renderStoredReport(
  storage: ExperimentStorage,
  runId: string,
  summary: ExperimentSummary,
  finalStatus: ExperimentManifest['status'] = 'completed',
): Promise<string> {
  const stored = await readManifest(storage, runId);
  const manifest: ExperimentManifest = { ...stored, status: finalStatus };
  const scenario = JSON.parse(await storage.readFile(runId, RUN_FILES.scenario)) as Record<
    string,
    unknown
  >;
  const algorithm = JSON.parse(await storage.readFile(runId, RUN_FILES.algorithm)) as unknown;

  const t0 = manifest.startSimulationTime;
  const t1 = manifest.endSimulationTime ?? t0;
  const series = (): ReducedSeries => new ReducedSeries(t0, t1);

  // Events: the notable ones, for the table.
  const notable: ExperimentEvent[] = [];
  let notableTotal = 0;
  let lineNumber = 0;
  await storage.readLines(runId, RUN_FILES.events, (line) => {
    lineNumber += 1;
    const event = parseEventLine(line, lineNumber);
    if (event === null || event.type === 'command-issued' || event.type === 'command-applied') {
      return;
    }
    notableTotal += 1;
    if (notable.length < EVENT_TABLE_LIMIT) notable.push(event);
  });

  // Telemetry: what the tracker saw and did.
  const panCommanded = series();
  const panMeasured = series();
  const tiltCommanded = series();
  const tiltMeasured = series();
  const centroidFromCentre = series();
  const patBands = new Bands();
  const { principalPointXPx: cx, principalPointYPx: cy } = manifest.camera;
  const telemetry = telemetryParser();
  await storage.readLines(runId, RUN_FILES.telemetry, (line) => {
    const s = telemetry.line(line);
    if (s === null) return;
    const t = s.command_issue_time_s;
    if (s.commanded_pan_rad !== null) panCommanded.push(t, s.commanded_pan_rad * DEG);
    if (s.commanded_tilt_rad !== null) tiltCommanded.push(t, s.commanded_tilt_rad * DEG);
    panMeasured.push(t, s.measured_pan_rad * DEG);
    tiltMeasured.push(t, s.measured_tilt_rad * DEG);
    if (s.centroid_x_px !== null && s.centroid_y_px !== null) {
      centroidFromCentre.push(t, Math.hypot(s.centroid_x_px - cx, s.centroid_y_px - cy));
    }
    patBands.push(t, s.pat_state.toUpperCase());
  });

  // Evaluation: how well it pointed, according to the truth.
  const angular = series();
  const image = series();
  const centroidError = series();
  const lockBands = new Bands();
  const lock = new LockAnalyser(summary.metricsConfig);
  const evaluation = evaluationParser();
  await storage.readLines(runId, RUN_FILES.evaluation, (line) => {
    const s = evaluation.line(line);
    if (s === null) return;
    const t = s.capture_time_s;
    if (s.truth_angular_pointing_error_rad !== null) {
      angular.push(t, s.truth_angular_pointing_error_rad * 1e6);
    }
    if (s.truth_image_pointing_error_px !== null) image.push(t, s.truth_image_pointing_error_px);
    if (s.truth_detector_centroid_error_px !== null) {
      centroidError.push(t, s.truth_detector_centroid_error_px);
    }
    const locked = lock.push(
      t,
      lockConditionMet(s, summary.metricsConfig),
      isTrackable(s, summary.metricsConfig),
    );
    lockBands.push(t, locked ? 'LOCKED' : 'NOT LOCKED');
  });

  return document({
    manifest,
    summary,
    scenario,
    algorithm,
    t0,
    t1,
    notable,
    notableTotal,
    charts: [
      lineChart({
        title: 'Angular pointing error vs simulation time',
        unit: 'µrad',
        series: [{ label: 'truth pointing error', colour: '#dc2626', points: angular.points() }],
        t0,
        t1,
        logarithmic: true,
        threshold: {
          value: summary.metricsConfig.lockErrorThresholdRad * 1e6,
          label: 'lock threshold',
        },
        note: `Ground truth (evaluation.csv). ${String(angular.count)} samples, drawn as the minimum and maximum of each of ${String(PLOT_BUCKETS)} time buckets.`,
      }),
      lineChart({
        title: 'Image-space pointing error vs simulation time',
        unit: 'px',
        series: [
          { label: 'true centre to principal point', colour: '#ea580c', points: image.points() },
        ],
        t0,
        t1,
        note: `Ground truth. Defined only while the target projects into the image (${String(image.count)} samples).`,
      }),
      bandChart(
        'PAT state and evaluator lock',
        [
          {
            label: 'PAT state',
            bands: patBands,
            colours: { SCAN: '#60a5fa', TRACK: '#34d399', LOST: '#fbbf24' },
          },
          {
            label: 'Evaluator',
            bands: lockBands,
            colours: { LOCKED: '#16a34a', 'NOT LOCKED': '#e4e4e7' },
          },
        ],
        t0,
        t1,
      ),
      lineChart({
        title: 'Pan: commanded vs measured',
        unit: 'deg',
        series: [
          { label: 'commanded', colour: '#2563eb', points: panCommanded.points() },
          { label: 'measured (encoder)', colour: '#16a34a', points: panMeasured.points() },
        ],
        t0,
        t1,
        note: 'Safe telemetry. Measured is the encoder reading the algorithm was given, not the true mechanical angle.',
      }),
      lineChart({
        title: 'Tilt: commanded vs measured',
        unit: 'deg',
        series: [
          { label: 'commanded', colour: '#2563eb', points: tiltCommanded.points() },
          { label: 'measured (encoder)', colour: '#16a34a', points: tiltMeasured.points() },
        ],
        t0,
        t1,
      }),
      lineChart({
        title: 'Detected centroid distance from principal point',
        unit: 'px',
        series: [
          { label: 'detected centroid', colour: '#0891b2', points: centroidFromCentre.points() },
        ],
        t0,
        t1,
        note: 'Safe telemetry: what the tracker itself could see of its error. Only frames with a detection.',
      }),
      lineChart({
        title: 'Detector centroid error vs truth',
        unit: 'px',
        series: [
          { label: 'centroid to true centre', colour: '#7c3aed', points: centroidError.points() },
        ],
        t0,
        t1,
        note: 'Ground truth. A detector diagnostic, not pointing accuracy; defined only when a detection exists and the target is in the image.',
      }),
    ],
  });
}

interface DocumentInputs {
  readonly manifest: ExperimentManifest;
  readonly summary: ExperimentSummary;
  readonly scenario: Record<string, unknown>;
  readonly algorithm: unknown;
  readonly t0: number;
  readonly t1: number;
  readonly notable: readonly ExperimentEvent[];
  readonly notableTotal: number;
  readonly charts: readonly string[];
}

/**
 * Sections that exist only for an algorithm with a robust state machine.
 *
 * Rendered conditionally rather than as a block of N/A rows. The baseline
 * cannot reach handoff readiness or a recovery state at all, and showing it an
 * empty handoff table would describe a capability it does not have.
 */
function robustSections(s: ExperimentSummary): string {
  const parts: string[] = [];
  const threshold = (s.metricsConfig as { handoffValidityThresholdRad?: number })
    .handoffValidityThresholdRad;

  // Whether this run came from an algorithm with a robust state machine at all.
  //
  // Decided from what the run *produced*, not from its id: an algorithm that
  // reported model probabilities, entered recovery, or claimed handoff
  // readiness has these states; one that did none of those things does not, and
  // a page of zeroes about capabilities it lacks would be noise. Under metrics
  // definition v2 the blocks are computed for every run, so the gate is here in
  // the presentation rather than in the data.
  const isRobust =
    (s.estimator?.framesWithModelProbabilities ?? 0) > 0 ||
    (s.algorithmRecovery?.entries ?? 0) > 0 ||
    (s.handoff?.episodes ?? 0) > 0;

  if (!isRobust) return '';

  if (s.handoff !== undefined) {
    parts.push(`
<h2>Handoff readiness</h2>
<p class="lede">The coarse tracker's own claim that the target is ready for a future fine-pointing stage, made from measured residual, estimator covariance, estimated rate and track quality. <strong>No fine-pointing actuator exists</strong>: this is readiness, not a handover, and the coarse loop keeps tracking throughout. The validity row is the evaluator's separate verdict on that claim and played no part in making it.</p>
<table class="kv">
<tr><th>First ready at</th><td>${show(s.handoff.firstHandoffReadyTime)}</td></tr>
<tr><th>Time to ready</th><td>${show(s.handoff.timeToHandoffReady)} <span class="sub">from search start</span></td></tr>
<tr><th>Ready episodes</th><td>${String(s.handoff.episodes)}</td></tr>
<tr><th>Ready duration</th><td>${show(s.handoff.durationSeconds)}</td></tr>
<tr><th>Of that, justified</th><td>${show(s.handoff.validDurationSeconds)}${
      threshold === undefined
        ? ''
        : ` <span class="sub">true pointing error within ${(threshold * 1e6).toFixed(0)} µrad</span>`
    }</td></tr>
<tr><th>Validity rate</th><td>${show(s.handoff.validityRate, 4)}</td></tr>
</table>`);
  }

  if (s.algorithmRecovery !== undefined) {
    parts.push(`
<h2>Algorithm recovery</h2>
<p class="lede">The algorithm's own RECOVER state: coasting its estimate through missing measurements and looking where it predicts, rather than restarting a global sweep. Distinct from the evaluator's loss-of-lock episodes above, which judge pointing rather than algorithm state.</p>
<table class="kv">
<tr><th>Entered recovery</th><td>${String(s.algorithmRecovery.entries)} times</td></tr>
<tr><th>Reacquired from recovery</th><td>${String(s.algorithmRecovery.reacquired)}</td></tr>
<tr><th>Fell back to global search</th><td>${String(s.algorithmRecovery.fellBackToSearch)}</td></tr>
<tr><th>Unresolved at end of run</th><td>${String(s.algorithmRecovery.unresolved)}</td></tr>
</table>
<table>${statHead('Time in recovery before reacquisition')}<tbody>${statRow('Recovery time', s.algorithmRecovery.recoveryTime)}</tbody></table>`);
  }

  if (s.estimator !== undefined) {
    parts.push(`
<h2>Estimator</h2>
<p class="lede">Interacting multiple model: a nearly-constant-velocity and a nearly-constant-acceleration model run together, mixed each cycle by their transition probabilities and weighted by measurement likelihood. A rising acceleration-model probability is the estimator reporting a manoeuvre.</p>
<table class="kv">
<tr><th>Frames with model probabilities</th><td>${String(s.estimator.framesWithModelProbabilities)}</td></tr>
</table>
<table>${statHead('Acceleration-model probability while tracking')}<tbody>${statRow('NCA probability', s.estimator.caProbabilityWhileTracking, 4)}</tbody></table>`);
  }

  return parts.join('\n');
}

function document(inputs: DocumentInputs): string {
  const { manifest, summary, scenario, algorithm, notable, notableTotal, charts } = inputs;
  const m = manifest;
  const s = summary;
  const config = s.metricsConfig;

  const targets = Array.isArray(scenario['targets'])
    ? (scenario['targets'] as { label?: string; trajectory?: { kind?: string } }[])
    : [];
  const platform = scenario['platform'] as { baseDisturbanceRms?: number } | undefined;

  const detailText = (event: ExperimentEvent): string =>
    Object.entries(event.detail)
      .filter(([key]) => key !== 'runId' && key !== 'scenarioFingerprint')
      .map(([key, value]) =>
        typeof value === 'number' && !Number.isInteger(value)
          ? `${key}=${value.toFixed(4)}`
          : `${key}=${String(value)}`,
      )
      .join(' ');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>AstraLock-X run ${escape(m.runId)}</title>
<style>
:root { color-scheme: light; }
body { font: 13px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0 auto; padding: 28px 32px 60px; color: #18181b; background: #fff; max-width: 900px; }
h1 { font-size: 20px; margin: 0 0 4px; }
h2 { font-size: 13px; margin: 32px 0 8px; padding-bottom: 4px; border-bottom: 1px solid #e4e4e7; text-transform: uppercase; letter-spacing: .06em; color: #52525b; }
.lede { color: #52525b; margin: 0 0 14px; }
table { border-collapse: collapse; width: 100%; margin: 6px 0 14px; }
th, td { text-align: left; padding: 3px 8px; border-bottom: 1px solid #f4f4f5; vertical-align: top; }
th { font-weight: 600; color: #3f3f46; }
td { font-variant-numeric: tabular-nums; }
thead th { border-bottom: 1px solid #d4d4d8; font-size: 11px; text-transform: uppercase; letter-spacing: .04em; color: #71717a; }
.kv th { width: 34%; }
.sub, .unit { color: #a1a1aa; font-size: 11px; }
.absent { color: #a16207; font-style: italic; }
.status { display: inline-block; padding: 1px 8px; border-radius: 3px; font-weight: 600; font-size: 11px; text-transform: uppercase; letter-spacing: .05em; }
.completed { background: #dcfce7; color: #166534; }
.aborted { background: #fef3c7; color: #92400e; }
.failed, .incomplete { background: #fee2e2; color: #991b1b; }
.callout { border-left: 3px solid #d4d4d8; padding: 4px 10px; color: #3f3f46; background: #fafafa; margin: 8px 0; }
.truth { border-left-color: #f59e0b; }
figure { margin: 10px 0 20px; }
figcaption { font-size: 12px; font-weight: 600; color: #3f3f46; margin-bottom: 4px; }
figcaption .unit { font-weight: 400; }
.key { margin-left: 10px; text-transform: none; letter-spacing: 0; color: #52525b; }
.key i { display: inline-block; width: 9px; height: 9px; margin-right: 3px; border-radius: 2px; }
svg { width: 100%; height: auto; }
.axis { font-size: 9px; fill: #71717a; }
.grid { stroke: #f4f4f5; stroke-width: 1; }
.threshold { stroke: #16a34a; stroke-width: 1; stroke-dasharray: 4 3; }
.note { font-size: 11px; color: #71717a; margin: 2px 0 0; }
.empty { color: #a1a1aa; font-style: italic; }
footer { margin-top: 40px; padding-top: 12px; border-top: 1px solid #e4e4e7; color: #52525b; font-size: 11.5px; }
footer p { margin: 6px 0; }
code { background: #f4f4f5; padding: 1px 4px; border-radius: 3px; font-size: 11px; word-break: break-all; }
/* Units are never case-transformed: an uppercased µ is a Greek capital Mu, and µrad would read as mrad. */
.unit, .sub { text-transform: none; letter-spacing: 0; }
@media (max-width: 720px) {
  body { padding: 16px; }
  table { display: block; overflow-x: auto; }
}
</style>
</head>
<body>

<h1>AstraLock-X experiment report</h1>
<p class="lede">Run <code>${escape(m.runId)}</code> &middot; <span class="status ${escape(displayStatus(m.status))}">${escape(displayStatus(m.status))}</span> &middot; ${escape(m.terminationReason ?? 'no termination reason')}</p>
<p class="callout">A validation record of the Phase 4 baseline tracker in a clean, noiseless simulation. Not a benchmark claim. Every figure below was computed from the files in this run's directory and can be recomputed from them.</p>

<h2>Performance log</h2>
<table class="kv">
${performanceLog(s)
  .map(
    (entry) =>
      `<tr><th>${escape(entry.label)}</th><td>${show(entry.value, 3)}<br><span class="sub">${escape(entry.definition)} <code>${escape(entry.source)}</code></span></td></tr>`,
  )
  .join('\n')}
</table>

<h2>Provenance</h2>
<table class="kv">
<tr><th>AstraLock-X</th><td>${escape(m.host.applicationVersion)} &middot; commit ${m.host.sourceCommit === null ? '<span class="absent">unavailable</span>' : `<code>${escape(m.host.sourceCommit)}</code>`}${m.host.sourceTreeModified === true ? ' <span class="absent">with uncommitted changes — not exactly this commit</span>' : ''}</td></tr>
<tr><th>Recorded</th><td>${escape(m.host.createdAt)} <span class="sub">wall clock; ended ${escape(m.host.endedAt ?? 'never')}</span></td></tr>
<tr><th>Host platform</th><td>${escape(m.host.platform)}</td></tr>
<tr><th>Scenario</th><td>${escape(m.scenarioName)} <span class="sub">${escape(m.scenarioId ?? 'imported')} &middot; seed ${String(m.scenarioSeed)}</span></td></tr>
<tr><th>Designated target</th><td>${escape(m.designatedTargetLabel)} <span class="sub">index ${String(m.designatedTargetIndex)} of ${String(m.targetCount)}</span></td></tr>
<tr><th>Algorithm</th><td>${escape(m.algorithmId)} ${escape(m.algorithmVersion)}</td></tr>
<tr><th>Scenario fingerprint</th><td><code>${escape(m.scenarioFingerprint)}</code></td></tr>
<tr><th>Algorithm fingerprint</th><td><code>${escape(m.algorithmFingerprint)}</code></td></tr>
<tr><th>Metrics fingerprint</th><td><code>${escape(m.metricsFingerprint)}</code> <span class="sub">definition v${String(m.metricsDefinitionVersion)}, schema v${String(m.schemaVersion)}</span></td></tr>
</table>

<h2>Physical configuration</h2>
<table class="kv">
<tr><th>Simulation</th><td>${String(m.tickRate)} Hz fixed step (${(m.simulationTimestepSeconds * 1000).toFixed(3)} ms) &middot; recorded ${inputs.t0.toFixed(3)}–${inputs.t1.toFixed(3)} s</td></tr>
<tr><th>Camera</th><td>${String(m.camera.width)}×${String(m.camera.height)} px &middot; ${(m.camera.horizontalFovRad * DEG).toFixed(2)}° horizontal FOV &middot; ${String(m.camera.frameRate)} fps &middot; principal point (${m.camera.principalPointXPx.toFixed(1)}, ${m.camera.principalPointYPx.toFixed(1)}) px</td></tr>
<tr><th>Gimbal</th><td>pan ${(m.gimbal.panMinRad * DEG).toFixed(1)}° to ${(m.gimbal.panMaxRad * DEG).toFixed(1)}°, ≤ ${(m.gimbal.panMaxRateRadS * DEG).toFixed(1)}°/s &middot; tilt ${(m.gimbal.tiltMinRad * DEG).toFixed(1)}° to ${(m.gimbal.tiltMaxRad * DEG).toFixed(1)}°, ≤ ${(m.gimbal.tiltMaxRateRadS * DEG).toFixed(1)}°/s &middot; command latency ${(m.gimbal.commandLatencySeconds * 1000).toFixed(1)} ms</td></tr>
<tr><th>Targets</th><td>${targets.map((t, i) => `${escape(t.label ?? `target ${String(i)}`)} <span class="sub">${escape(t.trajectory?.kind ?? '')}</span>`).join('<br>')}</td></tr>
<tr><th>Platform disturbance</th><td>${platform?.baseDisturbanceRms === undefined ? '<span class="absent">not specified</span>' : `${String(platform.baseDisturbanceRms)} rad RMS`}</td></tr>
<tr><th>Sensor noise, atmosphere</th><td><span class="absent">Not modelled</span> <span class="sub">The sensor is noiseless and no atmospheric disturbance is applied in this phase.</span></td></tr>
</table>

<h2>Algorithm configuration</h2>
<table class="kv">
${flatten(algorithm)
  .map(([key, value]) => `<tr><th><code>${escape(key)}</code></th><td>${escape(value)}</td></tr>`)
  .join('\n')}
</table>

<h2>Outcome and acquisition</h2>
<table class="kv">
<tr><th>Termination</th><td>${escape(s.terminationReason ?? '—')}</td></tr>
<tr><th>Acquisition outcome</th><td>${escape(s.acquisitionOutcome)}</td></tr>
<tr><th>T<sub>search start</sub></th><td>${show(s.searchStartTime)}</td></tr>
<tr><th>T<sub>first detection</sub> <span class="sub">(of the designated target)</span></th><td>${show(s.firstDetectionTime)} <span class="sub">time to first detection ${show(s.timeToFirstDetection)}</span></td></tr>
<tr><th>T<sub>TRACK entry</sub></th><td>${show(s.trackEntryTime)} <span class="sub">time to TRACK ${show(s.timeToTrack)}</span></td></tr>
<tr><th>T<sub>coarse lock</sub></th><td>${show(s.coarseLockTime)}</td></tr>
<tr><th><strong>Coarse acquisition time</strong></th><td><strong>${show(s.coarseAcquisitionTime)}</strong> <span class="sub">T<sub>coarse lock</sub> − T<sub>search start</sub></span></td></tr>
</table>

<h2>Tracking accuracy</h2>
<p class="callout truth">Evaluation: computed from ground truth after the run. The tracker never had access to these quantities. <em>Whole run</em> includes search, when the target is typically far outside the field of view; <em>post-acquisition</em> is every sample from the first coarse lock on, including any later loss; <em>TRACK state</em> is only samples where the algorithm reported TRACK and is not whole-run accuracy.</p>
<table>
${statHead('Angular pointing error')}
<tbody>
${statRow('Whole run', s.angularPointingError.wholeRun)}
${statRow('Post-acquisition', s.angularPointingError.postAcquisition)}
${statRow('TRACK state', s.angularPointingError.trackState)}
</tbody>
</table>
<table>
${statHead('Image-space pointing error')}
<tbody>
${statRow('Whole run', s.imagePointingError.wholeRun)}
${statRow('Post-acquisition', s.imagePointingError.postAcquisition)}
${statRow('TRACK state', s.imagePointingError.trackState)}
</tbody>
</table>
<table>
${statHead('Detector diagnostic')}
<tbody>
${statRow('Centroid error vs true centre', s.detectorCentroidError)}
</tbody>
</table>
<p class="note">Frames with the target in the image but no detection: ${String(s.detectorMissesWithTargetInImage)}.</p>

${charts.join('\n')}

<h2>Lock retention</h2>
<table class="kv">
<tr><th>Lock retention rate</th><td>${show(s.lockRetentionRate)} <span class="sub">${escape(s.lockRetentionStatus)}</span></td></tr>
<tr><th>Locked duration (numerator)</th><td>${show(s.lockedDurationSeconds)}</td></tr>
<tr><th>Trackable opportunity (denominator)</th><td>${show(s.trackableOpportunitySeconds)}</td></tr>
<tr><th>TRACK claimed without lock</th><td>${show(s.trackClaimedWithoutLockSeconds)} <span class="sub">time in TRACK while the lock condition did not hold; not a false lock</span></td></tr>
</table>

<h2>Loss of lock and reacquisition</h2>
<table class="kv">
<tr><th>Loss-of-lock episodes</th><td>${String(s.lossOfLockEpisodes)}</td></tr>
<tr><th>Reacquired</th><td>${String(s.reacquisitionCount)}</td></tr>
<tr><th>Unrecovered (censored at end of run)</th><td>${String(s.unrecoveredLosses)}</td></tr>
</table>
${
  s.episodes.length === 0
    ? '<p class="note">No loss of lock was recorded.</p>'
    : `<table><thead><tr><th>#</th><th>Lost at</th><th>Re-locked at</th><th>Duration</th></tr></thead><tbody>${s.episodes
        .map(
          (e, i) =>
            `<tr><td>${String(i + 1)}</td><td>${e.lost_at_s.toFixed(3)} s</td><td>${e.recovered_at_s === null ? '<span class="absent">never — unrecovered</span>' : `${e.recovered_at_s.toFixed(3)} s`}</td><td>${e.duration_s === null ? '<span class="absent">censored</span>' : `${e.duration_s.toFixed(3)} s`}</td></tr>`,
        )
        .join('')}</tbody></table>`
}
<table>${statHead('Reacquisition time')}<tbody>${statRow('Recovered episodes only', s.reacquisitionTime)}</tbody></table>

<h2>False lock on a wrong source</h2>
<table class="kv">
<tr><th>Challenge exercised</th><td>${s.falseLockExercised ? 'Yes — a non-designated emitter was in the image during the run.' : '<strong>Not exercised.</strong> No non-designated emitter was ever in the image, so wrong-target identification was never tested. The count below is not evidence of identity robustness.'}</td></tr>
<tr><th>Episodes</th><td>${String(s.falseLockEpisodes)}</td></tr>
<tr><th>Duration</th><td>${show(s.falseLockDurationSeconds)}</td></tr>
<tr><th>Rate (of time in TRACK)</th><td>${show(s.falseLockRate)}</td></tr>
</table>

${robustSections(s)}
<h2>Frame statistics</h2>
<p class="note">Four different quantities that all get called "FPS", kept apart: what the camera was <em>configured</em> to do, how many frames were actually <em>generated</em>, the <em>window</em> those frames were counted over, and the <em>observed</em> rate that results. The rates are counts divided by the window and nothing else — no smoothing, and no substitution of the configured figure when the observed one is awkward.</p>
<table class="kv">
<tr><th>Configured sensor rate</th><td>${show(s.configuredSensorFps, 1)} <span class="sub">What the camera was asked for, not a measurement.</span></td></tr>
<tr><th>Measurement window</th><td>${show(s.autonomousDurationSeconds)} <span class="sub">Autonomous operation only. Frames captured before autonomy was enabled are not counted, and neither is the time.</span></td></tr>
<tr><th>Sensor frames generated</th><td>${String(s.sensorFramesGenerated)}</td></tr>
<tr><th>Observed sensor rate</th><td>${rateCell(s.effectiveSensorFps, s.autonomousDurationSeconds, s.sensorFramesGenerated, 'frames')}</td></tr>
<tr><th>Algorithm frames processed</th><td>${String(s.algorithmFramesProcessed)}</td></tr>
<tr><th>Observed algorithm rate</th><td>${rateCell(s.algorithmProcessedFps, s.autonomousDurationSeconds, s.algorithmFramesProcessed, 'frames processed')}</td></tr>
<tr><th>Display FPS</th><td><span class="absent">Not measured</span> <span class="sub">The report describes the simulation, not the interface.</span></td></tr>
<tr><th>Commands</th><td>${String(s.commandsIssued)} issued &middot; ${String(s.commandsApplied)} applied &middot; ${String(s.commandsPendingAtEnd)} still in flight at the end</td></tr>
</table>

<h2>Host processing time</h2>
<p class="callout"><strong>Not</strong> simulated control latency. Wall-clock time on the machine that ran the experiment, measured with the host's monotonic timer. The simulation models algorithm compute as taking zero simulated time, and these figures never affect commands, simulated time or any state hash. They will differ on every machine and every run.</p>
<p class="note">Host timer resolution: ${m.host.timerResolutionMs === null ? '<span class="absent">not measured</span>' : `${m.host.timerResolutionMs < 0.01 ? m.host.timerResolutionMs.toExponential(1) : m.host.timerResolutionMs.toFixed(3)} ms`}.${m.host.timerResolutionMs !== null && m.host.timerResolutionMs >= 0.1 ? ' This runtime coarsens its timer: a stage shorter than the resolution reads as 0 ms on an individual frame, and medians and percentiles are quantised to it. Means over many frames remain informative.' : ''}</p>
<table>
${statHead('Stage (per processed frame)')}
<tbody>
${statRow('World and mount step', s.hostProcessingTime.worldStep)}
${statRow('Sensor frame generation', s.hostProcessingTime.sensorFrameGeneration)}
${statRow('Detector', s.hostProcessingTime.detector)}
${statRow('Pixel → bearing transform', s.hostProcessingTime.bearingTransform)}
${statRow('Kalman estimator', s.hostProcessingTime.estimator)}
${statRow('Controller (PID or scan)', s.hostProcessingTime.controller)}
${statRow('Algorithm total', s.hostProcessingTime.algorithmTotal)}
${statRow('Runtime orchestration', s.hostProcessingTime.runtimeOrchestration)}
</tbody>
</table>
<p class="note">A stage's n counts only frames on which that stage ran; the estimator does not run while searching.</p>

<h2>Simulation control latency</h2>
<p class="callout">Delays in <em>simulated</em> time, from the event log. Algorithm compute is modelled as zero after a frame becomes available, so capture → issue is the wait for the next physics tick boundary, and issue → application is the mount's command latency, read from the instant the mount actually applied each command.</p>
<table>
${statHead('Interval')}
<tbody>
${statRow('Frame capture → command issue', s.controlLatency.captureToIssue, 4)}
${statRow('Command issue → application', s.controlLatency.issueToApplication, 4)}
${statRow('Frame capture → application', s.controlLatency.captureToApplication, 4)}
${statRow('Scheduled → actual application', s.controlLatency.scheduledToActualApplication, 4)}
</tbody>
</table>

<h2>Unavailable values</h2>
${(() => {
  const absent = absentMeasurements(s);
  return absent.length === 0
    ? '<p class="note">Every measurement in the summary has a value.</p>'
    : `<table><thead><tr><th>Field</th><th>Status</th></tr></thead><tbody>${absent
        .map(
          ([path, status]) =>
            `<tr><td><code>${escape(path)}</code></td><td class="absent">${escape(status)}</td></tr>`,
        )
        .join('')}</tbody></table>`;
})()}

<h2>Event log</h2>
<table>
<thead><tr><th>#</th><th>Sim time</th><th>Event</th><th>Detail</th></tr></thead>
<tbody>
${notable.map((e) => `<tr><td>${String(e.sequence)}</td><td>${e.simulationTime.toFixed(3)} s</td><td>${escape(e.type)}</td><td class="sub">${escape(detailText(e))}</td></tr>`).join('\n')}
</tbody>
</table>
<p class="note">${notableTotal > notable.length ? `${String(notableTotal - notable.length)} further events are in ${RUN_FILES.events}. ` : ''}Per-command issue and application events are omitted here and are in ${RUN_FILES.events}.</p>

<footer>
<p><strong>Metric definitions</strong> (v${String(s.metricsDefinitionVersion)}; full text in docs/METRICS.md).</p>
<p><strong>Angular pointing error</strong>: the angle between the true optical axis and the true line of sight to the designated target, <code>atan2(|a×b|, a·b)</code>, which stays accurate near zero where <code>acos</code> does not. <strong>Image-space error</strong>: distance from the true projected target centre to the principal point, defined only when the target projects into the image. <strong>Detector centroid error</strong>: distance from the detected centroid to the true projected centre; a detector diagnostic, not pointing accuracy.</p>
<p><strong>Coarse lock</strong>: pointing error ≤ ${(config.lockErrorThresholdRad * 1e6).toFixed(0)} µrad, target within the mount's travel and within ${String(config.maxTrackableRangeM)} m, and algorithm in TRACK — held at every sample for ≥ ${config.lockDwellSeconds.toFixed(3)} s. Once locked, a lapse regained within ${config.lockDropoutGraceSeconds.toFixed(3)} s is bridged; a longer one is a loss starting where the lapse began. Evaluator-only: the tracker never sees it.</p>
<p><strong>First detection</strong>: the first frame with a candidate within ${String(config.detectionAssociationRadiusPx)} px of the designated target's true projected centre and no other emitter nearer.</p>
<p><strong>Lock retention</strong> = locked time ÷ trackable time, both integrated by zero-order hold on the earlier sample over intervals starting at or after first coarse lock while the target was within travel and range. Time pointed the wrong way stays in the denominator. No acquisition gives 0; no trackable opportunity gives N/A.</p>
<p><strong>False lock</strong>: time in TRACK with the selected detection nearer a non-designated emitter than the designated one. High pointing error alone is a loss of lock, not a false lock.</p>
<p><strong>Statistics</strong>: mean, root-mean-square, and linearly interpolated median and 95th percentile (type 7) over the stated window. <strong>N/A</strong>: meaningless in this context. <strong>Not modelled</strong>: the simulation does not model the physics. <strong>Not measured</strong>: modelled, but no sample existed. None is ever shown as a number.</p>
<p>Generated offline from the stored artifacts. No network resources are referenced.</p>
</footer>
</body>
</html>
`;
}
