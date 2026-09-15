/**
 * The engineering observer: where everything actually is.
 *
 * **Privileged, and framed as such.** This view reads the simulator's own world
 * state — true positions, true trajectories, the true boresight — which no
 * tracking algorithm receives. It is one of the three consumers ADR-0003
 * permits: a debug view explicitly marked as one. Its border and header are the
 * truth colour for exactly that reason, so nobody reading a screenshot mistakes
 * it for something the tracker worked out.
 *
 * Everything drawn comes from the running simulation. There is no decorative
 * motion, no spacecraft asset, and no object in the scene that the scenario did
 * not put there.
 */

import { Canvas } from '@react-three/fiber';
import { Axis3d, Box, Grid3x3, Route, Video } from 'lucide-react';
import { useState } from 'react';

import { Panel, PanelHeader, StatusBadge } from '@/components/astra';
import { cn } from '@/lib/utils';
import { useSimulationStore } from '@/stores/simulation-store';

import { ObserverScene } from '../components/ObserverScene';
import { OBSERVER_COLORS } from '../components/observer-colors';

function ViewToggle({
  label,
  icon: Icon,
  pressed,
  onChange,
}: {
  label: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  pressed: boolean;
  onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={() => {
        onChange(!pressed);
      }}
      className={cn(
        'flex h-6 items-center gap-1 rounded-sm border px-1.5 text-[9px] font-semibold tracking-wider uppercase backdrop-blur transition-colors',
        pressed
          ? 'border-truth/50 bg-truth/15 text-truth'
          : 'border-panel-border bg-background/70 text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon aria-hidden className="size-3" />
      {label}
    </button>
  );
}

function Swatch({ color, label }: { color: string; label: string }): React.JSX.Element {
  return (
    <span className="flex items-center gap-1">
      <span aria-hidden className="size-1.5 rounded-full" style={{ backgroundColor: color }} />
      {label}
    </span>
  );
}

export function DigitalTwin(): React.JSX.Element {
  const [showGrid, setShowGrid] = useState(true);
  const [showAxes, setShowAxes] = useState(false);
  const [showPaths, setShowPaths] = useState(true);
  const [showFov, setShowFov] = useState(true);

  const targets = useSimulationStore((state) => state.config.targets);
  const decoys = Math.max(0, targets.length - 1);

  return (
    <Panel tone="truth" className="h-full">
      <PanelHeader
        tone="truth"
        icon={Box}
        title="3D digital twin — ground truth / engineering observer"
        subtitle="Where everything really is. Not the tracking sensor feed, and no algorithm sees it."
        actions={
          <StatusBadge
            status="idle"
            label="Truth"
            className="border-truth/50 bg-truth/15 text-truth"
          />
        }
      />

      <div className="relative min-h-0 flex-1">
        <Canvas
          camera={{ position: [1100, 620, 820], fov: 42, near: 1, far: 40_000 }}
          gl={{ antialias: true }}
          className="bg-[#0b1420]"
        >
          <ObserverScene
            showGrid={showGrid}
            showAxes={showAxes}
            showPaths={showPaths}
            showFov={showFov}
          />
        </Canvas>

        <div className="absolute top-2 right-2 flex gap-1">
          <ViewToggle label="Grid" icon={Grid3x3} pressed={showGrid} onChange={setShowGrid} />
          <ViewToggle label="Axes" icon={Axis3d} pressed={showAxes} onChange={setShowAxes} />
          <ViewToggle label="Paths" icon={Route} pressed={showPaths} onChange={setShowPaths} />
          <ViewToggle label="FOV" icon={Video} pressed={showFov} onChange={setShowFov} />
        </div>

        <div className="pointer-events-none absolute bottom-2 left-2 flex flex-wrap items-center gap-x-2.5 gap-y-1 rounded-sm border border-panel-border/70 bg-background/80 px-2 py-1 text-[9px] text-muted-foreground backdrop-blur">
          <Swatch color={OBSERVER_COLORS.target} label="Designated terminal" />
          {decoys > 0 && (
            <Swatch
              color={OBSERVER_COLORS.decoy}
              label={decoys === 1 ? 'Other source' : `${String(decoys)} other sources`}
            />
          )}
          <Swatch color={OBSERVER_COLORS.boresight} label="Boresight · FOV" />
          <Swatch color={OBSERVER_COLORS.path} label="Trajectory" />
          <span className="opacity-60">+X East · +Y Up · −Z North · markers are not to scale</span>
        </div>
      </div>
    </Panel>
  );
}
