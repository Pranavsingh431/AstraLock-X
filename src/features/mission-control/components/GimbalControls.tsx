/**
 * Operator controls for the pan/tilt mount.
 *
 * These issue **commands**. The mount answers over simulated time, so the
 * numbers an operator types and the numbers the encoder reports are different
 * quantities and are shown as such. A control that made the measured angle jump
 * to the commanded one would be hiding the entire subject of this phase.
 *
 * Every flag here is read from actuator state. None of them is decoration: if
 * the limit warning is lit, an axis really is against its stop.
 */

import { AlertTriangle, Crosshair, MoveDown, MoveLeft, MoveRight, MoveUp } from 'lucide-react';
import { useEffect } from 'react';

import { radiansToDegrees } from '@/core/contracts/units';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSimulationStore } from '@/stores/simulation-store';

/** One button press, in radians. About 0.57 degrees. */
const STEP = 0.01;
/** With the shift key held. */
const COARSE_STEP = 0.1;

const toDegrees = (value: number): string => radiansToDegrees(value as never).toFixed(3);

const PHASE_STYLE = {
  active: 'text-status-active',
  settling: 'text-status-degraded',
  holding: 'text-muted-foreground',
} as const;

export function GimbalControls(): React.JSX.Element {
  const commandedPan = useSimulationStore((state) => state.commandedPan);
  const commandedTilt = useSimulationStore((state) => state.commandedTilt);
  const measuredPan = useSimulationStore((state) => state.measuredPan);
  const measuredTilt = useSimulationStore((state) => state.measuredTilt);
  const measuredPanRate = useSimulationStore((state) => state.measuredPanRate);
  const measuredTiltRate = useSimulationStore((state) => state.measuredTiltRate);
  const servoPhase = useSimulationStore((state) => state.servoPhase);
  const commandsPending = useSimulationStore((state) => state.commandsPending);
  const panAtLimit = useSimulationStore((state) => state.panAtLimit);
  const tiltAtLimit = useSimulationStore((state) => state.tiltAtLimit);
  const panRateSaturated = useSimulationStore((state) => state.panRateSaturated);
  const tiltRateSaturated = useSimulationStore((state) => state.tiltRateSaturated);
  const lastCommandClamped = useSimulationStore((state) => state.lastCommandClamped);
  const config = useSimulationStore((state) => state.config);

  const setCameraPose = useSimulationStore((state) => state.setCameraPose);
  const nudgeCamera = useSimulationStore((state) => state.nudgeCamera);
  const resetCamera = useSimulationStore((state) => state.resetCamera);
  const showActuatorTruth = useSimulationStore((state) => state.showActuatorTruth);
  const setActuatorTruthVisible = useSimulationStore((state) => state.setActuatorTruthVisible);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      // Only when nothing is focused, so arrow keys still work in a slider.
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

  const panLimits = config.gimbal.pan;
  const tiltLimits = config.gimbal.tilt;
  const latencyMs = config.gimbal.commandLatency * 1000;

  return (
    <div className="space-y-2.5 border-t px-3 py-2.5">
      <div className="flex items-center justify-between">
        <h3 className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          Gimbal command
        </h3>
        <span className={cn('text-[10px] tracking-wider uppercase', PHASE_STYLE[servoPhase])}>
          {servoPhase}
          {commandsPending > 0 && ` · ${String(commandsPending)} in flight`}
        </span>
      </div>

      {/* Command and measurement side by side, because the gap between them is
          the thing worth looking at. */}
      <div className="grid grid-cols-[auto_1fr_1fr] items-baseline gap-x-3 gap-y-1 text-[11px]">
        <span />
        <span className="text-[9px] tracking-wider text-muted-foreground uppercase">Command</span>
        <span className="text-[9px] tracking-wider text-muted-foreground uppercase">Measured</span>

        <span className="text-muted-foreground">Pan</span>
        <span className="tabular">{toDegrees(commandedPan)}°</span>
        <span className="tabular text-foreground/90">{toDegrees(measuredPan)}°</span>

        <span className="text-muted-foreground">Tilt</span>
        <span className="tabular">{toDegrees(commandedTilt)}°</span>
        <span className="tabular text-foreground/90">{toDegrees(measuredTilt)}°</span>

        <span className="text-muted-foreground">Rate</span>
        <span className="tabular text-muted-foreground/70">
          {`±${radiansToDegrees(panLimits.maxRate as never).toFixed(0)}°/s`}
        </span>
        <span className="tabular text-foreground/90">
          {`${radiansToDegrees(measuredPanRate as never).toFixed(1)} / ${radiansToDegrees(
            measuredTiltRate as never,
          ).toFixed(1)}°/s`}
        </span>
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
            <span className="w-8 shrink-0">Pan</span>
            <input
              type="range"
              aria-label="Pan command"
              min={radiansToDegrees(panLimits.minAngle)}
              max={radiansToDegrees(panLimits.maxAngle)}
              step={0.1}
              value={radiansToDegrees(commandedPan as never)}
              onChange={(event) => {
                setCameraPose((Number(event.target.value) * Math.PI) / 180, commandedTilt);
              }}
              className="min-w-0 flex-1 accent-primary"
            />
          </label>

          <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="w-8 shrink-0">Tilt</span>
            <input
              type="range"
              aria-label="Tilt command"
              min={radiansToDegrees(tiltLimits.minAngle)}
              max={radiansToDegrees(tiltLimits.maxAngle)}
              step={0.1}
              value={radiansToDegrees(commandedTilt as never)}
              onChange={(event) => {
                setCameraPose(commandedPan, (Number(event.target.value) * Math.PI) / 180);
              }}
              className="min-w-0 flex-1 accent-primary"
            />
          </label>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          aria-label="Home the mount"
          onClick={resetCamera}
        >
          <Crosshair className="size-3" />
          Home
        </Button>

        <span className="tabular text-[10px] text-muted-foreground">
          latency {latencyMs.toFixed(0)} ms
        </span>

        {(panAtLimit ||
          tiltAtLimit ||
          panRateSaturated ||
          tiltRateSaturated ||
          lastCommandClamped) && (
          <Badge
            variant="outline"
            className="gap-1 border-status-degraded/40 text-[10px] font-normal text-status-degraded"
          >
            <AlertTriangle aria-hidden className="size-3" />
            {[
              panAtLimit && 'pan at limit',
              tiltAtLimit && 'tilt at limit',
              panRateSaturated && 'pan rate',
              tiltRateSaturated && 'tilt rate',
              lastCommandClamped && 'command clamped',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Badge>
        )}

        <label className="ml-auto flex items-center gap-1.5 text-[11px] text-truth">
          <input
            type="checkbox"
            aria-label="Actuator truth debug panel"
            checked={showActuatorTruth}
            onChange={(event) => {
              setActuatorTruthVisible(event.target.checked);
            }}
            className="accent-[oklch(0.74_0.15_305)]"
          />
          Actuator truth
        </label>
      </div>
    </div>
  );
}
