import { readAppInfo } from '@/lib/app-info';

/**
 * Footer showing facts about this build.
 *
 * Every field is read from the running process — the version is injected from
 * package.json at build time, the mode comes from Vite, and the host is
 * detected from the presence of the Tauri bridge. There is no telemetry here
 * because there is nothing yet to report.
 */
export function StatusBar(): React.JSX.Element {
  const info = readAppInfo();

  return (
    <footer className="flex h-7 shrink-0 items-center gap-4 border-t bg-card/40 px-4 text-[11px] text-muted-foreground">
      <span className="font-medium text-foreground/80">{info.name}</span>
      <span className="tabular">v{info.version}</span>
      <Field label="mode" value={info.mode} />
      <Field label="host" value={info.host} />
      <span className="tabular ml-auto">Phase 0 — foundation</span>
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
