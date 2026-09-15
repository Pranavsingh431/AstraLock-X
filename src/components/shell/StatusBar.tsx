/**
 * The build and run strip along the bottom.
 *
 * Every field is read from the running process or the running simulation: the
 * version is injected from package.json at build time, the mode comes from
 * Vite, the host is detected from the presence of the Tauri bridge, and the
 * clock, frame and seed values come from the engine. There is no progress bar,
 * no "system health" percentage and no uptime — nothing here is a number
 * invented to fill the space, because a status bar is exactly where an invented
 * number would go unchallenged.
 */

import { readAppInfo } from '@/lib/app-info';
import { cn } from '@/lib/utils';
import { useNavigationStore } from '@/stores/navigation-store';
import { useSimulationStore } from '@/stores/simulation-store';

function Field({
  label,
  value,
  tone = 'default',
}: {
  label: string;
  value: string;
  tone?: 'default' | 'warning';
}): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span className="opacity-55">{label}</span>
      <span
        className={cn(
          'tabular',
          tone === 'warning' ? 'text-status-degraded' : 'text-foreground/80',
        )}
      >
        {value}
      </span>
    </span>
  );
}

export function StatusBar(): React.JSX.Element {
  const info = readAppInfo();
  const engineering = useNavigationStore((state) => state.engineeringMode);
  const time = useSimulationStore((state) => state.time);
  const tick = useSimulationStore((state) => state.tick);
  const seed = useSimulationStore((state) => state.config.seed);
  const rasterized = useSimulationStore((state) => state.framesRasterized);
  const dropped = useSimulationStore((state) => state.framesDropped);
  const recording = useSimulationStore((state) => state.recorderStatus?.state === 'running');

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3.5 border-t border-panel-border bg-panel-header px-3 text-[10px] text-muted-foreground">
      <span className="font-medium text-foreground/70">{info.name}</span>
      <span className="tabular">v{info.version}</span>
      <Field label="mode" value={info.mode} />
      <Field label="host" value={info.host} />

      <span className="h-3 w-px bg-panel-border" />
      <Field label="t" value={`${time.toFixed(3)} s`} />
      <Field label="tick" value={String(tick)} />
      <Field label="frames" value={String(rasterized)} />
      {dropped > 0 && <Field label="dropped" value={String(dropped)} tone="warning" />}

      <span className="h-3 w-px bg-panel-border" />
      {/* The seed is the whole reproducibility claim in one field: same seed,
          same scenario, same numbers, on any machine. */}
      <Field label="seed" value={String(seed)} />

      <span className="ml-auto flex items-center gap-3.5">
        {recording && (
          <span className="flex items-center gap-1.5 text-status-fault">
            <span aria-hidden className="astra-pulse size-1.5 rounded-full bg-status-fault" />
            <span className="tracking-[0.08em] uppercase">recording</span>
          </span>
        )}
        <span
          className={cn('tracking-[0.08em] uppercase', engineering ? 'text-truth' : 'opacity-55')}
        >
          {engineering ? 'engineering view' : 'flight view'}
        </span>
      </span>
    </footer>
  );
}
