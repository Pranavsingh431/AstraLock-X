/**
 * The sensor half of Mission Control.
 *
 * Labelled so it cannot be confused with the 3D observer beside it. The
 * observer shows where everything really is; this shows what the instrument can
 * actually see, which is all a tracking algorithm will ever get.
 *
 * The metadata below is what a real camera reports about itself. There is no
 * lock indicator, no detected centroid, no tracking error and no acquisition
 * time, because nothing in the system detects or tracks anything yet.
 */

import { Camera } from 'lucide-react';

import { radiansToDegrees } from '@/core/contracts/units';
import { Badge } from '@/components/ui/badge';
import { useSimulationStore } from '@/stores/simulation-store';

import { ActuatorTruthPanel } from './ActuatorTruthPanel';
import { AutonomyControls } from './AutonomyControls';
import { GimbalControls } from './GimbalControls';
import { CameraMonitor } from './CameraMonitor';
import { ResponseTrace } from './ResponseTrace';

function Field({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex flex-col">
      <span className="text-[9px] tracking-wider text-muted-foreground uppercase">{label}</span>
      <span className="tabular text-[11px] text-foreground/90">{value}</span>
    </div>
  );
}

export function SensorPanel(): React.JSX.Element {
  const frame = useSimulationStore((state) => state.sensorFrame);
  const config = useSimulationStore((state) => state.config);
  const measuredPan = useSimulationStore((state) => state.measuredPan);
  const measuredTilt = useSimulationStore((state) => state.measuredTilt);
  const scheduled = useSimulationStore((state) => state.framesScheduled);
  const superseded = useSimulationStore((state) => state.framesSupersededForDisplay);
  const showTruthOverlay = useSimulationStore((state) => state.showTruthOverlay);

  return (
    <section className="flex min-h-0 w-[380px] shrink-0 flex-col border-l bg-card/20">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Camera aria-hidden className="size-3.5 text-sky-400" />
        <h2 className="text-[11px] font-semibold tracking-wider text-sky-400 uppercase">
          Virtual camera — sensor feed
        </h2>
      </header>

      <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black p-2">
        <CameraMonitor />
        {showTruthOverlay && (
          <Badge
            variant="outline"
            className="pointer-events-none absolute top-3 left-3 border-amber-500/40 bg-background/80 font-mono text-[9px] tracking-wider text-amber-400 backdrop-blur"
          >
            GROUND TRUTH SENSOR OVERLAY — DEBUG ONLY
          </Badge>
        )}
      </div>

      <div className="grid grid-cols-3 gap-x-3 gap-y-2 border-t px-3 py-2">
        <Field label="Frame" value={frame === null ? '—' : String(frame.frameId)} />
        <Field
          label="Capture time"
          value={frame === null ? '—' : `${frame.captureTime.toFixed(4)} s`}
        />
        <Field
          label="Resolution"
          value={frame === null ? '—' : `${String(frame.width)}×${String(frame.height)}`}
        />
        <Field label="Configured FPS" value={`${String(config.camera.frameRate)} Hz`} />
        <Field label="Camera az" value={`${radiansToDegrees(measuredPan as never).toFixed(3)}°`} />
        <Field label="Camera el" value={`${radiansToDegrees(measuredTilt as never).toFixed(3)}°`} />
        <Field label="Format" value={frame?.format ?? '—'} />
        <Field label="Scheduled" value={String(scheduled)} />
        <Field label="Superseded" value={String(superseded)} />
      </div>

      {/* The mount's diagnostics scroll independently so a tall truth panel
          cannot squeeze the viewfinder above it. */}
      <div className="max-h-[46%] shrink-0 overflow-y-auto">
        <AutonomyControls />
        <GimbalControls />
        <div className="space-y-2.5 border-t px-3 py-2.5">
          <ResponseTrace axis="pan" />
          <ResponseTrace axis="tilt" />
        </div>
        <ActuatorTruthPanel />
      </div>
    </section>
  );
}
