/**
 * The privileged actuator panel.
 *
 * Everything here is ground truth: the motor's real position, the acceleration
 * the servo asked for before the torque limit clipped it, how much of the
 * backlash gap is currently taken up. A controller on real hardware sees none
 * of it — it gets an encoder count and nothing else.
 *
 * ADR-0003 permits exactly three consumers of ground truth, and a debug view
 * explicitly marked as such is one of them. This panel is that view. It is off
 * by default, labelled, and reads the privileged barrel directly; the lint
 * barrier still stops any tracking-side module importing what this file
 * imports.
 */

import { ShieldAlert } from 'lucide-react';

import { radiansToDegrees, radiansToMicroradians } from '@/core/contracts/units';
import type { AxisTruth } from '@/core/gimbal';
import { Badge } from '@/components/ui/badge';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { usePrivilegedVisible } from '@/app/privileged';
import { useSimulationStore } from '@/stores/simulation-store';

const deg = (value: number): string => `${radiansToDegrees(value as never).toFixed(4)}°`;
const degPerSecond = (value: number): string => `${radiansToDegrees(value as never).toFixed(3)}°/s`;
const degPerSecondSquared = (value: number): string =>
  `${radiansToDegrees(value as never).toFixed(2)}°/s²`;
const urad = (value: number): string => `${radiansToMicroradians(value as never).toFixed(1)} µrad`;

function Row({
  label,
  value,
  muted = false,
}: {
  label: string;
  value: string;
  muted?: boolean;
}): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn('tabular text-right', muted ? 'text-muted-foreground' : 'text-foreground/90')}
      >
        {value}
      </span>
    </div>
  );
}

function Flag({ label, active }: { label: string; active: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'rounded-sm px-1 py-px text-[9px] tracking-wider uppercase',
        active ? 'bg-truth/25 text-truth' : 'text-muted-foreground/60',
      )}
    >
      {label}
    </span>
  );
}

function AxisBlock({ title, axis }: { title: string; axis: AxisTruth }): React.JSX.Element {
  return (
    <section className="space-y-1">
      <h4 className="text-[10px] font-semibold tracking-wider text-truth/90 uppercase">{title}</h4>
      <div className="text-[11px]">
        <Row label="Setpoint" value={deg(axis.setpoint)} />
        <Row label="Motor angle" value={deg(axis.motorAngle)} />
        <Row label="Output angle" value={deg(axis.outputAngle)} />
        <Row label="Motor rate" value={degPerSecond(axis.motorRate)} />
        <Row label="Output rate" value={degPerSecond(axis.outputRate)} />
        <Row
          label="Accel demanded"
          value={degPerSecondSquared(axis.commandedAcceleration)}
          muted={!axis.accelerationSaturated}
        />
        <Row label="Accel applied" value={degPerSecondSquared(axis.appliedAcceleration)} />
        <Row label="Backlash take-up" value={urad(axis.backlashDisplacement)} />
        <Row label="Encoder error" value={urad(axis.encoderError)} />
      </div>
      <div className="flex flex-wrap gap-1">
        <Flag label="min stop" active={axis.atMinLimit} />
        <Flag label="max stop" active={axis.atMaxLimit} />
        <Flag label="rate sat" active={axis.rateSaturated} />
        <Flag label="accel sat" active={axis.accelerationSaturated} />
      </div>
    </section>
  );
}

export function ActuatorTruthPanel(): React.JSX.Element | null {
  const visible = usePrivilegedVisible(useSimulationStore((state) => state.showActuatorTruth));
  const truth = useSimulationStore((state) => state.actuatorTruth);

  if (!visible) return null;

  return (
    <div className="space-y-2 border-t border-truth/40 bg-truth/8 px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <ShieldAlert aria-hidden className="size-3 text-truth" />
        <Badge
          variant="outline"
          className="border-truth/40 text-[9px] font-semibold tracking-wider text-truth uppercase"
        >
          Actuator truth — debug only
        </Badge>
      </div>
      <p className="text-[10px] leading-snug text-muted-foreground">
        Simulator interior. Not observable on hardware and never reachable by a tracking algorithm.
      </p>

      {truth === null ? (
        <p className="text-[11px] text-muted-foreground">No actuator state yet.</p>
      ) : (
        <>
          <AxisBlock title="Pan" axis={truth.pan} />
          <Separator className="bg-truth/25" />
          <AxisBlock title="Tilt" axis={truth.tilt} />
          <Separator className="bg-truth/25" />
          <div className="text-[11px]">
            <Row label="Truth time" value={`${truth.time.toFixed(3)} s`} />
            <Row label="Commands in flight" value={String(truth.pendingCommands.length)} />
            {truth.lastApplied === null ? (
              <Row label="Last applied" value="none" muted />
            ) : (
              <>
                <Row
                  label="Last applied"
                  value={`#${String(truth.lastApplied.command.commandId)} at ${truth.lastApplied.appliedAt.toFixed(3)} s`}
                />
                <Row
                  label="Accepted"
                  value={`${deg(truth.lastApplied.acceptedPan)} / ${deg(truth.lastApplied.acceptedTilt)}`}
                />
                {(truth.lastApplied.panClamped || truth.lastApplied.tiltClamped) && (
                  <Row
                    label="Clamped"
                    value={[
                      truth.lastApplied.panClamped && 'pan',
                      truth.lastApplied.tiltClamped && 'tilt',
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  />
                )}
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
