/**
 * The AstraBench workspace.
 *
 * Choose a suite, see exactly what it will run before running it, run it, watch
 * real progress, and read the comparison it produced.
 *
 * Everything on this screen is a number that came from somewhere. The run count
 * is arithmetic over the suite; the progress counters are the runner's own; the
 * results table is read back from `aggregate.json` after the suite finishes,
 * not accumulated in React as it goes. There is no placeholder card, no
 * animated bar that is not tracking anything, and no estimated time that is not
 * derived from runs that have actually completed.
 *
 * The design rule the screen follows is that the *preflight* is as prominent as
 * the result. A benchmark is only worth reading if you know what it ran, so the
 * suite, its arms, its seeds and its run count are on screen before the button
 * is pressed, and the fairness fingerprints are on screen after.
 */

import { AlertTriangle, CircleStop, Play, RefreshCw, ShieldCheck } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { algorithmById } from '@/core/algorithms';
import {
  BENCHMARK_SUITES,
  recomputeBenchmark,
  runBenchmark,
  totalRuns,
  type BenchmarkAggregate,
  type BenchmarkManifest,
  type BenchmarkProgress,
  type BenchmarkSuite,
  type CaseAggregate,
} from '@/core/benchmark';
import { createBenchmarkStorage, createStorage, isTauri } from '@/core/experiments';
import { readAppInfo } from '@/lib/app-info';
import { EmptyState, Panel, PanelHeader, StatusBadge, WarningBanner } from '@/components/astra';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

const runStorage = createStorage();
const benchmarkStorage = createBenchmarkStorage();

/** A benchmark identifier: sortable, and legal as a directory name. */
function newBenchmarkId(suite: BenchmarkSuite, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  return `bench-${stamp}-${suite.suiteId}`.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 96);
}

const number = (value: number | null, digits = 3): string =>
  value === null ? '—' : value.toFixed(digits);

const percent = (value: number | null): string =>
  value === null ? '—' : `${(value * 100).toFixed(0)}%`;

/**
 * Time remaining, from runs that have actually finished.
 *
 * `null` until at least one run has completed, because before that there is
 * nothing to extrapolate from and a number would be invented. Labelled as an
 * estimate wherever it is shown.
 */
function estimateRemaining(progress: BenchmarkProgress): string | null {
  const done = progress.completed + progress.failed;
  if (done === 0 || progress.remaining === 0) return null;
  const perRun = progress.elapsedMs / done;
  const seconds = Math.round((perRun * progress.remaining) / 1000);
  if (seconds < 60) return `~${String(seconds)} s`;
  return `~${String(Math.round(seconds / 60))} min`;
}

export function AstraBenchView(): React.JSX.Element {
  const [suiteId, setSuiteId] = useState(BENCHMARK_SUITES[0]!.suiteId);
  const [progress, setProgress] = useState<BenchmarkProgress | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aggregate, setAggregate] = useState<BenchmarkAggregate | null>(null);
  const [manifest, setManifest] = useState<BenchmarkManifest | null>(null);
  const [verification, setVerification] = useState<string | null>(null);
  const controller = useRef<AbortController | null>(null);

  const suite = useMemo(
    () => BENCHMARK_SUITES.find((entry) => entry.suiteId === suiteId) ?? BENCHMARK_SUITES[0]!,
    [suiteId],
  );
  const planned = useMemo(() => totalRuns(suite), [suite]);

  useEffect(
    () => () => {
      controller.current?.abort();
    },
    [],
  );

  const start = useCallback(() => {
    if (running) return;
    setError(null);
    setVerification(null);
    setAggregate(null);
    setManifest(null);
    setRunning(true);

    const abort = new AbortController();
    controller.current = abort;
    const benchmarkId = newBenchmarkId(suite, new Date());
    const info = readAppInfo();

    void (async () => {
      try {
        const execution = await runBenchmark({
          suite,
          runStorage,
          benchmarkStorage,
          resolvePlugin: algorithmById,
          benchmarkId,
          applicationVersion: info.version,
          sourceCommit: info.sourceCommit,
          platform: typeof navigator === 'undefined' ? 'unknown' : navigator.userAgent,
          signal: abort.signal,
          onProgress: setProgress,
        });
        setAggregate(execution.aggregate);
        setManifest(execution.manifest);
      } catch (thrown) {
        setError(thrown instanceof Error ? thrown.message : String(thrown));
      } finally {
        setRunning(false);
        controller.current = null;
      }
    })();
  }, [running, suite]);

  const cancel = useCallback(() => {
    controller.current?.abort();
  }, []);

  /** Recomputes the stored aggregate from the runs' own artifacts. */
  const verify = useCallback(() => {
    if (manifest === null) return;
    setVerification('Recomputing…');
    void (async () => {
      try {
        const result = await recomputeBenchmark(benchmarkStorage, runStorage, manifest.benchmarkId);
        setVerification(
          result.differences.length === 0
            ? `Recomputed from the run artifacts: ${String(result.recomputed.completed)} completed runs, zero differences.`
            : `${String(result.differences.length)} difference(s): ${result.differences
                .slice(0, 3)
                .map((d) => d.path)
                .join(', ')}`,
        );
      } catch (thrown) {
        setVerification(thrown instanceof Error ? thrown.message : String(thrown));
      }
    })();
  }, [manifest]);

  const unavailable = !isTauri();
  const remaining = progress === null ? null : estimateRemaining(progress);

  return (
    <div className="flex h-full min-h-0 flex-col gap-2 p-2">
      <Panel>
        <PanelHeader
          icon={ShieldCheck}
          title="AstraBench — deterministic comparison"
          subtitle="Identical physics per case, identical evaluator, fairness checked by fingerprint"
          actions={
            <StatusBadge
              status={running ? 'active' : aggregate === null ? 'idle' : 'nominal'}
              label={running ? 'Running' : aggregate === null ? 'No results' : 'Complete'}
              pulse={running}
            />
          }
        />
        <p className="max-w-4xl px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
          Every arm of a case is flown against identical physics — same scenario, same seed, same
          disturbance realization — and scored by the same evaluator. Both facts are checked by
          fingerprint, and a case whose arms disagree is reported as invalid rather than reduced to
          a winner. There is no overall score: seconds, microradians and a retention fraction have
          no exchange rate.
        </p>
      </Panel>

      {unavailable && (
        <WarningBanner tone="warning" icon={AlertTriangle}>
          Benchmarks write run artifacts, so they need the desktop application. A browser tab has
          nowhere durable to put them.
        </WarningBanner>
      )}

      <section className="rounded-sm border border-panel-border bg-panel-header p-3">
        <div className="flex flex-wrap items-end gap-4">
          <label className="flex flex-col gap-1 text-[10px] tracking-wider text-muted-foreground uppercase">
            Suite
            <select
              aria-label="Benchmark suite"
              value={suiteId}
              disabled={running}
              onChange={(event) => {
                setSuiteId(event.target.value);
              }}
              className="w-72 rounded-sm border border-panel-border bg-background px-2 py-1 text-[12px] text-foreground"
            >
              {BENCHMARK_SUITES.map((entry) => (
                <option key={entry.suiteId} value={entry.suiteId}>
                  {entry.name}
                </option>
              ))}
            </select>
          </label>

          <Field label="Cases" value={String(suite.cases.length)} />
          <Field
            label="Seeds"
            value={suite.cases[0]?.seeds.join(', ') ?? '—'}
            hint="Declared in source, before any result"
          />
          <Field
            label="Algorithms"
            value={String(
              new Set(suite.cases.flatMap((c) => c.arms.map((arm) => arm.algorithmId))).size,
            )}
          />
          <Field label="Total runs" value={String(planned)} hint="cases × seeds × arms" />

          <div className="ml-auto flex items-center gap-2">
            <Button size="sm" onClick={start} disabled={running || unavailable}>
              <Play className="size-3.5" /> Start benchmark
            </Button>
            <Button size="sm" variant="outline" onClick={cancel} disabled={!running}>
              <CircleStop className="size-3.5" /> Cancel
            </Button>
          </div>
        </div>

        <p className="mt-2 text-[11px] text-muted-foreground">{suite.description}</p>
      </section>

      {progress !== null && (
        <section
          className="rounded-sm border border-status-active/40 bg-status-active/10 p-3"
          aria-label="Benchmark progress"
        >
          <div className="flex flex-wrap items-center gap-4 text-[11px]">
            <span className="font-semibold tracking-wider text-status-active uppercase">
              {running ? 'Running' : 'Finished'}
            </span>
            <Field
              label="Completed"
              value={`${String(progress.completed)} / ${String(progress.total)}`}
            />
            <Field label="Failed" value={String(progress.failed)} />
            <Field label="Cancelled" value={String(progress.cancelled)} />
            <Field label="Remaining" value={String(progress.remaining)} />
            <Field label="Elapsed (host)" value={`${(progress.elapsedMs / 1000).toFixed(0)} s`} />
            {remaining !== null && running && (
              <Field label="Remaining (estimate)" value={remaining} hint="From completed runs" />
            )}
          </div>

          <div className="mt-2 h-1.5 w-full overflow-hidden rounded-sm bg-status-active/10">
            <div
              className="h-full bg-status-active transition-[width] duration-200"
              style={{
                width: `${String(
                  Math.round(
                    ((progress.completed + progress.failed + progress.cancelled) /
                      Math.max(1, progress.total)) *
                      100,
                  ),
                )}%`,
              }}
            />
          </div>

          <p className="mt-1.5 text-[11px] text-status-active">
            {progress.current === null
              ? 'Between runs.'
              : `${progress.current.caseId} · seed ${String(progress.current.seed)} · ${progress.current.armId} (${progress.current.algorithmId})`}
          </p>
        </section>
      )}

      {error !== null && <WarningBanner tone="fault">{error}</WarningBanner>}

      <ScrollArea className="min-h-0 flex-1">
        {aggregate === null ? (
          <EmptyState
            title="No results yet."
            hint="Results appear after a suite finishes, read back from the aggregate.json it wrote — not accumulated here while it ran."
          />
        ) : (
          <Results
            aggregate={aggregate}
            manifest={manifest}
            verification={verification}
            onVerify={verify}
          />
        )}
      </ScrollArea>
    </div>
  );
}

function Field({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] tracking-wider text-muted-foreground uppercase">{label}</span>
      <span className="tabular text-[12px] text-foreground/90">{value}</span>
      {hint !== undefined && <span className="text-[9px] text-muted-foreground">{hint}</span>}
    </div>
  );
}

function Results({
  aggregate,
  manifest,
  verification,
  onVerify,
}: {
  aggregate: BenchmarkAggregate;
  manifest: BenchmarkManifest | null;
  verification: string | null;
  onVerify: () => void;
}): React.JSX.Element {
  const failures = manifest?.runs.filter((run) => run.status !== 'completed') ?? [];

  return (
    <div className="space-y-4 p-1">
      <section className="flex flex-wrap items-center gap-4 rounded-sm border border-panel-border bg-panel-header px-3 py-2 text-[11px]">
        <Badge variant="outline" className="h-5 px-2 text-[10px] tracking-wider uppercase">
          {aggregate.status}
        </Badge>
        <Field
          label="Runs"
          value={`${String(aggregate.completed)} completed · ${String(aggregate.failed)} failed · ${String(aggregate.cancelled)} cancelled of ${String(aggregate.plannedRuns)}`}
        />
        <Button size="sm" variant="outline" className="ml-auto" onClick={onVerify}>
          <ShieldCheck className="size-3.5" /> Recompute from artifacts
        </Button>
      </section>

      {verification !== null && (
        <p className="rounded-sm border border-status-nominal/40 bg-status-nominal/10 px-3 py-2 text-[11px] text-status-nominal">
          <RefreshCw className="mr-1 inline size-3" />
          {verification}
        </p>
      )}

      {aggregate.cases.map((entry) => (
        <CaseTable key={entry.caseId} entry={entry} />
      ))}

      <section>
        <h3 className="mb-1 text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          Runs that did not complete
        </h3>
        {failures.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">Every planned run completed.</p>
        ) : (
          <table className="w-full border-collapse text-[11px]">
            <thead>
              <tr className="bg-muted/60 text-left">
                <th className="border border-panel-border/60 px-2 py-1">Case</th>
                <th className="border border-panel-border/60 px-2 py-1">Seed</th>
                <th className="border border-panel-border/60 px-2 py-1">Arm</th>
                <th className="border border-panel-border/60 px-2 py-1">Status</th>
                <th className="border border-panel-border/60 px-2 py-1">Run</th>
                <th className="border border-panel-border/60 px-2 py-1">Detail</th>
              </tr>
            </thead>
            <tbody>
              {failures.map((run) => (
                <tr key={run.runId}>
                  <td className="border border-panel-border/60 px-2 py-1">{run.caseId}</td>
                  <td className="tabular border border-panel-border/60 px-2 py-1">{run.seed}</td>
                  <td className="border border-panel-border/60 px-2 py-1">{run.armId}</td>
                  <td className="border border-panel-border/60 px-2 py-1 font-semibold text-status-fault">
                    {run.status}
                  </td>
                  <td className="border border-panel-border/60 px-2 py-1 font-mono text-[10px]">
                    {run.runId}
                  </td>
                  <td className="border border-panel-border/60 px-2 py-1">{run.error ?? '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function CaseTable({ entry }: { entry: CaseAggregate }): React.JSX.Element {
  return (
    <section>
      <h3 className="text-[12px] font-semibold">{entry.label}</h3>
      <p className="mb-1 text-[10px] text-muted-foreground">
        {entry.scenarioId} · seeds {entry.seeds.join(', ')} · success = {entry.successCriterion}
      </p>

      {!entry.comparison.valid && (
        <p className="mb-1 rounded-sm border border-status-fault/40 bg-status-fault/10 px-2 py-1 text-[11px] text-status-fault">
          <strong>{entry.comparison.reason}</strong> — {entry.comparison.detail} No comparison is
          drawn.
        </p>
      )}

      <table className="w-full border-collapse text-[11px]">
        <thead>
          <tr className="bg-muted/60 text-left">
            <th className="border border-panel-border/60 px-2 py-1">Arm</th>
            <th className="border border-panel-border/60 px-2 py-1">Comp.</th>
            <th className="border border-panel-border/60 px-2 py-1">Fail</th>
            <th className="border border-panel-border/60 px-2 py-1">Success</th>
            <th className="border border-panel-border/60 px-2 py-1">Median acq (s)</th>
            <th className="border border-panel-border/60 px-2 py-1">Median RMS (µrad)</th>
            <th className="border border-panel-border/60 px-2 py-1">P95 RMS (µrad)</th>
            <th className="border border-panel-border/60 px-2 py-1">Median retention</th>
            <th className="border border-panel-border/60 px-2 py-1">False-lock runs</th>
            <th className="border border-panel-border/60 px-2 py-1">Handoff runs</th>
          </tr>
        </thead>
        <tbody>
          {entry.arms.map((arm) => (
            <tr key={arm.armId}>
              <td className="border border-panel-border/60 px-2 py-1">{arm.label}</td>
              <td className="tabular border border-panel-border/60 px-2 py-1">{arm.completed}</td>
              <td
                className={cn(
                  'tabular border border-panel-border/60 px-2 py-1',
                  arm.failed > 0 && 'font-semibold text-status-fault',
                )}
              >
                {arm.failed}
              </td>
              <td className="tabular border border-panel-border/60 px-2 py-1">
                {percent(arm.successRate)}
              </td>
              <td className="tabular border border-panel-border/60 px-2 py-1">
                {number(arm.metrics['acquisitionTimeS']?.median ?? null, 2)}
              </td>
              <td className="tabular border border-panel-border/60 px-2 py-1">
                {number(arm.metrics['rmsPointingErrorUrad']?.median ?? null, 0)}
              </td>
              <td className="tabular border border-panel-border/60 px-2 py-1">
                {number(arm.metrics['rmsPointingErrorUrad']?.p95 ?? null, 0)}
              </td>
              <td className="tabular border border-panel-border/60 px-2 py-1">
                {number(arm.metrics['lockRetentionRate']?.median ?? null, 3)}
              </td>
              <td className="tabular border border-panel-border/60 px-2 py-1">
                {arm.falseLockRuns}
              </td>
              <td className="tabular border border-panel-border/60 px-2 py-1">
                {arm.handoffReadyRuns}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {entry.paired.length > 0 && <PairedSummary entry={entry} />}
    </section>
  );
}

/**
 * The paired view: which arm was better on each seed, per metric.
 *
 * A count of seeds rather than a verdict. "Better on four of five seeds for
 * retention" is a statement the data supports; a single winner badge over a
 * weighted composite is not.
 */
function PairedSummary({ entry }: { entry: CaseAggregate }): React.JSX.Element {
  const interesting = entry.paired.filter((comparison) =>
    comparison.differences.some((difference) => difference.delta !== null),
  );
  if (interesting.length === 0) {
    return (
      <p className="mt-1 text-[10px] text-muted-foreground">
        No seed produced a value for both arms, so no paired comparison is possible.
      </p>
    );
  }

  return (
    <div className="mt-1.5 space-y-0.5">
      {interesting.map((comparison) => (
        <p key={`${comparison.candidateArmId}-${comparison.metricKey}`} className="text-[10px]">
          <span className="text-muted-foreground">{comparison.metricLabel}:</span>{' '}
          <strong>{comparison.candidateArmId}</strong> better on {comparison.candidateBetter} of{' '}
          {comparison.differences.length} seeds · <strong>{comparison.baselineArmId}</strong> on{' '}
          {comparison.baselineBetter}
          {comparison.undecided > 0 && ` · ${String(comparison.undecided)} undecided`}
        </p>
      ))}
    </div>
  );
}
