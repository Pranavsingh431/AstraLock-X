/**
 * Mission Control: the operator's workstation.
 *
 * ## Layout
 *
 * Four resizable regions. The sensor feed is the largest by default because it
 * is the only thing on the screen a tracking algorithm actually receives — the
 * 3D twin beside it is privileged, and the diagnostics around it are derived.
 *
 * ```
 *   ┌────────┬──────────────────────┬─────────────┐
 *   │        │  sensor feed         │ estimator   │
 *   │controls├──────────────────────┤ controller  │
 *   │        │  3D digital twin     │ identity    │
 *   │        ├──────────────────────┤ channel     │
 *   │        │  telemetry           │             │
 *   └────────┴──────────────────────┴─────────────┘
 * ```
 *
 * Every region declares a minimum size, so dragging cannot reduce the sensor
 * feed to a sliver that is technically present and practically useless, and
 * every panel scrolls internally rather than pushing its neighbours off screen
 * — which is what makes this usable at 1366×768 as well as at 1920×1080.
 *
 * ## Layout presets
 *
 * Three, and they change **layout only**. A preset moves dividers; it does not
 * touch the simulation, the algorithm, the telemetry or what is hidden. That is
 * a property worth stating because the temptation with a "presentation mode" is
 * to quietly hide the failures, and this one cannot: nothing it changes is
 * connected to anything that produces a number.
 */

import { Columns3, Maximize2, Presentation, RotateCcw } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { ResizeHandle, SplitGroup, SplitPanel, StatusBadge, useGroupRef } from '@/components/astra';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useSimulationStore } from '@/stores/simulation-store';

import { useEngineeringView } from '@/app/privileged';

import { ChannelPanel } from './panels/ChannelPanel';
import { ControlRail } from './panels/ControlRail';
import { ControllerPanel } from './panels/ControllerPanel';
import { DetectorPanel } from './panels/DetectorPanel';
import { DigitalTwin } from './panels/DigitalTwin';
import { EstimatorPanel } from './panels/EstimatorPanel';
import { IdentityPanel } from './panels/IdentityPanel';
import { SensorFeed } from './panels/SensorFeed';
import { TelemetryDock } from './panels/TelemetryDock';
import { GroundTruthInspector } from './components/GroundTruthInspector';

/**
 * The three layouts, as column and row splits.
 *
 * `operations` is the working default. `analysis` trades sensor area for
 * telemetry and diagnostics. `presentation` gives almost everything to the
 * sensor feed and the twin, for a screenshot or a demonstration — it keeps the
 * diagnostics visible, because a presentation that hid them would be showing a
 * different product from the one that exists.
 */
const PRESETS = {
  operations: {
    columns: { 'mc-rail': 17, 'mc-centre': 58, 'mc-diagnostics': 25 },
    centre: { 'mc-sensor': 46, 'mc-twin': 32, 'mc-telemetry': 22 },
  },
  analysis: {
    columns: { 'mc-rail': 15, 'mc-centre': 52, 'mc-diagnostics': 33 },
    centre: { 'mc-sensor': 32, 'mc-twin': 26, 'mc-telemetry': 42 },
  },
  presentation: {
    columns: { 'mc-rail': 0, 'mc-centre': 74, 'mc-diagnostics': 26 },
    centre: { 'mc-sensor': 56, 'mc-twin': 34, 'mc-telemetry': 10 },
  },
} as const;

type PresetName = keyof typeof PRESETS;

const PRESET_META: Record<PresetName, { label: string; icon: typeof Columns3; hint: string }> = {
  operations: {
    label: 'Operations',
    icon: Columns3,
    hint: 'The working layout: controls, sensor feed, diagnostics.',
  },
  analysis: {
    label: 'Analysis',
    icon: Maximize2,
    hint: 'More telemetry and diagnostics, less sensor area.',
  },
  presentation: {
    label: 'Presentation',
    icon: Presentation,
    hint: 'Maximises the sensor feed and the twin. Layout only — nothing is hidden and nothing changes.',
  },
};

export function MissionControlView(): React.JSX.Element {
  const [preset, setPreset] = useState<PresetName>('operations');
  const columnsRef = useGroupRef();
  const centreRef = useGroupRef();
  // The rail is collapsed by the presentation preset rather than removed, so
  // its state is layout and nothing depends on it.
  const railCollapsed = useRef(false);

  const engineering = useEngineeringView();
  const truthOverlay = useSimulationStore((state) => state.showTruthOverlay);
  const disturbanceTruth = useSimulationStore((state) => state.showDisturbanceTruth);

  const apply = useCallback(
    (name: PresetName) => {
      setPreset(name);
      const layout = PRESETS[name];
      railCollapsed.current = layout.columns['mc-rail'] === 0;
      columnsRef.current?.setLayout({ ...layout.columns });

      // In the flight-representative view the twin is not mounted, so its share
      // goes to the sensor feed rather than to a panel that is not there.
      const centre = engineering
        ? { ...layout.centre }
        : {
            'mc-sensor': layout.centre['mc-sensor'] + layout.centre['mc-twin'],
            'mc-telemetry': layout.centre['mc-telemetry'],
          };
      centreRef.current?.setLayout(centre);
    },
    [columnsRef, centreRef, engineering],
  );

  // Re-apply after the centre group remounts on a view-mode change, so the
  // chosen preset survives it.
  useEffect(() => {
    const layout = PRESETS[preset];
    centreRef.current?.setLayout(
      engineering
        ? { ...layout.centre }
        : {
            'mc-sensor': layout.centre['mc-sensor'] + layout.centre['mc-twin'],
            'mc-telemetry': layout.centre['mc-telemetry'],
          },
    );
  }, [engineering, preset, centreRef]);

  const anyTruthVisible = engineering && (truthOverlay || disturbanceTruth);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Layout controls. Deliberately small and out of the way: they change
          nothing an engineer would be measuring. */}
      <div className="flex shrink-0 items-center gap-1 border-b border-panel-border bg-panel-header/60 px-2 py-1">
        <span className="mr-1 text-[9px] tracking-[0.08em] text-muted-foreground uppercase">
          Layout
        </span>
        {(Object.keys(PRESETS) as PresetName[]).map((name) => {
          const meta = PRESET_META[name];
          const Icon = meta.icon;
          return (
            <Tooltip key={name}>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  aria-label={`${meta.label} layout`}
                  aria-pressed={preset === name}
                  onClick={() => {
                    apply(name);
                  }}
                  className={cn(
                    'flex h-6 items-center gap-1 rounded-sm border px-1.5 text-[9px] font-semibold tracking-wider uppercase transition-colors',
                    preset === name
                      ? 'border-status-active/50 bg-status-active/12 text-status-active'
                      : 'border-panel-border text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Icon aria-hidden className="size-3" />
                  {meta.label}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{meta.hint}</TooltipContent>
            </Tooltip>
          );
        })}

        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-1.5 text-[9px]"
          aria-label="Reset layout"
          onClick={() => {
            apply('operations');
          }}
        >
          <RotateCcw className="size-3" />
          Reset
        </Button>

        <div className="ml-auto flex items-center gap-1.5">
          {preset === 'presentation' && <StatusBadge status="active" label="Presentation view" />}
          {anyTruthVisible && (
            <StatusBadge
              status="idle"
              label="Ground truth visible"
              className="border-truth/50 bg-truth/12 text-truth"
            />
          )}
        </div>
      </div>

      <SplitGroup
        groupRef={columnsRef}
        orientation="horizontal"
        className="min-h-0 flex-1"
        id="mission-control-columns"
      >
        <SplitPanel
          id="mc-rail"
          defaultSize="17"
          minSize="13"
          maxSize="30"
          collapsible
          collapsedSize="0"
          className="min-w-0"
        >
          <ControlRail />
        </SplitPanel>

        <ResizeHandle direction="horizontal" />

        <SplitPanel id="mc-centre" defaultSize="58" minSize="34" className="min-w-0">
          {/* Keyed on the view mode. A resizable group registers its panels
              once, so adding or removing one under a live group leaves its
              constraint table stale; remounting is both simpler and more
              honest, since the panel set genuinely differs between the two
              views. The preset is re-applied below so the remount does not
              throw away a layout the operator chose. */}
          <SplitGroup
            key={engineering ? 'with-twin' : 'sensor-only'}
            groupRef={centreRef}
            orientation="vertical"
            className="h-full"
            id="mission-control-centre"
          >
            <SplitPanel id="mc-sensor" defaultSize="46" minSize="22">
              <SensorFeed />
            </SplitPanel>

            <ResizeHandle direction="vertical" />

            {engineering && (
              <>
                <SplitPanel id="mc-twin" defaultSize="32" minSize="14">
                  <DigitalTwin />
                </SplitPanel>

                <ResizeHandle direction="vertical" />
              </>
            )}

            <SplitPanel id="mc-telemetry" defaultSize="22" minSize="10">
              <TelemetryDock />
            </SplitPanel>
          </SplitGroup>
        </SplitPanel>

        <ResizeHandle direction="horizontal" />

        <SplitPanel
          id="mc-diagnostics"
          defaultSize="25"
          minSize="16"
          maxSize="40"
          className="min-w-0"
        >
          {/* One scrolling column. The panels are `shrink-0` on purpose: as
              flex children they would otherwise be compressed to fit, which
              slices each one mid-row and reads as a rendering fault rather
              than as a list that scrolls. Whole panels, scrolled. */}
          <div className="flex h-full min-h-0 flex-col gap-1.5 overflow-y-auto p-1.5 [&>section]:shrink-0">
            <DetectorPanel />
            <EstimatorPanel />
            <ControllerPanel />
            <IdentityPanel />
            <ChannelPanel />
          </div>
        </SplitPanel>
      </SplitGroup>

      {engineering && <GroundTruthInspector />}
    </div>
  );
}
