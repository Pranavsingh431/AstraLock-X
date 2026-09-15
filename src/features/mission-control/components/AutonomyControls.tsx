/**
 * Handing the mount to the tracker, and taking it back.
 *
 * Every value shown here comes from the algorithm. The PAT state is the state
 * machine's own; the candidate count, centroid and corrections are what the
 * detector and controller actually produced this frame. When the algorithm is
 * not running, the fields are empty rather than showing a plausible resting
 * value.
 *
 * Nothing here is privileged. All of it derives from pixels, the believed
 * calibration and the measured mount state, which is exactly what a real
 * operator's console would have.
 */

import { formatMeasurement } from '@/core/contracts/measurement';
import { Bot, CircleStop, Crosshair } from 'lucide-react';

import { radiansToDegrees } from '@/core/contracts/units';
import type { PATMode } from '@/core/contracts/pat';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { ALGORITHMS } from '@/core/algorithms';
import { useSimulationStore } from '@/stores/simulation-store';

import { confirmIfRecording } from '../recording-guard';

/** How the baseline's three states are presented. */
const STATE_STYLE: Partial<Record<PATMode, string>> = {
  scan: 'border-sky-500/50 bg-sky-500/10 text-sky-700',
  acquire: 'border-blue-400/60 bg-blue-500/10 text-blue-700',
  track: 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700',
  // A real fault, and the only state that earns red.
  lost: 'border-red-500/60 bg-red-500/10 text-red-700',
  reacquire: 'border-amber-500/60 bg-amber-500/10 text-amber-700',
  handoff: 'border-cyan-400/70 bg-cyan-400/10 text-cyan-800',
};

const STATE_LABEL: Partial<Record<PATMode, string>> = {
  scan: 'SEARCH',
  acquire: 'ACQUIRE',
  track: 'TRACK',
  lost: 'LOST',
  reacquire: 'RECOVER',
  // Readiness, not a handover: no fine-pointing actuator exists, and the
  // coarse loop keeps tracking throughout. The label says so.
  handoff: 'HANDOFF READY',
};

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] tracking-wider text-muted-foreground uppercase">{label}</span>
      <span className="tabular text-[11px] text-foreground/90">{value}</span>
    </div>
  );
}

export function AutonomyControls(): React.JSX.Element {
  const enabled = useSimulationStore((state) => state.autonomyEnabled);
  const algorithmId = useSimulationStore((state) => state.algorithmId);
  const patMode = useSimulationStore((state) => state.patMode);
  const debug = useSimulationStore((state) => state.algorithmDebug);
  const overlay = useSimulationStore((state) => state.showAlgorithmOverlay);
  const identityEnabled = useSimulationStore((state) => state.identityEnabled);
  const identityAvailable = useSimulationStore((state) => state.identityAvailable);
  const setIdentityEnabled = useSimulationStore((state) => state.setIdentityEnabled);
  const override = useSimulationStore((state) => state.manualOverride);
  const runtimeError = useSimulationStore((state) => state.runtimeError);
  const snr = useSimulationStore((state) => state.detectionSnr);

  const setAutonomy = useSimulationStore((state) => state.setAutonomy);
  const emergencyStop = useSimulationStore((state) => state.emergencyStop);
  const setAlgorithmOverlay = useSimulationStore((state) => state.setAlgorithmOverlay);
  const setManualOverride = useSimulationStore((state) => state.setManualOverride);
  const setAlgorithm = useSimulationStore((state) => state.setAlgorithm);
  const recorderStatus = useSimulationStore((state) => state.recorderStatus);

  // The tracker cannot be swapped while an experiment is recording: doing so
  // would splice two different experiments into one record.
  const recording = recorderStatus !== null && recorderStatus.state === 'running';

  const deg = (value: number | null): string =>
    value === null ? '—' : `${radiansToDegrees(value as never).toFixed(3)}°`;

  return (
    <div className="space-y-2.5 border-t px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Bot aria-hidden className="size-3.5 text-emerald-700" />
          <h3 className="text-[10px] font-semibold tracking-wider text-emerald-700 uppercase">
            Autonomous PAT
          </h3>
        </div>

        {enabled && patMode !== null && (
          <Badge
            variant="outline"
            className={cn(
              'text-[10px] font-semibold tracking-wider uppercase',
              STATE_STYLE[patMode] ?? 'text-muted-foreground',
            )}
          >
            {STATE_LABEL[patMode] ?? patMode}
          </Badge>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant={enabled ? 'default' : 'outline'}
          className="h-7 text-xs"
          aria-label={enabled ? 'Disable autonomous PAT' : 'Enable autonomous PAT'}
          aria-pressed={enabled}
          onClick={() => {
            if (
              enabled &&
              !confirmIfRecording(
                'Switching autonomy off ends the measurement window, so the recording will be finalised.',
              )
            ) {
              return;
            }
            setAutonomy(!enabled);
          }}
        >
          <Crosshair className="size-3" />
          {enabled ? 'ON' : 'OFF'}
        </Button>

        <Button
          size="sm"
          variant="outline"
          className="h-7 border-red-500/40 text-xs text-red-700 hover:bg-red-500/10"
          aria-label="Emergency stop"
          disabled={!enabled}
          onClick={emergencyStop}
        >
          <CircleStop className="size-3" />
          Stop
        </Button>

        <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <span className="sr-only">Algorithm</span>
          <select
            aria-label="Algorithm"
            value={algorithmId}
            disabled={recording}
            onChange={(event) => {
              setAlgorithm(event.target.value);
            }}
            className="h-6 rounded-sm border bg-background px-1 text-[10px] text-foreground/90 disabled:opacity-50"
          >
            {ALGORITHMS.map((plugin) => (
              <option key={plugin.manifest.id} value={plugin.manifest.id}>
                {plugin.manifest.name}
              </option>
            ))}
          </select>
        </label>
      </div>

      {runtimeError !== null && (
        <p
          role="alert"
          className="rounded-sm border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] leading-snug text-red-700"
        >
          Control loop stopped: {runtimeError}
        </p>
      )}

      {enabled ? (
        <>
          <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
            <Field label="Candidates" value={debug === null ? '—' : String(debug.candidateCount)} />
            <Field
              label="Components"
              value={debug === null ? '—' : String(debug.componentsFound)}
            />
            <Field
              label="Score"
              value={debug?.candidateScore == null ? '—' : debug.candidateScore.toFixed(3)}
            />
            <Field label="SNR" value={snr === null ? '—' : formatMeasurement(snr, 1)} />
            <Field
              label="Centroid"
              value={
                debug?.centroidX == null
                  ? '—'
                  : `${debug.centroidX.toFixed(1)}, ${debug.centroidY!.toFixed(1)}`
              }
            />
            <Field label="Filtered az" value={deg(debug?.filteredAzimuth ?? null)} />
            <Field label="Filtered el" value={deg(debug?.filteredElevation ?? null)} />
            <Field
              label="Az rate"
              value={
                debug?.azimuthRate == null
                  ? '—'
                  : `${radiansToDegrees(debug.azimuthRate as never).toFixed(2)}°/s`
              }
            />
            <Field label="PID pan" value={deg(debug?.panCorrection ?? null)} />
            <Field label="PID tilt" value={deg(debug?.tiltCorrection ?? null)} />
            <Field label="Misses" value={debug === null ? '—' : String(debug.consecutiveMisses)} />
            <Field
              label="Waypoint"
              value={
                debug?.searchWaypointIndex == null
                  ? '—'
                  : `${String(debug.searchWaypointIndex + 1)} / ${String(debug.searchWaypointCount)}`
              }
            />
            <Field label="Frames" value={debug === null ? '—' : String(debug.framesProcessed)} />
          </div>

          <EstimatorPanel />
          <IdentityPanel />

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-emerald-700/90">
              <input
                type="checkbox"
                aria-label="Algorithm overlay"
                checked={overlay}
                onChange={(event) => {
                  setAlgorithmOverlay(event.target.checked);
                }}
                className="accent-emerald-400"
              />
              Detection overlay
            </label>

            <label className="flex items-center gap-1.5 text-[11px] text-amber-700/90">
              <input
                type="checkbox"
                aria-label="Manual override"
                checked={override}
                onChange={(event) => {
                  setManualOverride(event.target.checked);
                }}
                className="accent-amber-400"
              />
              Manual override
            </label>

            {identityAvailable && algorithmId === 'astralock-x' && (
              <label className="flex items-center gap-1.5 text-[11px] text-violet-700/90">
                <input
                  type="checkbox"
                  aria-label="Beacon identity"
                  checked={identityEnabled}
                  onChange={(event) => {
                    if (!confirmIfRecording('Switching beacon identity ends the recording.')) {
                      return;
                    }
                    setIdentityEnabled(event.target.checked);
                  }}
                  className="accent-violet-400"
                />
                Beacon identity
              </label>
            )}
          </div>

          {identityAvailable && algorithmId === 'astralock-x' && !identityEnabled && (
            <p className="text-[10px] leading-snug text-violet-700/90">
              Identity off: the tracker is choosing on motion alone, as it did before coded beacons
              existed. This is the control arm.
            </p>
          )}

          {override && (
            <p className="text-[10px] leading-snug text-amber-700/90">
              Operator override: your commands and the tracker&apos;s both reach the mount.
            </p>
          )}
        </>
      ) : (
        <p className="text-[10px] leading-snug text-muted-foreground">
          Not running. The mount is under manual control and nothing reads the pixels.
        </p>
      )}
    </div>
  );
}

/** A bar showing how the two motion models divide the estimator's belief. */
function ModelBar({ cv }: { cv: number }): React.JSX.Element {
  const cvPercent = Math.round(cv * 100);
  return (
    <div className="flex h-1.5 overflow-hidden rounded-sm bg-muted" aria-hidden>
      <div className="bg-sky-400" style={{ width: `${String(cvPercent)}%` }} />
      <div className="bg-orange-400" style={{ width: `${String(100 - cvPercent)}%` }} />
    </div>
  );
}

/**
 * Estimator and recovery diagnostics for the robust algorithm.
 *
 * Rendered only when the running tracker actually produces them — the baseline
 * has a single motion model and no recovery state, and a panel of dashes about
 * capabilities it does not have would be noise.
 *
 * Every value is the algorithm's own. The uncertainty figure is the estimator's
 * covariance, not a measured error.
 */
function EstimatorPanel(): React.JSX.Element | null {
  const debug = useSimulationStore((state) => state.algorithmDebug);
  if (debug === null || !('immCvProbability' in debug)) return null;

  const robust = debug;
  const cv = robust.immCvProbability;
  const ca = robust.immCaProbability;
  if (cv === null || ca === null) return null;

  const deg = (value: number | null, digits = 3): string =>
    value === null ? '—' : `${radiansToDegrees(value as never).toFixed(digits)}°`;

  return (
    <div className="space-y-1.5 rounded-sm border border-sky-500/30 bg-sky-500/5 px-2 py-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] font-semibold tracking-wider text-sky-700 uppercase">
          Estimator — IMM
        </span>
        <span className="tabular text-[10px] text-muted-foreground">
          horizon{' '}
          {robust.predictionHorizon === null
            ? '—'
            : `${(robust.predictionHorizon * 1000).toFixed(0)} ms`}
        </span>
      </div>

      <ModelBar cv={cv} />
      <div className="flex justify-between text-[10px]">
        <span className="tabular text-sky-700">CV {cv.toFixed(2)}</span>
        <span className="tabular text-orange-300">CA {ca.toFixed(2)}</span>
      </div>

      <div className="grid grid-cols-3 gap-x-3 gap-y-1">
        <Field
          label="Track quality"
          value={robust.trackQuality === null ? '—' : robust.trackQuality.toFixed(2)}
        />
        <Field label="Uncertainty" value={deg(robust.angularSigma, 4)} />
        <Field
          label="NIS"
          value={robust.innovationNis === null ? '—' : robust.innovationNis.toFixed(2)}
        />
        <Field label="Feed-forward" value={deg(robust.feedforwardPan, 4)} />
        <Field
          label="Evidence"
          value={robust.acquisitionEvidence === null ? '—' : robust.acquisitionEvidence.toFixed(2)}
        />
        <Field
          label="Recovery age"
          value={robust.recoveryAge === null ? '—' : `${robust.recoveryAge.toFixed(2)} s`}
        />
      </div>

      {robust.localSearchRadius !== null && (
        <p className="text-[10px] text-amber-700/90">
          Local search radius {deg(robust.localSearchRadius, 2)}, pattern step{' '}
          {robust.localSearchIndex === null ? '—' : String(robust.localSearchIndex)}
        </p>
      )}
      {robust.handoffDwell !== null && (
        <p className="text-[10px] text-cyan-700/90">
          Handoff dwell {robust.handoffDwell.toFixed(2)} s of{' '}
          {robust.handoffRequiredDwell.toFixed(2)} s
        </p>
      )}
    </div>
  );
}

/** How each identity verdict is presented. Wording is the tracker's, not truth. */
const IDENTITY_STYLE: Record<string, { style: string; label: string; meaning: string }> = {
  match: {
    style: 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700',
    label: 'MATCH',
    meaning: 'The watched source is sending the expected pattern.',
  },
  mismatch: {
    style: 'border-red-500/60 bg-red-500/10 text-red-700',
    label: 'MISMATCH',
    meaning: 'The watched source is sending something else.',
  },
  ambiguous: {
    style: 'border-amber-500/60 bg-amber-500/10 text-amber-700',
    label: 'AMBIGUOUS',
    meaning: 'More than one source fits the expected pattern. They cannot be told apart.',
  },
  unconfirmed: {
    style: 'border-slate-400/60 bg-slate-400/10 text-slate-700',
    label: 'UNCONFIRMED',
    meaning: 'Between the thresholds: neither recognised nor refused.',
  },
  'insufficient-evidence': {
    style: 'border-slate-400/60 bg-slate-400/10 text-slate-700',
    label: 'NO EVIDENCE',
    meaning: 'Not watched long enough, or the source is not modulating.',
  },
};

/**
 * What the correlator currently believes about the source being tracked.
 *
 * Rendered only when the running algorithm has an identity stage and it is
 * switched on. Every figure is the tracker's own evidence about pixels it saw:
 * a correlation, a recovered phase, and how much history went into them. There
 * is no emitter name here and there cannot be one — the tracker is configured
 * with a *pattern to expect*, not with the identity of an object in the world,
 * and it has no way to know which simulated entity it is looking at.
 *
 * The correlation is a normalised (Pearson) coefficient on [-1, 1], invariant
 * to brightness. It is **not** a probability and is not shown as a percentage.
 */
function IdentityPanel(): React.JSX.Element | null {
  const debug = useSimulationStore((state) => state.algorithmDebug);
  if (debug === null || !('identityEnabled' in debug)) return null;
  if (!debug.identityEnabled) return null;

  const state = debug.identityState;
  const presentation =
    state === null
      ? {
          style: 'border-slate-400/60 bg-slate-400/10 text-slate-700',
          label: 'IDLE',
          meaning: 'No candidate is being watched.',
        }
      : (IDENTITY_STYLE[state] ?? {
          style: 'border-slate-400/60 bg-slate-400/10 text-slate-700',
          label: state.toUpperCase(),
          meaning: '',
        });

  return (
    <div className="space-y-1.5 rounded-sm border border-violet-500/30 bg-violet-500/5 px-2 py-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-[9px] font-semibold tracking-wider text-violet-700 uppercase">
          Beacon identity — coded
        </span>
        <Badge
          variant="outline"
          className={cn('h-4 px-1.5 text-[9px] font-semibold tracking-wider', presentation.style)}
        >
          {presentation.label}
        </Badge>
      </div>

      <div className="grid grid-cols-3 gap-x-3 gap-y-1">
        <Field
          label="Correlation"
          value={debug.codeCorrelation === null ? '—' : debug.codeCorrelation.toFixed(3)}
        />
        <Field
          label="Code phase"
          value={debug.codePhase === null ? '—' : `${(debug.codePhase * 1000).toFixed(0)} ms`}
        />
        <Field
          label="Evidence"
          value={
            debug.identitySamples === null
              ? '—'
              : `${String(debug.identitySamples)} obs${debug.identitySpan === null ? '' : ` / ${debug.identitySpan.toFixed(1)} s`}`
          }
        />
        <Field label="Watched sources" value={String(debug.identityCandidates)} />
        <Field label="Refused this frame" value={String(debug.identityRejected)} />
      </div>

      {presentation.meaning !== '' && (
        <p className="text-[10px] text-violet-700/90">{presentation.meaning}</p>
      )}
      <p className="text-[9px] text-muted-foreground">
        Correlation against the expected signalling pattern, on [-1, 1]. Not a probability.
      </p>
    </div>
  );
}
