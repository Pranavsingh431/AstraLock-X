/**
 * The workspace rail.
 *
 * Six workspaces, named rather than only drawn: an icon alone makes a reader
 * hover to find out where they are, and this is an instrument, not a phone.
 * The active workspace is marked three ways — a cyan bar on the leading edge,
 * a lighter ground, and `aria-current` — so it survives a grayscale screenshot
 * and a screen reader equally.
 *
 * Unimplemented workspaces are dimmed and carry a dot, and they still open:
 * each one says what it will do and what has to exist first, which is more
 * useful than hiding it and more honest than filling it with invented numbers.
 */

import { VIEWS } from '@/app/views';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { modifierKeyLabel } from '@/lib/app-info';
import { cn } from '@/lib/utils';
import { useNavigationStore } from '@/stores/navigation-store';

export function NavRail(): React.JSX.Element {
  const activeView = useNavigationStore((state) => state.activeView);
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  return (
    <nav
      aria-label="Primary"
      className="flex w-[74px] shrink-0 flex-col items-stretch gap-px border-r border-panel-border bg-panel-header/70 py-1.5"
    >
      <div
        aria-hidden
        className="mx-auto mb-1.5 flex size-8 items-center justify-center rounded-sm border border-status-active/40 bg-status-active/10 font-mono text-[11px] font-bold tracking-tight text-status-active"
      >
        AX
      </div>

      {VIEWS.map((view, index) => {
        const Icon = view.icon;
        const isActive = view.id === activeView;
        const pending = view.status === 'not-implemented';

        return (
          <Tooltip key={view.id}>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={view.label}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => {
                  setActiveView(view.id);
                }}
                className={cn(
                  'relative flex flex-col items-center gap-0.5 px-1 py-1.5 transition-colors',
                  isActive
                    ? 'bg-status-active/10 text-status-active'
                    : 'text-muted-foreground hover:bg-accent/30 hover:text-foreground',
                  pending && !isActive && 'opacity-55',
                )}
              >
                {isActive && (
                  <span
                    aria-hidden
                    className="absolute top-1 bottom-1 left-0 w-[2px] bg-status-active"
                  />
                )}
                <Icon aria-hidden className="size-4" />
                <span className="text-center text-[8.5px] leading-[1.15] font-semibold tracking-[0.04em] uppercase">
                  {view.label}
                </span>
                {/* Future work, marked rather than hidden: an empty tool
                    presented as operational is worse than an honest label. */}
                {pending && (
                  <span
                    aria-hidden
                    className="absolute top-1 right-1 rounded-sm border border-panel-border bg-secondary px-0.5 text-[6.5px] font-semibold tracking-[0.04em] text-muted-foreground uppercase"
                  >
                    Future
                  </span>
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="right" className="max-w-56">
              <span className="flex items-center gap-2">
                <span className="font-semibold">{view.label}</span>
                <span className="font-mono text-muted-foreground">
                  {modifierKeyLabel()}
                  {index + 1}
                </span>
              </span>
              <span className="mt-0.5 block text-muted-foreground">
                {pending
                  ? `Future work — not part of this prototype. ${view.summary}`
                  : view.summary}
              </span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
