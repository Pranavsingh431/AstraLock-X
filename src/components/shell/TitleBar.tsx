import { Crosshair } from 'lucide-react';

import { getView } from '@/app/views';
import type { PATMode } from '@/core/contracts/pat';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { useNavigationStore } from '@/stores/navigation-store';
import { useSimulationStore } from '@/stores/simulation-store';

/**
 * The PAT state, as a chip.
 *
 * Colour carries the same meaning as the badge beside the autonomy controls,
 * and never carries it alone: every state spells its own name. A screenshot has
 * to be readable in grayscale and by someone who does not know the palette.
 */
const STATE_STYLE: Partial<Record<PATMode, string>> = {
  scan: 'border-sky-500/50 bg-sky-500/10 text-sky-700',
  acquire: 'border-blue-400/60 bg-blue-500/10 text-blue-700',
  track: 'border-emerald-500/60 bg-emerald-500/10 text-emerald-700',
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
  handoff: 'HANDOFF READY',
};

const ALGORITHM_LABEL: Record<string, string> = {
  'baseline-kf-pid': 'Baseline KF + PID',
  'astralock-x': 'AstraLock-X',
};

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <span className="flex min-w-0 items-baseline gap-1.5">
      <span className="text-[9px] tracking-wider text-muted-foreground uppercase">{label}</span>
      <span className="tabular truncate text-[11px] text-foreground/90">{value}</span>
    </span>
  );
}

/** Header naming the product, the active run and the tracker's state. */
export function TitleBar(): React.JSX.Element {
  const activeView = useNavigationStore((state) => state.activeView);
  const view = getView(activeView);

  const config = useSimulationStore((state) => state.config);
  const algorithmId = useSimulationStore((state) => state.algorithmId);
  const patMode = useSimulationStore((state) => state.patMode);
  const autonomy = useSimulationStore((state) => state.autonomyEnabled);
  const time = useSimulationStore((state) => state.time);
  const recording = useSimulationStore((state) => state.recorderStatus?.state === 'running');

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b bg-card/30 px-4">
      <span className="flex shrink-0 items-center gap-2">
        <Crosshair aria-hidden className="size-4 text-cyan-700" />
        <span className="text-sm font-semibold tracking-tight">AstraLock-X</span>
      </span>

      <span className="h-4 w-px shrink-0 bg-border" />
      <h1 className="shrink-0 text-[13px] font-medium text-foreground/80">{view.label}</h1>

      <span className="hidden min-w-0 items-center gap-4 lg:flex">
        <span className="h-4 w-px shrink-0 bg-border" />
        <Field label="Scenario" value={config.name} />
        <Field label="Algorithm" value={ALGORITHM_LABEL[algorithmId] ?? algorithmId} />
        <Field label="T" value={`${time.toFixed(2)} s`} />
      </span>

      <span className="ml-auto flex shrink-0 items-center gap-2">
        {recording && (
          <Badge
            variant="outline"
            className="gap-1.5 border-red-500/60 bg-red-500/10 text-[10px] font-semibold tracking-wider text-red-700 uppercase"
          >
            <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-red-500" />
            Recording
          </Badge>
        )}

        {autonomy && patMode !== null ? (
          <Badge
            variant="outline"
            className={cn(
              'text-[10px] font-semibold tracking-wider uppercase',
              STATE_STYLE[patMode] ?? 'text-muted-foreground',
            )}
          >
            {STATE_LABEL[patMode] ?? patMode}
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase"
          >
            Autonomy off
          </Badge>
        )}

        {view.status === 'not-implemented' && (
          <Badge variant="outline" className="shrink-0 border-dashed font-mono text-[10px]">
            NOT IMPLEMENTED
          </Badge>
        )}
      </span>
    </header>
  );
}
