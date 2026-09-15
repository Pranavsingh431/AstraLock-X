/**
 * The offline benchmark report.
 *
 * One self-contained HTML file, generated from the persisted aggregate and
 * manifest. No CDN, no fonts fetched, no script that phones anywhere: the file
 * opens from a USB stick on a machine with no network, which is the only kind
 * of report an engineering result should be.
 *
 * Every number in it comes from `aggregate.json`, which was computed from the
 * runs' own artifacts. Nothing is calculated here that is not also stored, so a
 * reader can check the document against the data rather than trusting the
 * renderer.
 *
 * ## What it refuses to do
 *
 * There is no overall score and no winner badge. A composite of acquisition
 * time, pointing error and retention requires exchange rates between seconds,
 * microradians and a fraction, and there are none — a weight would invent them
 * and hide the invention inside a constant. The report shows metric-specific
 * results, the per-seed differences behind them, and a count of the seeds each
 * arm was better on.
 *
 * Plots are drawn from the stored samples as points and step functions. There
 * is no kernel smoothing: with five seeds a smooth density is a picture of the
 * smoother, not of the data.
 */

import type {
  ArmAggregate,
  BenchmarkAggregate,
  CaseAggregate,
  Distribution,
  PairedComparison,
} from './aggregate';
import { BENCHMARK_METRICS } from './aggregate';
import type { BenchmarkManifest } from './schema';

const escape = (text: string): string =>
  text.replace(
    /[&<>"']/g,
    (character) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]!,
  );

/** A number for display, or a marked absence. Never a fabricated zero. */
function show(value: number | null, digits = 3): string {
  if (value === null) return '<span class="absent">N/A</span>';
  const magnitude = Math.abs(value);
  if (magnitude !== 0 && (magnitude >= 1e5 || magnitude < 1e-3)) {
    return escape(value.toExponential(2));
  }
  return escape(value.toFixed(digits));
}

const percent = (value: number | null): string =>
  value === null ? '<span class="absent">N/A</span>' : `${(value * 100).toFixed(0)}%`;

// --- Plots ------------------------------------------------------------------

const PLOT = { width: 420, height: 170, left: 52, right: 12, top: 12, bottom: 28 };

/**
 * An empirical CDF, drawn as the step function it is.
 *
 * Each sample is one step, and the points are marked. With five seeds that
 * looks like five steps, which is exactly how much the data supports.
 */
function cdfPlot(
  title: string,
  unit: string,
  series: readonly { label: string; colour: string; distribution: Distribution }[],
): string {
  const all = series.flatMap((entry) => entry.distribution.values);
  if (all.length === 0) {
    return `<figure><figcaption>${escape(title)}</figcaption><p class="empty">No samples.</p></figure>`;
  }

  const min = Math.min(...all);
  const max = Math.max(...all);
  const span = max - min || Math.abs(max) || 1;
  const lo = min - span * 0.05;
  const hi = max + span * 0.05;
  const px = (value: number): number =>
    PLOT.left + ((value - lo) / (hi - lo)) * (PLOT.width - PLOT.left - PLOT.right);
  const py = (fraction: number): number =>
    PLOT.height - PLOT.bottom - fraction * (PLOT.height - PLOT.top - PLOT.bottom);

  const paths = series
    .filter((entry) => entry.distribution.values.length > 0)
    .map((entry) => {
      const sorted = [...entry.distribution.values].sort((a, b) => a - b);
      const steps: string[] = [`M ${px(lo).toFixed(1)} ${py(0).toFixed(1)}`];
      sorted.forEach((value, index) => {
        const fraction = (index + 1) / sorted.length;
        steps.push(`L ${px(value).toFixed(1)} ${py(index / sorted.length).toFixed(1)}`);
        steps.push(`L ${px(value).toFixed(1)} ${py(fraction).toFixed(1)}`);
      });
      steps.push(`L ${px(hi).toFixed(1)} ${py(1).toFixed(1)}`);
      const dots = sorted
        .map(
          (value, index) =>
            `<circle cx="${px(value).toFixed(1)}" cy="${py((index + 1) / sorted.length).toFixed(1)}" r="2.2" fill="${entry.colour}"/>`,
        )
        .join('');
      return `<path d="${steps.join(' ')}" fill="none" stroke="${entry.colour}" stroke-width="1.6"/>${dots}`;
    })
    .join('');

  const ticks = [0, 0.5, 1]
    .map(
      (fraction) =>
        `<line x1="${String(PLOT.left)}" x2="${String(PLOT.width - PLOT.right)}" y1="${py(fraction).toFixed(1)}" y2="${py(fraction).toFixed(1)}" class="grid"/>` +
        `<text x="${String(PLOT.left - 6)}" y="${(py(fraction) + 3).toFixed(1)}" class="axis" text-anchor="end">${fraction.toFixed(1)}</text>`,
    )
    .join('');

  const xTicks = [lo, (lo + hi) / 2, hi]
    .map(
      (value) =>
        `<text x="${px(value).toFixed(1)}" y="${String(PLOT.height - 8)}" class="axis" text-anchor="middle">${escape(value.toPrecision(3))}</text>`,
    )
    .join('');

  const legend = series
    .map(
      (entry) =>
        `<span class="key"><i style="background:${entry.colour}"></i>${escape(entry.label)} (n=${String(entry.distribution.count)})</span>`,
    )
    .join(' ');

  return `<figure>
<figcaption>${escape(title)} <span class="unit">[${escape(unit)}]</span> ${legend}</figcaption>
<svg viewBox="0 0 ${String(PLOT.width)} ${String(PLOT.height)}" role="img" aria-label="${escape(title)}">
${ticks}${paths}${xTicks}
</svg>
<p class="note">Empirical CDF: one step per run, points marked. No smoothing — with this many samples a smooth curve would be a picture of the smoother.</p>
</figure>`;
}

/** Per-seed paired differences, as a dot per seed about a zero line. */
function pairedPlot(comparison: PairedComparison): string {
  const deltas = comparison.differences.filter(
    (difference): difference is typeof difference & { delta: number } => difference.delta !== null,
  );
  if (deltas.length === 0) {
    return `<p class="empty">No seed produced a value for both arms.</p>`;
  }

  const magnitude = Math.max(...deltas.map((d) => Math.abs(d.delta))) || 1;
  const width = 420;
  const height = 92;
  const px = (value: number): number => width / 2 + (value / (magnitude * 1.15)) * (width / 2 - 40);
  const dots = deltas
    .map((difference, index) => {
      const y = 26 + (index * 40) / Math.max(1, deltas.length - 1);
      const colour =
        difference.better === 'candidate'
          ? '#15803d'
          : difference.better === 'baseline'
            ? '#b91c1c'
            : '#64748b';
      return (
        `<line x1="${(width / 2).toFixed(1)}" x2="${px(difference.delta).toFixed(1)}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" stroke="${colour}" stroke-width="1"/>` +
        `<circle cx="${px(difference.delta).toFixed(1)}" cy="${y.toFixed(1)}" r="3" fill="${colour}"><title>seed ${String(difference.seed)}: ${difference.delta.toPrecision(4)}</title></circle>`
      );
    })
    .join('');

  return `<figure>
<svg viewBox="0 0 ${String(width)} ${String(height)}" role="img" aria-label="Per-seed differences">
<line x1="${(width / 2).toFixed(1)}" x2="${(width / 2).toFixed(1)}" y1="14" y2="72" class="grid"/>
<text x="${(width / 2).toFixed(1)}" y="86" class="axis" text-anchor="middle">0</text>
<text x="20" y="86" class="axis">${escape((-magnitude).toPrecision(3))}</text>
<text x="${String(width - 20)}" y="86" class="axis" text-anchor="end">${escape(magnitude.toPrecision(3))}</text>
${dots}
</svg>
<p class="note">One dot per seed: ${escape(comparison.candidateArmId)} minus ${escape(comparison.baselineArmId)}, in ${escape(comparison.unit)}. Green where ${escape(comparison.candidateArmId)} was better.</p>
</figure>`;
}

// --- Tables -----------------------------------------------------------------

const ARM_COLOURS = ['#1d4ed8', '#b45309', '#0f766e', '#7c3aed'];

function armRow(arm: ArmAggregate): string {
  const metric = (key: string): Distribution | undefined => arm.metrics[key];
  return `<tr>
<th>${escape(arm.label)}<span class="sub">${escape(arm.algorithmId)} ${escape(arm.algorithmVersion)}</span></th>
<td>${String(arm.attempted)}</td>
<td>${String(arm.completed)}</td>
<td class="${arm.failed > 0 ? 'bad' : ''}">${String(arm.failed)}</td>
<td>${String(arm.cancelled)}</td>
<td>${String(arm.acquired)}</td>
<td><strong>${percent(arm.successRate)}</strong> <span class="sub">${String(arm.succeeded)}/${String(arm.completed)}</span></td>
<td>${show(metric('acquisitionTimeS')?.median ?? null, 2)}</td>
<td>${show(metric('rmsPointingErrorUrad')?.median ?? null, 0)}</td>
<td>${show(metric('rmsPointingErrorUrad')?.p95 ?? null, 0)}</td>
<td>${show(metric('lockRetentionRate')?.median ?? null, 3)}</td>
<td>${String(arm.falseLockRuns)}</td>
<td>${String(arm.unrecoveredLossRuns)}</td>
<td>${String(arm.handoffReadyRuns)}</td>
</tr>`;
}

function caseSection(benchmarkCase: CaseAggregate): string {
  const invalid = benchmarkCase.comparison.valid
    ? ''
    : `<p class="invalid"><strong>${escape(benchmarkCase.comparison.reason ?? 'INVALID')}</strong> — ${escape(benchmarkCase.comparison.detail ?? '')} No comparison is drawn for this case.</p>`;

  const series = (key: string) =>
    benchmarkCase.arms.map((arm, index) => ({
      label: arm.label,
      colour: ARM_COLOURS[index % ARM_COLOURS.length]!,
      distribution: arm.metrics[key] ?? {
        values: [],
        missing: 0,
        count: 0,
        mean: null,
        median: null,
        p95: null,
        min: null,
        max: null,
      },
    }));

  const paired = benchmarkCase.paired
    .filter((comparison) => comparison.differences.some((d) => d.delta !== null))
    .map(
      (comparison) => `<div class="paired">
<h4>${escape(comparison.metricLabel)} <span class="unit">[${escape(comparison.unit)}]</span></h4>
<p class="tally">${escape(comparison.candidateArmId)} better on <strong>${String(comparison.candidateBetter)}</strong> of ${String(comparison.differences.length)} seeds &middot; ${escape(comparison.baselineArmId)} better on <strong>${String(comparison.baselineBetter)}</strong> &middot; ${String(comparison.ties)} tied &middot; ${String(comparison.undecided)} undecided</p>
${pairedPlot(comparison)}
<table class="seeds"><thead><tr><th>Seed</th><th>${escape(comparison.baselineArmId)}</th><th>${escape(comparison.candidateArmId)}</th><th>Δ</th><th>Better</th></tr></thead><tbody>
${comparison.differences
  .map(
    (difference) =>
      `<tr><td>${String(difference.seed)}</td><td>${show(difference.baseline, 3)}</td><td>${show(difference.candidate, 3)}</td><td>${show(difference.delta, 3)}</td><td>${difference.better === null ? '<span class="absent">—</span>' : escape(difference.better)}</td></tr>`,
  )
  .join('')}
</tbody></table>
</div>`,
    )
    .join('');

  return `<section>
<h2>${escape(benchmarkCase.label)}</h2>
<p class="meta">Scenario <code>${escape(benchmarkCase.scenarioId)}</code> &middot; seeds ${benchmarkCase.seeds.map(String).map(escape).join(', ')} &middot; success = ${escape(benchmarkCase.successCriterion)}</p>
${invalid}
<table class="arms">
<thead><tr><th>Arm</th><th>Att.</th><th>Comp.</th><th>Fail</th><th>Canc.</th><th>Acq.</th><th>Success</th><th>Median acq (s)</th><th>Median RMS (µrad)</th><th>P95 RMS (µrad)</th><th>Median retention</th><th>False-lock runs</th><th>Unrecovered</th><th>Handoff runs</th></tr></thead>
<tbody>${benchmarkCase.arms.map(armRow).join('')}</tbody>
</table>
<div class="plots">
${cdfPlot('Pointing error (RMS, post-acquisition)', 'µrad', series('rmsPointingErrorUrad'))}
${cdfPlot('Coarse acquisition time', 's', series('acquisitionTimeS'))}
${cdfPlot('Lock retention', '1', series('lockRetentionRate'))}
</div>
${paired === '' ? '' : `<h3>Paired, seed by seed</h3>${paired}`}
</section>`;
}

/** Renders the whole report. */
export function renderBenchmarkReport(
  aggregate: BenchmarkAggregate,
  manifest: BenchmarkManifest,
): string {
  const failures = manifest.runs.filter((run) => run.status !== 'completed');

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>AstraBench — ${escape(aggregate.suiteName)}</title>
<style>
:root { color-scheme: light; }
body { font: 13px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; margin: 0; padding: 32px; color: #0f172a; background: #f8fafc; }
main { max-width: 1120px; margin: 0 auto; }
h1 { font-size: 22px; margin: 0 0 4px; }
h2 { font-size: 16px; margin: 32px 0 6px; padding-top: 16px; border-top: 1px solid #e2e8f0; }
h3 { font-size: 13px; margin: 20px 0 8px; text-transform: uppercase; letter-spacing: .04em; color: #475569; }
h4 { font-size: 12px; margin: 14px 0 4px; }
table { border-collapse: collapse; width: 100%; margin: 10px 0; font-variant-numeric: tabular-nums; }
th, td { border: 1px solid #e2e8f0; padding: 4px 7px; text-align: right; }
th:first-child, td:first-child { text-align: left; }
thead th { background: #f1f5f9; font-weight: 600; font-size: 11px; }
table.kv th { width: 220px; background: #f8fafc; }
table.kv td { text-align: left; }
.sub { display: block; font-size: 10px; color: #64748b; font-weight: 400; }
.meta { color: #475569; font-size: 12px; margin: 0 0 8px; }
.note { color: #64748b; font-size: 11px; margin: 4px 0 0; }
.absent { color: #94a3b8; font-style: italic; }
.bad { color: #b91c1c; font-weight: 600; }
.invalid { background: #fef2f2; border: 1px solid #fecaca; color: #991b1b; padding: 8px 10px; border-radius: 4px; }
.callout { background: #eff6ff; border: 1px solid #bfdbfe; padding: 10px 12px; border-radius: 4px; }
.plots { display: flex; flex-wrap: wrap; gap: 16px; }
figure { margin: 8px 0; flex: 1 1 380px; }
figcaption { font-size: 11px; color: #334155; margin-bottom: 4px; }
.unit { color: #64748b; }
.key { display: inline-flex; align-items: center; gap: 4px; margin-left: 8px; font-size: 10px; }
.key i { width: 9px; height: 9px; border-radius: 2px; display: inline-block; }
.grid { stroke: #e2e8f0; stroke-width: 1; }
.axis { font-size: 9px; fill: #64748b; }
.empty { color: #94a3b8; font-style: italic; font-size: 11px; }
.tally { font-size: 12px; margin: 2px 0 6px; }
.paired { border-left: 2px solid #e2e8f0; padding-left: 12px; margin: 12px 0; }
table.seeds { max-width: 560px; }
code { background: #f1f5f9; padding: 1px 4px; border-radius: 3px; font-size: 11px; }
footer { margin-top: 36px; padding-top: 12px; border-top: 1px solid #e2e8f0; color: #64748b; font-size: 11px; }
</style>
</head>
<body>
<main>
<h1>AstraBench — ${escape(aggregate.suiteName)}</h1>
<p class="meta">Benchmark <code>${escape(aggregate.benchmarkId)}</code> &middot; suite <code>${escape(aggregate.suiteId)}</code> &middot; status <strong>${escape(aggregate.status)}</strong></p>

<h3>Provenance</h3>
<table class="kv">
<tr><th>Suite fingerprint</th><td><code>${escape(aggregate.suiteFingerprint)}</code></td></tr>
<tr><th>Started</th><td>${escape(manifest.startedAt)}</td></tr>
<tr><th>Finished</th><td>${manifest.finishedAt === null ? '<span class="absent">not finished</span>' : escape(manifest.finishedAt)}</td></tr>
<tr><th>Application</th><td>${escape(manifest.applicationVersion)}${manifest.sourceCommit === null ? '' : ` &middot; <code>${escape(manifest.sourceCommit)}</code>`}</td></tr>
<tr><th>Platform</th><td>${escape(manifest.platform)}</td></tr>
<tr><th>Runs</th><td>${String(aggregate.completed)} completed, ${String(aggregate.failed)} failed, ${String(aggregate.cancelled)} cancelled, of ${String(aggregate.plannedRuns)} planned</td></tr>
</table>

<p class="callout"><strong>How to read this.</strong> Every arm of a case was flown against identical physics — same scenario, same seed, same disturbance realization — and scored by the same evaluator under one set of metric definitions. Both facts are checked by fingerprint, and a case whose arms disagree is marked invalid rather than reduced to a winner. There is deliberately no overall score: seconds, microradians and a retention fraction have no exchange rate, so a composite would invent one.</p>

${aggregate.cases.map(caseSection).join('')}

<h2>Runs that did not complete</h2>
${
  failures.length === 0
    ? '<p class="note">Every planned run completed.</p>'
    : `<table><thead><tr><th>Case</th><th>Seed</th><th>Arm</th><th>Status</th><th>Run</th><th>Detail</th></tr></thead><tbody>${failures
        .map(
          (run) =>
            `<tr><td>${escape(run.caseId)}</td><td>${String(run.seed)}</td><td>${escape(run.armId)}</td><td class="bad">${escape(run.status)}</td><td><code>${escape(run.runId)}</code></td><td>${run.error === null ? '<span class="absent">—</span>' : escape(run.error)}</td></tr>`,
        )
        .join('')}</tbody></table>
<p class="note">Listed rather than dropped. A suite that omitted its failures would report the success rate of the runs that succeeded, which is always 100%.</p>`
}

<h2>Definitions</h2>
<p><strong>Attempted / completed / failed / cancelled</strong>: every planned run is in exactly one of these, and the aggregate only draws numbers from completed ones.</p>
<p><strong>Success</strong>: the criterion named under each case, declared in the suite before execution.</p>
<p><strong>N/A</strong>: the metric was not defined for that run — a pointing error with no acquisition, a reacquisition time with no loss. Never rendered as zero.</p>
<p><strong>Δ</strong>: candidate minus baseline for one seed. Absent when either side has no value; a one-sided difference is not a small difference.</p>
<p><strong>Median / P95</strong>: linear interpolation on the sorted sample, the same definition the per-run reports use.</p>

<footer>Generated offline by AstraBench from <code>aggregate.json</code> and <code>manifest.json</code>. Every figure is recomputable from the runs' own artifacts with <code>recomputeBenchmark</code>. Metrics: ${BENCHMARK_METRICS.map((m) => escape(m.label)).join(', ')}.</footer>
</main>
</body>
</html>
`;
}
