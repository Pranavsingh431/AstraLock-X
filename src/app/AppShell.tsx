import { AstraBenchView } from '@/features/astrabench/AstraBenchView';
import { CalibrationView } from '@/features/calibration/CalibrationView';
import { MissionControlView } from '@/features/mission-control/MissionControlView';
import { ReplayView } from '@/features/replay/ReplayView';
import { ReportsView } from '@/features/reports/ReportsView';
import { ScenarioLabView } from '@/features/scenario-lab/ScenarioLabView';
import { NavRail } from '@/components/shell/NavRail';
import { StatusBar } from '@/components/shell/StatusBar';
import { TitleBar } from '@/components/shell/TitleBar';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useNavigationStore } from '@/stores/navigation-store';

import { useViewShortcuts } from './use-view-shortcuts';
import type { ViewId } from './views';

/**
 * Maps a view id to its component.
 *
 * An exhaustive `Record` rather than a lookup with a fallback: adding a view id
 * without wiring a component becomes a compile error instead of a blank panel.
 */
const VIEW_COMPONENTS: Record<ViewId, () => React.JSX.Element> = {
  'mission-control': MissionControlView,
  'scenario-lab': ScenarioLabView,
  astrabench: AstraBenchView,
  replay: ReplayView,
  calibration: CalibrationView,
  reports: ReportsView,
};

/** Application frame: navigation rail, header, active view, status bar. */
export function AppShell(): React.JSX.Element {
  const activeView = useNavigationStore((state) => state.activeView);
  useViewShortcuts();

  const ActiveView = VIEW_COMPONENTS[activeView];

  return (
    <TooltipProvider>
      <div className="flex h-full w-full overflow-hidden bg-background">
        <NavRail />
        <div className="flex min-w-0 flex-1 flex-col">
          <TitleBar />
          <main className="min-h-0 flex-1 overflow-hidden">
            <ActiveView />
          </main>
          <StatusBar />
        </div>
      </div>
    </TooltipProvider>
  );
}
