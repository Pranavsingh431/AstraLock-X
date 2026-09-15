/**
 * The saved-run archive.
 *
 * Every number on this screen was read from a file on disk, not from anything
 * the application still remembers. That is the point of the phase: a result is
 * something you can come back to, and check.
 *
 * Status is shown honestly and prominently. A run whose manifest still says
 * `running` was interrupted — the process stopped before finalisation — and is
 * shown as INCOMPLETE. It carries no summary, so it can be inspected or deleted
 * but never quoted. ABORTED and FAILED runs likewise have no summary. Only
 * COMPLETED runs show results.
 *
 * Nothing here is editable. The operator configures an experiment before it
 * runs and reads it afterwards.
 */

import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  FolderOpen,
  RefreshCw,
  ShieldCheck,
  Trash2,
  XCircle,
} from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';

import { formatMeasurement, type Measurement } from '@/core/contracts/measurement';
import {
  RUN_FILES,
  TauriStorage,
  UnavailableStorage,
  createStorage,
  displayStatus,
  listRuns,
  performanceLog,
  recomputeSummary,
  type ExperimentStatus,
  type ExperimentSummary,
  type RunListing,
  type SummaryStatistics,
} from '@/core/experiments';
import { EngineeringTable, Rh, TableBody, TableHead, Td, Th, Tr } from '@/components/astra';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';

const storage = createStorage();

const STATUS_STYLE: Record<string, string> = {
  completed: 'border-status-nominal/40 bg-status-nominal/10 text-status-nominal',
  aborted: 'border-status-degraded/40 bg-status-degraded/10 text-status-degraded',
  failed: 'border-status-fault/40 bg-status-fault/10 text-status-fault',
  incomplete: 'border-status-fault/40 bg-status-fault/10 text-status-fault',
};

/** What a run that is not a result means, said plainly. */
const STATUS_NOTE: Partial<Record<ExperimentStatus, string>> = {
  running:
    'INCOMPLETE: the application stopped before this run was finalised. The raw files are kept for inspection. It is not a valid result and has no summary.',
  created: 'INCOMPLETE: this run was never started. It has no data and no summary.',
  aborted:
    'ABORTED by the operator or by a reset. The raw record is kept; no summary was produced.',
  failed: 'FAILED: recording could not be completed. No summary was produced.',
};

/** A measurement for the table: radians as microradians, fractions as percent. */
function value(measurement: Measurement | undefined, digits = 2): string {
  if (measurement === undefined) return '—';
  if (measurement.value === null) return formatMeasurement(measurement);
  if (measurement.unit === 'rad') return `${(measurement.value * 1e6).toFixed(0)} µrad`;
  if (measurement.unit === '1') return `${(measurement.value * 100).toFixed(1)} %`;
  return formatMeasurement(measurement, digits);
}

function StatusBadge({ status }: { status: ExperimentStatus }): React.JSX.Element {
  const shown = displayStatus(status);
  const Icon =
    shown === 'completed' ? CheckCircle2 : shown === 'incomplete' ? AlertTriangle : XCircle;
  return (
    <Badge
      variant="outline"
      className={cn(
        'gap-1 text-[10px] font-semibold tracking-wider uppercase',
        STATUS_STYLE[shown],
      )}
    >
      <Icon aria-hidden className="size-3" />
      {shown}
    </Badge>
  );
}

function Definition({
  term,
  children,
}: {
  term: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className="tabular min-w-0 break-words">{children}</dd>
    </>
  );
}

function StatsTable({
  title,
  rows,
}: {
  title: string;
  rows: readonly (readonly [string, SummaryStatistics])[];
}): React.JSX.Element {
  return (
    <EngineeringTable>
      <TableHead>
        <Th>{title}</Th>
        <Th numeric>n</Th>
        <Th numeric>Mean</Th>
        <Th numeric>RMS</Th>
        <Th numeric>Median</Th>
        <Th numeric>P95</Th>
        <Th numeric>Max</Th>
      </TableHead>
      <TableBody>
        {rows.map(([label, stats]) => (
          <Tr key={label}>
            <Rh>{label}</Rh>
            <Td numeric>{stats.count}</Td>
            <Td numeric>{value(stats.mean, 3)}</Td>
            <Td numeric>{value(stats.rms, 3)}</Td>
            <Td numeric>{value(stats.median, 3)}</Td>
            <Td numeric>{value(stats.p95, 3)}</Td>
            <Td numeric>{value(stats.max, 3)}</Td>
          </Tr>
        ))}
      </TableBody>
    </EngineeringTable>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-1.5">
      <h3 className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      {children}
    </section>
  );
}

function Results({ summary }: { summary: ExperimentSummary }): React.JSX.Element {
  const s = summary;
  return (
    <>
      <Section title="Performance log">
        <dl className="grid grid-cols-[minmax(0,230px)_1fr] gap-x-3 gap-y-1 text-[11px]">
          {performanceLog(s).map((entry) => (
            <Definition key={entry.source} term={entry.label}>
              {value(entry.value, 3)}
            </Definition>
          ))}
        </dl>
      </Section>

      <Section title="Acquisition milestones">
        <dl className="grid grid-cols-[minmax(0,230px)_1fr] gap-x-3 gap-y-1 text-[11px]">
          <Definition term="Outcome">{s.acquisitionOutcome}</Definition>
          <Definition term="Search started">{value(s.searchStartTime, 3)}</Definition>
          <Definition term="First detection of target">
            {value(s.firstDetectionTime, 3)} · +{value(s.timeToFirstDetection, 3)}
          </Definition>
          <Definition term="TRACK entered">
            {value(s.trackEntryTime, 3)} · +{value(s.timeToTrack, 3)}
          </Definition>
          <Definition term="Coarse lock confirmed">{value(s.coarseLockTime, 3)}</Definition>
          <Definition term="Coarse acquisition time">
            {value(s.coarseAcquisitionTime, 3)}
          </Definition>
        </dl>
      </Section>

      <Section title="Tracking accuracy — evaluation, from ground truth">
        <StatsTable
          title="Angular"
          rows={[
            ['Whole run', s.angularPointingError.wholeRun],
            ['Post-acquisition', s.angularPointingError.postAcquisition],
            ['TRACK state', s.angularPointingError.trackState],
          ]}
        />
        <StatsTable
          title="Image"
          rows={[
            ['Whole run', s.imagePointingError.wholeRun],
            ['Post-acquisition', s.imagePointingError.postAcquisition],
            ['TRACK state', s.imagePointingError.trackState],
          ]}
        />
        <StatsTable title="Detector" rows={[['Centroid vs truth', s.detectorCentroidError]]} />
      </Section>

      <Section title="Lock">
        <dl className="grid grid-cols-[minmax(0,230px)_1fr] gap-x-3 gap-y-1 text-[11px]">
          <Definition term="Retention">
            {value(s.lockRetentionRate)} ({s.lockRetentionStatus}) ·{' '}
            {value(s.lockedDurationSeconds)} of {value(s.trackableOpportunitySeconds)}
          </Definition>
          <Definition term="Loss episodes">
            {s.lossOfLockEpisodes} · {s.reacquisitionCount} reacquired · {s.unrecoveredLosses}{' '}
            unrecovered
          </Definition>
          <Definition term="Reacquisition time">
            median {value(s.reacquisitionTime.median)} · P95 {value(s.reacquisitionTime.p95)} · max{' '}
            {value(s.reacquisitionTime.max)}
          </Definition>
          <Definition term="False lock">
            {s.falseLockExercised
              ? `${String(s.falseLockEpisodes)} episodes, ${value(s.falseLockDurationSeconds)}`
              : 'Not exercised — no competing emitter was ever in view'}
          </Definition>
        </dl>
      </Section>

      <Section title="Host processing time — wall clock, not simulated">
        <StatsTable
          title="Stage"
          rows={[
            ['Sensor frame', s.hostProcessingTime.sensorFrameGeneration],
            ['Detector', s.hostProcessingTime.detector],
            ['Bearing', s.hostProcessingTime.bearingTransform],
            ['Kalman', s.hostProcessingTime.estimator],
            ['Controller', s.hostProcessingTime.controller],
            ['Algorithm', s.hostProcessingTime.algorithmTotal],
            ['Orchestration', s.hostProcessingTime.runtimeOrchestration],
          ]}
        />
      </Section>

      <Section title="Control latency — simulated time">
        <StatsTable
          title="Interval"
          rows={[
            ['Capture → issue', s.controlLatency.captureToIssue],
            ['Issue → applied', s.controlLatency.issueToApplication],
            ['Capture → applied', s.controlLatency.captureToApplication],
          ]}
        />
      </Section>
    </>
  );
}

export function ReportsView(): React.JSX.Element {
  const [runs, setRuns] = useState<readonly RunListing[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [root, setRoot] = useState<string | null>(null);

  const available = !(storage instanceof UnavailableStorage);
  const desktop = storage instanceof TauriStorage;

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const listings = await listRuns(storage);
      if (storage instanceof TauriStorage) {
        setRoot(await storage.runsRoot());
        // Cached so the details pane can show each run's folder synchronously.
        for (const listing of listings) await storage.resolvePath(listing.runId);
      }
      setRuns(listings);
    } catch (error) {
      setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  }, []);

  // Reading the run archive is subscribing to an external system: the
  // filesystem is outside React, and every state update in `refresh` happens
  // after an await rather than synchronously in this body.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- see above
    void refresh();
  }, [refresh]);

  const current = runs.find((run) => run.runId === selected) ?? null;

  const act = (work: () => Promise<void>): void => {
    setBusy(true);
    work()
      .catch((error: unknown) => {
        setNotice({ tone: 'error', text: error instanceof Error ? error.message : String(error) });
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const verify = (runId: string): void => {
    act(async () => {
      const { differences } = await recomputeSummary(storage, runId);
      setNotice(
        differences.length === 0
          ? {
              tone: 'ok',
              text: `Verified: recomputing from ${RUN_FILES.events}, ${RUN_FILES.telemetry} and ${RUN_FILES.evaluation} reproduces every field of the stored summary.`,
            }
          : {
              tone: 'error',
              text: `Mismatch in ${String(differences.length)} field(s): ${differences
                .slice(0, 4)
                .map(
                  (d) =>
                    `${d.path} (stored ${JSON.stringify(d.stored)}, recomputed ${JSON.stringify(d.recomputed)})`,
                )
                .join('; ')}`,
            },
      );
    });
  };

  const remove = (runId: string): void => {
    // Deleting a run destroys the only copy of its record, so it asks first.
    if (!window.confirm(`Delete run ${runId}? Its files are removed and cannot be recovered.`)) {
      return;
    }
    act(async () => {
      await storage.deleteRun(runId);
      setSelected(null);
      setNotice({ tone: 'ok', text: `Deleted ${runId}.` });
      await refresh();
    });
  };

  return (
    <div className="flex h-full min-h-0">
      <div className="flex w-[440px] min-w-0 shrink-0 flex-col border-r border-panel-border">
        <header className="flex items-center justify-between gap-2 border-b border-panel-border bg-panel-header px-3 py-2">
          <div className="min-w-0">
            <h2 className="flex items-center gap-2 text-[11px] font-semibold tracking-wider text-foreground/80 uppercase">
              Saved runs
              {runs.length > 0 && (
                <span className="tabular rounded-sm bg-muted px-1.5 py-px text-[10px] font-medium text-muted-foreground">
                  {runs.length}
                </span>
              )}
            </h2>
            {root !== null && (
              <p className="truncate text-[9px] text-muted-foreground" title={root}>
                {root}
              </p>
            )}
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-[11px]"
            aria-label="Refresh run list"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void refresh();
            }}
          >
            <RefreshCw className="size-3" />
            Refresh
          </Button>
        </header>

        <ScrollArea className="min-h-0 flex-1">
          {!available && (
            <p className="px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
              {UnavailableStorage.reason} Nothing is listed here.
            </p>
          )}

          {available && runs.length === 0 && (
            <p className="px-3 py-4 text-[11px] leading-relaxed text-muted-foreground">
              No runs recorded yet. Start an experiment from Mission Control.
            </p>
          )}

          <ul aria-label="Saved runs">
            {runs.map((run) => {
              const m = run.manifest;
              const s = run.summary;
              return (
                <li key={run.runId}>
                  <button
                    type="button"
                    aria-label={`Open run ${run.runId}`}
                    aria-current={selected === run.runId}
                    onClick={() => {
                      setSelected(run.runId);
                      setNotice(null);
                    }}
                    className={cn(
                      'w-full border-b border-l-2 border-l-transparent px-3 py-2 text-left transition-colors hover:bg-accent/40',
                      selected === run.runId && 'border-l-primary bg-accent/70',
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="tabular truncate text-[11px] font-medium text-foreground">
                        {run.runId}
                      </span>
                      {m !== null && <StatusBadge status={m.status} />}
                    </div>
                    {m === null ? (
                      <p className="mt-0.5 text-[10px] text-status-fault">
                        Unreadable: {run.error}
                      </p>
                    ) : (
                      <>
                        <div className="mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-muted-foreground">
                          <span>{m.scenarioId ?? m.scenarioName}</span>
                          <span>{m.algorithmId}</span>
                          <span>{m.host.createdAt.replace('T', ' ').replace(/\..*/, '')}</span>
                        </div>
                        <div className="tabular mt-0.5 flex flex-wrap gap-x-3 text-[10px] text-foreground/80">
                          <span>
                            duration{' '}
                            {m.endSimulationTime === null
                              ? '—'
                              : `${(m.endSimulationTime - m.startSimulationTime).toFixed(1)} s`}
                          </span>
                          {s === null ? (
                            <span className="text-muted-foreground">no result</span>
                          ) : (
                            <>
                              <span>
                                acq{' '}
                                {s.acquisitionOutcome === 'acquired'
                                  ? value(s.coarseAcquisitionTime)
                                  : s.acquisitionOutcome}
                              </span>
                              <span>retention {value(s.lockRetentionRate)}</span>
                              <span>
                                err {value(s.angularPointingError.postAcquisition.mean)} / P95{' '}
                                {value(s.angularPointingError.postAcquisition.p95)}
                              </span>
                            </>
                          )}
                        </div>
                      </>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </ScrollArea>
      </div>

      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center gap-2 border-b border-panel-border bg-panel-header px-3 py-2">
          <h2 className="truncate text-[11px] font-semibold tracking-[0.08em] text-foreground/80 uppercase">
            {current === null ? 'Run details' : current.runId}
          </h2>
          {current?.manifest != null && (
            <span className="ml-auto shrink-0">
              <StatusBadge status={current.manifest.status} />
            </span>
          )}
        </header>

        <ScrollArea className="min-h-0 flex-1">
          <div className="space-y-4 px-4 py-3">
            {notice !== null && (
              <p
                role="status"
                className={cn(
                  'rounded-sm border px-2.5 py-1.5 text-[11px] leading-snug break-words',
                  notice.tone === 'ok'
                    ? 'border-status-nominal/40 bg-status-nominal/10 text-status-nominal'
                    : 'border-status-fault/40 bg-status-fault/10 text-status-fault',
                )}
              >
                {notice.text}
              </p>
            )}

            {current === null && (
              <p className="text-[11px] text-muted-foreground">Select a run to inspect it.</p>
            )}

            {current?.manifest != null && (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    aria-label="Open report"
                    disabled={busy || !desktop || current.summary === null}
                    title={desktop ? undefined : 'Opening files needs the desktop application'}
                    onClick={() => {
                      act(() => (storage as TauriStorage).openReport(current.runId));
                    }}
                  >
                    <FileText className="size-3" />
                    Open report
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    aria-label="Open run folder"
                    disabled={busy || !desktop}
                    onClick={() => {
                      act(() => (storage as TauriStorage).reveal(current.runId));
                    }}
                  >
                    <FolderOpen className="size-3" />
                    Open folder
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    aria-label="Recompute and verify summary"
                    disabled={busy || current.summary === null}
                    onClick={() => {
                      verify(current.runId);
                    }}
                  >
                    <ShieldCheck className="size-3" />
                    Recompute &amp; verify
                  </Button>
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-7 border-status-fault/40 text-xs text-status-fault hover:bg-status-fault/10"
                    aria-label="Delete run"
                    disabled={busy}
                    onClick={() => {
                      remove(current.runId);
                    }}
                  >
                    <Trash2 className="size-3" />
                    Delete
                  </Button>
                </div>

                {STATUS_NOTE[current.manifest.status] !== undefined && (
                  <p
                    role="note"
                    className="rounded-sm border border-status-degraded/40 bg-status-degraded/10 px-2.5 py-1.5 text-[11px] leading-snug text-status-degraded"
                  >
                    {STATUS_NOTE[current.manifest.status]}
                  </p>
                )}

                <Section title="Provenance">
                  <dl className="grid grid-cols-[minmax(0,230px)_1fr] gap-x-3 gap-y-1 text-[11px]">
                    <Definition term="Scenario">
                      {current.manifest.scenarioName}{' '}
                      <span className="text-muted-foreground">
                        {current.manifest.scenarioId ?? 'imported'} · seed{' '}
                        {current.manifest.scenarioSeed}
                      </span>
                    </Definition>
                    <Definition term="Algorithm">
                      {current.manifest.algorithmId} {current.manifest.algorithmVersion}
                    </Definition>
                    <Definition term="Scenario fingerprint">
                      <span className="text-[10px] break-all">
                        {current.manifest.scenarioFingerprint}
                      </span>
                    </Definition>
                    <Definition term="Algorithm fingerprint">
                      <span className="text-[10px] break-all">
                        {current.manifest.algorithmFingerprint}
                      </span>
                    </Definition>
                    <Definition term="Metrics definition">
                      v{current.manifest.metricsDefinitionVersion}{' '}
                      <span className="text-[10px] break-all text-muted-foreground">
                        {current.manifest.metricsFingerprint}
                      </span>
                    </Definition>
                    <Definition term="Build">
                      {current.manifest.host.applicationVersion} ·{' '}
                      {current.manifest.host.sourceCommit ?? (
                        <span className="text-muted-foreground">commit unavailable</span>
                      )}
                      {current.manifest.host.sourceTreeModified === true && (
                        <span className="text-status-degraded"> (uncommitted changes)</span>
                      )}
                    </Definition>
                    <Definition term="Recorded">
                      {current.manifest.host.createdAt}
                      {current.manifest.host.endedAt !== null &&
                        ` → ${current.manifest.host.endedAt}`}
                    </Definition>
                    <Definition term="Simulated window">
                      {current.manifest.startSimulationTime.toFixed(3)} s →{' '}
                      {current.manifest.endSimulationTime === null
                        ? 'never ended'
                        : `${current.manifest.endSimulationTime.toFixed(3)} s`}
                    </Definition>
                    <Definition term="Termination">
                      {current.manifest.terminationReason ?? 'none recorded'}
                    </Definition>
                    {storage.runPath(current.runId) !== null && (
                      <Definition term="Folder">
                        <span className="text-[10px] break-all">
                          {storage.runPath(current.runId)}
                        </span>
                      </Definition>
                    )}
                  </dl>
                </Section>

                {current.summary !== null && <Results summary={current.summary} />}
              </>
            )}
          </div>
        </ScrollArea>
      </div>
    </div>
  );
}
