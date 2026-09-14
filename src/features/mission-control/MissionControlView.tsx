/**
 * Mission Control: the observer view of a running simulation.
 *
 * This is a ground-truth engineering view, and it is labelled as one. The
 * camera sensor feed a tracker will eventually see is a different thing
 * entirely and arrives with the sensor models in Phase 2; conflating the two is
 * exactly the confusion the banner exists to prevent.
 */

import { Canvas } from '@react-three/fiber';
import { Axis3d, Grid3x3, Route } from 'lucide-react';
import { useState } from 'react';

import { radiansToMicroradians } from '@/core/contracts/units';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSimulationStore } from '@/stores/simulation-store';

import { ObserverScene } from './components/ObserverScene';
import { SensorPanel } from './components/SensorPanel';
import { OBSERVER_COLORS } from './components/observer-colors';
import { GroundTruthInspector } from './components/GroundTruthInspector';
import { ScenarioIoBar } from './components/ScenarioIoBar';
import { SimulationControls } from './components/SimulationControls';

function Readout({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-[10px] tracking-wider text-muted-foreground uppercase">{label}</span>
      <span className="tabular text-sm text-foreground/90">{value}</span>
    </div>
  );
}

function LegendSwatch({ color, label }: { color: string; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1.5">
      <span aria-hidden className="size-2 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

export function MissionControlView(): React.JSX.Element {
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(true);
  const [showPaths, setShowPaths] = useState(true);

  const tick = useSimulationStore((state) => state.tick);
  const time = useSimulationStore((state) => state.time);
  const config = useSimulationStore((state) => state.config);
  const pointingError = useSimulationStore((state) => state.currentFrame.pointingError);
  const trajectoryKind = config.targets[0]?.trajectory.kind ?? 'none';

  return (
    <div className="flex h-full min-h-0">
      <div className="flex min-w-0 flex-1 flex-col">
        <SimulationControls />

        <div className="flex flex-wrap items-center gap-5 border-b px-4 py-2">
          <Readout label="Tick" value={String(tick)} />
          <Readout label="Sim time" value={`${time.toFixed(3)} s`} />
          <Readout label="Scenario" value={config.name} />
          <Readout label="Root seed" value={String(config.seed)} />
          <Readout label="Trajectory" value={trajectoryKind} />
          <Readout
            label="True pointing error"
            value={
              pointingError === null
                ? '—'
                : `${radiansToMicroradians(pointingError as never).toFixed(0)} µrad`
            }
          />
          <div className="ml-auto">
            <ScenarioIoBar />
          </div>
        </div>

        <div className="relative min-h-0 flex-1">
          <Canvas
            camera={{ position: [1100, 700, 900], fov: 45, near: 1, far: 40_000 }}
            gl={{ antialias: true }}
            className="bg-[#0a1016]"
          >
            <ObserverScene showGrid={showGrid} showAxes={showAxes} showPaths={showPaths} />
          </Canvas>

          <div className="pointer-events-none absolute top-3 left-3 flex flex-col gap-2">
            <Badge
              variant="outline"
              className="pointer-events-auto border-amber-500/40 bg-background/80 font-mono text-[10px] tracking-wider text-amber-400 backdrop-blur"
            >
              3D WORLD — GROUND TRUTH / OBSERVER
            </Badge>
            <span className="pointer-events-auto rounded bg-background/70 px-2 py-1 text-[10px] text-muted-foreground backdrop-blur">
              Not the tracking sensor feed. Markers are not to scale.
            </span>
          </div>

          <div className="pointer-events-auto absolute top-3 right-3 flex gap-1">
            {(
              [
                ['Grid', showGrid, setShowGrid, Grid3x3],
                ['Axes', showAxes, setShowAxes, Axis3d],
                ['Paths', showPaths, setShowPaths, Route],
              ] as const
            ).map(([label, value, setValue, Icon]) => (
              <Button
                key={label}
                size="sm"
                variant="outline"
                aria-label={label}
                aria-pressed={value}
                className={cn(
                  'h-7 gap-1.5 bg-background/80 px-2 text-xs backdrop-blur',
                  value && 'bg-accent',
                )}
                onClick={() => {
                  setValue(!value);
                }}
              >
                <Icon aria-hidden className="size-3" />
                {label}
              </Button>
            ))}
          </div>

          <div className="pointer-events-none absolute bottom-3 left-3 flex flex-wrap gap-3 rounded bg-background/70 px-2.5 py-1.5 text-[10px] text-muted-foreground backdrop-blur">
            <LegendSwatch color={OBSERVER_COLORS.target} label="Target" />
            <LegendSwatch color={OBSERVER_COLORS.beacon} label="Beacon" />
            <LegendSwatch color={OBSERVER_COLORS.observer} label="Observer" />
            <LegendSwatch color={OBSERVER_COLORS.boresight} label="Boresight" />
            <LegendSwatch color={OBSERVER_COLORS.path} label="Path" />
            <span className="opacity-70">+X East · +Y Up · −Z North</span>
          </div>
        </div>
      </div>

      <SensorPanel />
      <GroundTruthInspector />
    </div>
  );
}
