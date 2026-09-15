import { readAppInfo } from '@/lib/app-info';
import { useSimulationStore } from '@/stores/simulation-store';

/**
 * Footer showing facts about this build and the live run.
 *
 * Every field is read from the running process or the running simulation — the
 * version is injected from package.json at build time, the mode comes from
 * Vite, the host is detected from the presence of the Tauri bridge, and the
 * clock and frame counters come from the engine. Nothing here is decorative.
 */
export function StatusBar(): React.JSX.Element {
  const info = readAppInfo();
  const time = useSimulationStore((state) => state.time);
  const tick = useSimulationStore((state) => state.tick);
  const rasterized = useSimulationStore((state) => state.framesRasterized);
  const dropped = useSimulationStore((state) => state.framesDropped);
  const recording = useSimulationStore((state) => state.recorderStatus?.state === 'running');

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t bg-card/40 px-4 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground/80">{info.name}</span>
      <span className="tabular">v{info.version}</span>
      <Field label="mode" value={info.mode} />
      <Field label="host" value={info.host} />

      <span className="h-3 w-px bg-border" />
      <Field label="t" value={`${time.toFixed(3)} s`} />
      <Field label="tick" value={String(tick)} />
      <Field label="frames" value={String(rasterized)} />
      {dropped > 0 && (
        <span className="flex items-center gap-1.5 text-amber-700/90">
          <span className="opacity-70">dropped</span>
          <span className="tabular">{dropped}</span>
        </span>
      )}

      {recording && (
        <span className="ml-auto flex items-center gap-1.5 text-red-700">
          <span aria-hidden className="size-1.5 animate-pulse rounded-full bg-red-500" />
          <span className="tracking-wider uppercase">recording</span>
        </span>
      )}
      <span className={recording ? 'tabular' : 'tabular ml-auto'}>
        Phase 7 — disturbance engine
      </span>
    </footer>
  );
}

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span className="opacity-60">{label}</span>
      <span className="tabular text-foreground/80">{value}</span>
    </span>
  );
}
