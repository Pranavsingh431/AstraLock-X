/**
 * The virtual camera feed: the centre of the workstation.
 *
 * What appears here is the actual `CameraSensorFrame` the sensor produced and a
 * tracking algorithm was handed. It is not a second Three.js view dressed up to
 * look like a sensor, which is why it is given the most screen: if this image
 * is wrong, the sensor is wrong, and everything downstream is measuring the
 * wrong thing.
 *
 * ## Overlay layers
 *
 * Three, and they are kept visibly distinct because they come from different
 * places:
 *
 *   RETICLE     interface geometry — where the controller is aiming
 *   ALGORITHM   what the tracker worked out from these pixels
 *   EVALUATION  what only the simulator knows
 *
 * The first two are on by default. The third is not, and is violet and labelled
 * whenever it is: a screenshot of normal operation should show the tracker
 * tracking without any privileged information on screen at all.
 */

import { Camera, Crosshair, Eye, Scan } from 'lucide-react';

import { radiansToDegrees } from '@/core/contracts/units';
import { MetricReadout, Panel, PanelHeader, StatusBadge } from '@/components/astra';
import { cn } from '@/lib/utils';
import { useEngineeringView } from '@/app/privileged';
import { useSimulationStore } from '@/stores/simulation-store';

import { CameraMonitor } from '../components/CameraMonitor';
import { PatStateChip } from './PatStateChip';

/** A compact overlay toggle. Pressed state is on the button, not only in colour. */
function LayerToggle({
  label,
  name,
  icon: Icon,
  pressed,
  tone = 'default',
  onChange,
}: {
  label: string;
  /** The accessible name, when the visible chip is too terse to stand alone. */
  name?: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  pressed: boolean;
  tone?: 'default' | 'truth';
  onChange: (next: boolean) => void;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-label={name ?? label}
      aria-pressed={pressed}
      onClick={() => {
        onChange(!pressed);
      }}
      className={cn(
        'flex h-6 items-center gap-1 rounded-sm border px-1.5 text-[9px] font-semibold tracking-wider uppercase transition-colors',
        pressed
          ? tone === 'truth'
            ? 'border-truth/50 bg-truth/15 text-truth'
            : 'border-status-active/50 bg-status-active/12 text-status-active'
          : 'border-panel-border bg-transparent text-muted-foreground hover:text-foreground',
      )}
    >
      <Icon aria-hidden className="size-3" />
      {label}
    </button>
  );
}

export function SensorFeed(): React.JSX.Element {
  const frame = useSimulationStore((state) => state.sensorFrame);
  const config = useSimulationStore((state) => state.config);
  const measuredPan = useSimulationStore((state) => state.measuredPan);
  const measuredTilt = useSimulationStore((state) => state.measuredTilt);
  const dropped = useSimulationStore((state) => state.framesDropped);
  const superseded = useSimulationStore((state) => state.framesSupersededForDisplay);
  const scheduled = useSimulationStore((state) => state.framesScheduled);

  const showAlgorithm = useSimulationStore((state) => state.showAlgorithmOverlay);
  const setAlgorithm = useSimulationStore((state) => state.setAlgorithmOverlay);
  const showTruth = useSimulationStore((state) => state.showTruthOverlay);
  const setTruth = useSimulationStore((state) => state.setTruthOverlay);
  const showReticle = useSimulationStore((state) => state.showReticle);
  const engineering = useEngineeringView();
  const setReticle = useSimulationStore((state) => state.setReticle);

  return (
    <Panel className="h-full" aria-label="Virtual camera sensor feed">
      <PanelHeader
        icon={Camera}
        title="Virtual camera — sensor feed"
        subtitle="The pixels a tracking algorithm is handed"
        actions={<PatStateChip />}
      />

      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden bg-black p-1.5">
        <CameraMonitor />

        {showTruth && engineering && (
          <span className="pointer-events-none absolute top-2.5 left-2.5">
            <StatusBadge
              status="idle"
              label="Ground truth sensor overlay — debug only"
              className="border-truth/50 bg-truth/15 text-truth backdrop-blur"
            />
          </span>
        )}

        <div className="absolute right-2.5 bottom-2.5 flex gap-1">
          <LayerToggle
            label="Reticle"
            name="Boresight reticle"
            icon={Crosshair}
            pressed={showReticle}
            onChange={setReticle}
          />
          <LayerToggle
            label="Algorithm"
            name="Algorithm overlay"
            icon={Scan}
            pressed={showAlgorithm}
            onChange={setAlgorithm}
          />
          {/* Absent rather than disabled in flight view: a greyed control
              still tells the reader an answer key exists behind it. */}
          {engineering && (
            <LayerToggle
              label="Evaluation"
              name="Ground truth sensor overlay"
              icon={Eye}
              pressed={showTruth}
              tone="truth"
              onChange={setTruth}
            />
          )}
        </div>
      </div>

      <div className="grid shrink-0 grid-cols-3 gap-x-3 gap-y-1.5 border-t border-panel-border px-2.5 py-1.5 sm:grid-cols-4 xl:grid-cols-6">
        <MetricReadout label="Frame" value={frame === null ? null : frame.frameId} />
        <MetricReadout
          label="Capture time"
          value={frame === null ? null : frame.captureTime.toFixed(4)}
          unit="s"
        />
        <MetricReadout label="Format" value={frame?.format ?? null} />
        <MetricReadout
          label="Resolution"
          value={`${String(config.camera.width)}×${String(config.camera.height)}`}
          unit="px"
        />
        <MetricReadout label="Configured FPS" value={config.camera.frameRate} unit="Hz" />
        <MetricReadout
          label="Exposure"
          value={(config.camera.exposure * 1000).toFixed(1)}
          unit="ms"
        />
        <MetricReadout
          label="Camera az"
          value={radiansToDegrees(measuredPan as never).toFixed(3)}
          unit="deg"
        />
        <MetricReadout
          label="Camera el"
          value={radiansToDegrees(measuredTilt as never).toFixed(3)}
          unit="deg"
        />
        <MetricReadout label="Frames issued" value={scheduled} />
        <MetricReadout
          label="Frames lost"
          value={dropped}
          hint={superseded > 0 ? `${String(superseded)} superseded for display` : undefined}
          tone={dropped > 0 ? 'degraded' : 'default'}
        />
      </div>
    </Panel>
  );
}
