import { getView } from '@/app/views';
import { Badge } from '@/components/ui/badge';
import { useNavigationStore } from '@/stores/navigation-store';

/** Header naming the active view and its build status. */
export function TitleBar(): React.JSX.Element {
  const activeView = useNavigationStore((state) => state.activeView);
  const view = getView(activeView);

  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b px-4">
      <h1 className="text-sm font-semibold">{view.label}</h1>
      <span className="truncate text-sm text-muted-foreground">{view.summary}</span>
      {view.status === 'not-implemented' && (
        <Badge variant="outline" className="ml-auto shrink-0 border-dashed font-mono text-[10px]">
          NOT IMPLEMENTED
        </Badge>
      )}
    </header>
  );
}
