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
import { useSimulationStore } from '@/stores/simulation-store';

import { confirmIfRecording } from '../recording-guard';

/** How the baseline's three states are presented. */
const STATE_STYLE: Partial<Record<PATMode, string>> = {
  scan: 'border-sky-500/40 text-sky-300',
  track: 'border-emerald-500/50 text-emerald-300',
  lost: 'border-amber-500/50 text-amber-300',
};

const STATE_LABEL: Partial<Record<PATMode, string>> = {
  scan: 'SEARCH',
  track: 'TRACK',
  lost: 'LOST',
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
  const override = useSimulationStore((state) => state.manualOverride);
  const runtimeError = useSimulationStore((state) => state.runtimeError);
  const snr = useSimulationStore((state) => state.detectionSnr);

  const setAutonomy = useSimulationStore((state) => state.setAutonomy);
  const emergencyStop = useSimulationStore((state) => state.emergencyStop);
  const setAlgorithmOverlay = useSimulationStore((state) => state.setAlgorithmOverlay);
  const setManualOverride = useSimulationStore((state) => state.setManualOverride);

  const deg = (value: number | null): string =>
    value === null ? '—' : `${radiansToDegrees(value as never).toFixed(3)}°`;

  return (
    <div className="space-y-2.5 border-t px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Bot aria-hidden className="size-3.5 text-emerald-400" />
          <h3 className="text-[10px] font-semibold tracking-wider text-emerald-400 uppercase">
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
          className="h-7 border-red-500/40 text-xs text-red-400 hover:bg-red-500/10"
          aria-label="Emergency stop"
          disabled={!enabled}
          onClick={emergencyStop}
        >
          <CircleStop className="size-3" />
          Stop
        </Button>

        <span className="tabular text-[10px] text-muted-foreground">{algorithmId}</span>
      </div>

      {runtimeError !== null && (
        <p
          role="alert"
          className="rounded-sm border border-red-500/40 bg-red-500/10 px-2 py-1.5 text-[10px] leading-snug text-red-300"
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

          <div className="flex flex-wrap items-center gap-3">
            <label className="flex items-center gap-1.5 text-[11px] text-emerald-400/90">
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

            <label className="flex items-center gap-1.5 text-[11px] text-amber-400/90">
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
          </div>

          {override && (
            <p className="text-[10px] leading-snug text-amber-400/90">
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
