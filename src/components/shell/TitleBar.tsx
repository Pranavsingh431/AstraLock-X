/**
 * The global status strip.
 *
 * One line, always visible, in every workspace: what is loaded, what is
 * tracking it, how far into the run we are, and whether anything privileged is
 * on screen. Its job is that an engineer glancing at a screenshot can say what
 * it is a screenshot *of* without being told.
 *
 * The PAT state is the one element here that repeats — it also sits on the
 * sensor feed. That repetition is deliberate: it is the single most consequential
 * fact in the application, and it must be legible from across a room and from
 * inside a workspace that is not Mission Control.
 */

import { Crosshair, ShieldAlert, ShieldOff } from 'lucide-react';

import { getView } from '@/app/views';
import { ALGORITHMS } from '@/core/algorithms';
import { PAT_STATE, StatusBadge } from '@/components/astra';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useNavigationStore } from '@/stores/navigation-store';
import { useSimulationStore } from '@/stores/simulation-store';

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="text-[9px] tracking-[0.08em] text-muted-foreground uppercase">{label}</span>
      <span className="tabular truncate text-[11px] text-foreground/90">{value}</span>
    </span>
  );
}

export function TitleBar(): React.JSX.Element {
  const activeView = useNavigationStore((state) => state.activeView);
  const engineering = useNavigationStore((state) => state.engineeringMode);
  const setEngineering = useNavigationStore((state) => state.setEngineeringMode);
  const view = getView(activeView);

  const scenarioName = useSimulationStore((state) => state.config.name);
  const algorithmId = useSimulationStore((state) => state.algorithmId);
  const patMode = useSimulationStore((state) => state.patMode);
  const autonomy = useSimulationStore((state) => state.autonomyEnabled);
  const status = useSimulationStore((state) => state.status);
  const time = useSimulationStore((state) => state.time);
  const recording = useSimulationStore((state) => state.recorderStatus?.state === 'running');

  const algorithmName =
    ALGORITHMS.find((plugin) => plugin.manifest.id === algorithmId)?.manifest.name ?? algorithmId;
  const state = patMode === null ? null : PAT_STATE[patMode];

  return (
    <header className="flex h-11 shrink-0 items-center gap-3 border-b border-panel-border bg-panel px-3">
      <span className="flex shrink-0 items-center gap-1.5">
        <Crosshair aria-hidden className="size-4 text-status-active" />
        <span className="flex min-w-0 flex-col leading-none">
          <span className="text-[13px] font-semibold tracking-tight">AstraLock-X</span>
          {/* What the product is, once, in the one place every screenshot
              includes. Small enough that it never competes with the run. */}
          <span className="hidden text-[8.5px] leading-tight tracking-[0.03em] text-muted-foreground 2xl:inline">
            Mobile FSOC coarse pointing, acquisition &amp; tracking — development and verification
          </span>
        </span>
      </span>

      <span className="h-5 w-px shrink-0 bg-panel-border" />
      <h1 className="shrink-0 text-[11px] font-semibold tracking-[0.08em] text-foreground/75 uppercase">
        {view.label}
      </h1>

      <span className="hidden min-w-0 items-center gap-3.5 xl:flex">
        <span className="h-4 w-px shrink-0 bg-panel-border" />
        <Field label="Scenario" value={scenarioName} />
        <Field label="Tracker" value={algorithmName} />
        <Field label="T" value={`${time.toFixed(2)} s`} />
        <Field
          label="Clock"
          value={status === 'running' ? 'running' : status === 'paused' ? 'paused' : 'stopped'}
        />
      </span>

      <span className="ml-auto flex shrink-0 items-center gap-1.5">
        {recording && <StatusBadge status="fault" label="Recording" pulse />}

        {autonomy && state !== null ? (
          <StatusBadge status={state.status} label={state.label} pulse={state.pulse ?? false} />
        ) : (
          <StatusBadge status="idle" label="Autonomy off" />
        )}

        {/* The one control in the title bar, because it applies everywhere. */}
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              type="button"
              aria-label={
                engineering ? 'Switch to flight-representative view' : 'Switch to engineering view'
              }
              aria-pressed={engineering}
              onClick={() => {
                setEngineering(!engineering);
              }}
              className={cn(
                'flex h-6 items-center gap-1 rounded-sm border px-1.5 text-[9px] font-semibold tracking-[0.08em] uppercase transition-colors',
                engineering
                  ? 'border-truth/50 bg-truth/12 text-truth'
                  : 'border-panel-border text-muted-foreground hover:text-foreground',
              )}
            >
              {engineering ? (
                <ShieldAlert aria-hidden className="size-3" />
              ) : (
                <ShieldOff aria-hidden className="size-3" />
              )}
              {engineering ? 'Engineering' : 'Flight view'}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-72">
            {engineering
              ? 'Engineering view: privileged simulator state may be shown, always violet-edged and labelled. Switch it off to show only what the terminal itself could know.'
              : 'Flight-representative view: nothing on screen is privileged. The simulation is unchanged — only the display is.'}
          </TooltipContent>
        </Tooltip>

        {view.status === 'not-implemented' && <StatusBadge status="idle" label="Not implemented" />}
      </span>
    </header>
  );
}
