import { VIEWS } from '@/app/views';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { modifierKeyLabel } from '@/lib/app-info';
import { cn } from '@/lib/utils';
import { useNavigationStore } from '@/stores/navigation-store';

/** Icon rail listing every view, with the active one highlighted. */
export function NavRail(): React.JSX.Element {
  const activeView = useNavigationStore((state) => state.activeView);
  const setActiveView = useNavigationStore((state) => state.setActiveView);

  return (
    <nav
      aria-label="Primary"
      className="flex w-14 shrink-0 flex-col items-center gap-1 border-r bg-card/40 py-3"
    >
      <div
        aria-hidden
        className="mb-2 flex size-8 items-center justify-center rounded-md bg-primary/10 font-mono text-[11px] font-bold tracking-tight text-primary"
      >
        AX
      </div>

      {VIEWS.map((view, index) => {
        const Icon = view.icon;
        const isActive = view.id === activeView;

        return (
          <Tooltip key={view.id}>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label={view.label}
                aria-current={isActive ? 'page' : undefined}
                onClick={() => {
                  setActiveView(view.id);
                }}
                className={cn(
                  'relative text-muted-foreground hover:text-foreground',
                  isActive && 'bg-accent text-foreground',
                )}
              >
                {isActive && (
                  <span
                    aria-hidden
                    className="absolute left-0 h-5 w-0.5 rounded-r-full bg-primary"
                  />
                )}
                <Icon aria-hidden />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" className="flex items-center gap-2">
              <span>{view.label}</span>
              <span className="font-mono text-muted-foreground">
                {modifierKeyLabel()}
                {index + 1}
              </span>
            </TooltipContent>
          </Tooltip>
        );
      })}
    </nav>
  );
}
