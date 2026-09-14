/**
 * Manual pointing.
 *
 * Phase 2 has no autonomous search, so the operator finds the beacon by hand.
 * These controls drive the mount, and the mount changes the camera's attitude —
 * they move the instrument, never the target.
 */

import { Crosshair, MoveDown, MoveLeft, MoveRight, MoveUp } from 'lucide-react';
import { useEffect } from 'react';

import { radiansToDegrees } from '@/core/contracts/units';
import { Button } from '@/components/ui/button';
import { useSimulationStore } from '@/stores/simulation-store';

/** One button press, in radians. About 0.57 degrees. */
const STEP = 0.01;
/** With the shift key held. */
const COARSE_STEP = 0.1;

const toDegrees = (value: number): string => radiansToDegrees(value as never).toFixed(2);

export function CameraControls(): React.JSX.Element {
  const azimuth = useSimulationStore((state) => state.cameraAzimuth);
  const elevation = useSimulationStore((state) => state.cameraElevation);
  const nudgeCamera = useSimulationStore((state) => state.nudgeCamera);
  const setCameraPose = useSimulationStore((state) => state.setCameraPose);
  const resetCamera = useSimulationStore((state) => state.resetCamera);
  const showTruthOverlay = useSimulationStore((state) => state.showTruthOverlay);
  const setTruthOverlay = useSimulationStore((state) => state.setTruthOverlay);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Only when nothing is focused, so arrow keys still work in a slider or
      // a text field.
      const active = document.activeElement;
      if (active !== null && active !== document.body) return;

      const step = event.shiftKey ? COARSE_STEP : STEP;
      switch (event.key) {
        case 'ArrowLeft':
          nudgeCamera(-step, 0);
          break;
        case 'ArrowRight':
          nudgeCamera(step, 0);
          break;
        case 'ArrowUp':
          nudgeCamera(0, step);
          break;
        case 'ArrowDown':
          nudgeCamera(0, -step);
          break;
        default:
          return;
      }
      event.preventDefault();
    };

    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [nudgeCamera]);

  return (
    <div className="space-y-3 border-t px-3 py-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          Manual pointing
        </h3>
        <span className="text-[10px] text-muted-foreground">arrow keys · shift for coarse</span>
      </div>

      <div className="flex items-center gap-3">
        <div className="grid grid-cols-3 grid-rows-2 gap-1">
          <span />
          <Button
            size="icon"
            variant="outline"
            className="size-7"
            aria-label="Tilt up"
            onClick={() => {
              nudgeCamera(0, STEP);
            }}
          >
            <MoveUp className="size-3" />
          </Button>
          <span />
          <Button
            size="icon"
            variant="outline"
            className="size-7"
            aria-label="Pan left"
            onClick={() => {
              nudgeCamera(-STEP, 0);
            }}
          >
            <MoveLeft className="size-3" />
          </Button>
          <Button
            size="icon"
            variant="outline"
            className="size-7"
            aria-label="Tilt down"
            onClick={() => {
              nudgeCamera(0, -STEP);
            }}
          >
            <MoveDown className="size-3" />
          </Button>
          <Button
            size="icon"
            variant="outline"
            className="size-7"
            aria-label="Pan right"
            onClick={() => {
              nudgeCamera(STEP, 0);
            }}
          >
            <MoveRight className="size-3" />
          </Button>
        </div>

        <div className="min-w-0 flex-1 space-y-1.5">
          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="w-16 shrink-0">Az {toDegrees(azimuth)}°</span>
            <input
              type="range"
              aria-label="Camera azimuth"
              min={-180}
              max={180}
              step={0.1}
              value={radiansToDegrees(azimuth as never)}
              onChange={(event) => {
                setCameraPose((Number(event.target.value) * Math.PI) / 180, elevation);
              }}
              className="min-w-0 flex-1 accent-primary"
            />
          </label>

          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="w-16 shrink-0">El {toDegrees(elevation)}°</span>
            <input
              type="range"
              aria-label="Camera elevation"
              min={-90}
              max={90}
              step={0.1}
              value={radiansToDegrees(elevation as never)}
              onChange={(event) => {
                setCameraPose(azimuth, (Number(event.target.value) * Math.PI) / 180);
              }}
              className="min-w-0 flex-1 accent-primary"
            />
          </label>
        </div>
      </div>

      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          aria-label="Reset boresight"
          onClick={resetCamera}
        >
          <Crosshair className="size-3" />
          Reset boresight
        </Button>

        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-amber-400/90">
          <input
            type="checkbox"
            aria-label="Ground truth sensor overlay"
            checked={showTruthOverlay}
            onChange={(event) => {
              setTruthOverlay(event.target.checked);
            }}
            className="accent-amber-400"
          />
          Truth overlay
        </label>
      </div>
    </div>
  );
}
