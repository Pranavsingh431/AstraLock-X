/**
 * Recording a run, and watching the evaluator score it.
 *
 * Two clearly separated halves, and the separation is the point.
 *
 * The **recorder** controls are plain: record, finalise, abort. Every counter is
 * read from the recorder itself — rows serialised, bytes the storage confirmed
 * written, bytes still queued — so the panel cannot show activity that is not
 * happening. If persistence fails, the error is shown rather than swallowed.
 *
 * The **evaluation** readout uses ground truth, is labelled as such, and can be
 * switched off, in which case it is not even computed. That matters: an
 * operator, or a judge, must be able to hide every privileged number and still
 * watch the tracker work. Nothing here is routed into the algorithm — the lint
 * barrier makes that impossible — but being unable to reach it and being
 * visibly independent of it are different claims, and the second is the one a
 * demonstration makes.
 *
 * Nothing in this panel is editable. A result someone can type over is not a
 * result.
 */

import { CircleStop, Eye, EyeOff, FlaskConical, Square } from 'lucide-react';

import { displayStatus } from '@/core/experiments';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSimulationStore } from '@/stores/simulation-store';

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex min-w-0 flex-col">
      <span className="text-[9px] tracking-wider text-muted-foreground uppercase">{label}</span>
      <span className="tabular truncate text-[11px] text-foreground/90">{value}</span>
    </div>
  );
}

const kilobytes = (bytes: number): string => `${(bytes / 1024).toFixed(1)} KB`;

export function ExperimentControls(): React.JSX.Element {
  const status = useSimulationStore((state) => state.recorderStatus);
  const busy = useSimulationStore((state) => state.recorderBusy);
  const error = useSimulationStore((state) => state.recorderError);
  const autonomyEnabled = useSimulationStore((state) => state.autonomyEnabled);
  const showLive = useSimulationStore((state) => state.showLiveEvaluation);
  const live = useSimulationStore((state) => state.liveEvaluation);
  const time = useSimulationStore((state) => state.time);

  const startExperiment = useSimulationStore((state) => state.startExperiment);
  const finaliseExperiment = useSimulationStore((state) => state.finaliseExperiment);
  const abortExperiment = useSimulationStore((state) => state.abortExperiment);
  const setLiveEvaluation = useSimulationStore((state) => state.setLiveEvaluation);

  const recording = status?.state === 'running';

  return (
    <div className="space-y-2.5 border-t px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <FlaskConical aria-hidden className="size-3.5 text-violet-400" />
          <h3 className="text-[10px] font-semibold tracking-wider text-violet-400 uppercase">
            Experiment
          </h3>
        </div>
        {status !== null && (
          <Badge
            variant="outline"
            aria-label="Recording status"
            className={cn(
              'text-[10px] font-semibold tracking-wider uppercase',
              recording
                ? 'border-red-500/50 text-red-400'
                : status.state === 'completed'
                  ? 'border-emerald-500/50 text-emerald-400'
                  : 'border-amber-500/50 text-amber-400',
            )}
          >
            {busy ? 'finalising' : recording ? 'recording' : displayStatus(status.state)}
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          aria-label="Start experiment"
          disabled={busy || recording}
          onClick={() => {
            void startExperiment();
          }}
        >
          <span className="size-2 rounded-full bg-red-500" aria-hidden />
          Record
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          aria-label="Stop and finalise experiment"
          disabled={busy || !recording}
          onClick={() => {
            void finaliseExperiment();
          }}
        >
          <Square className="size-3" />
          Stop &amp; finalise
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-7 border-amber-500/40 text-xs text-amber-400 hover:bg-amber-500/10"
          aria-label="Abort experiment"
          disabled={busy || !recording}
          onClick={() => {
            if (
              window.confirm(
                'Abort this experiment? Its raw record is kept, marked ABORTED, and no summary or report is produced.',
              )
            ) {
              void abortExperiment();
            }
          }}
        >
          <CircleStop className="size-3" />
          Abort
        </Button>
      </div>

      {error !== null && (
        <p
          role="alert"
          className="rounded-sm border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] leading-snug text-red-300"
        >
          Recording failed — the experiment was not saved as a result: {error}
        </p>
      )}

      {status === null ? (
        <p className="text-[10px] leading-snug text-muted-foreground">
          Not recording. Record first, then enable autonomy, so that search and acquisition are part
          of the record.
        </p>
      ) : (
        <>
          {recording && !autonomyEnabled && (
            <p className="text-[10px] leading-snug text-amber-300/90">
              Recording. Enable autonomy to begin the measured run.
            </p>
          )}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
            <Field label="Run ID" value={status.runId} />
            <Field
              label="Recorded sim time"
              value={
                recording
                  ? `${(time - status.startSimulationTime).toFixed(2)} s`
                  : displayStatus(status.state)
              }
            />
            <Field label="Events" value={String(status.eventsRecorded)} />
            <Field label="Frames recorded" value={String(status.telemetryRows)} />
            <Field label="Written to disk" value={kilobytes(status.bytesWritten)} />
            <Field
              label="Writer"
              value={
                status.writerError !== null
                  ? 'error'
                  : status.backpressured
                    ? `backpressure (${kilobytes(status.pendingBytes)} queued)`
                    : `ok (${kilobytes(status.pendingBytes)} queued)`
              }
            />
          </div>
          {status.runPath !== null && (
            <p className="text-[9px] leading-snug break-all text-muted-foreground">
              {status.runPath}
            </p>
          )}
        </>
      )}

      {/* --- The privileged half. Labelled, and switchable. --- */}
      <div className="space-y-1.5 rounded-sm border border-amber-500/30 bg-amber-500/5 px-2 py-1.5">
        <div className="flex items-center justify-between">
          <span className="text-[9px] font-semibold tracking-wider text-amber-400 uppercase">
            Evaluation — ground truth
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="h-5 px-1.5 text-[10px] text-amber-400/90 hover:bg-amber-500/10"
            aria-label={showLive ? 'Hide live evaluation' : 'Show live evaluation'}
            aria-pressed={showLive}
            onClick={() => {
              setLiveEvaluation(!showLive);
            }}
          >
            {showLive ? <Eye className="size-3" /> : <EyeOff className="size-3" />}
            {showLive ? 'Hide' : 'Show'}
          </Button>
        </div>

        {showLive && live !== null ? (
          <>
            <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
              <Field
                label="Pointing error"
                value={
                  live.angularPointingErrorRad === null
                    ? 'N/A'
                    : `${(live.angularPointingErrorRad * 1e6).toFixed(0)} µrad`
                }
              />
              <Field
                label="Image error"
                value={
                  live.imagePointingErrorPx === null
                    ? 'N/A — not in image'
                    : `${live.imagePointingErrorPx.toFixed(1)} px`
                }
              />
              <Field label="Lock condition" value={live.lockConditionMet ? 'met' : 'not met'} />
              <Field
                label="Coarse lock"
                value={live.locked === null ? 'N/A' : live.locked ? 'LOCKED' : 'not locked'}
              />
              <Field
                label="Retention"
                value={live.retention === null ? 'N/A' : `${(live.retention * 100).toFixed(1)} %`}
              />
              <Field
                label="Frames"
                value={live.framesProcessed === null ? 'N/A' : String(live.framesProcessed)}
              />
            </div>
            <p className="text-[9px] leading-snug text-muted-foreground">
              {live.source === 'recording'
                ? 'From this recording’s evaluation samples, with the lock dwell and grace applied.'
                : 'Instantaneous. Confirmed lock and retention need a recording.'}
            </p>
          </>
        ) : (
          <p className="text-[10px] leading-snug text-muted-foreground">
            Hidden, and not computed. The tracker runs on pixels alone and is unaffected either way.
          </p>
        )}
      </div>
    </div>
  );
}
