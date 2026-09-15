/**
 * The disturbance status panel.
 *
 * Two halves, deliberately separated because they are different kinds of thing.
 *
 * The **configuration** half says what the scenario asked for. That is not
 * privileged: it is the experiment's own definition, visible in the scenario
 * file, and an operator has to be able to see what they loaded.
 *
 * The **realization** half is the answer key — the true base attitude, the true
 * apparent displacement of the beacon, the true scintillation gain at this
 * instant. It is ground truth, it is labelled as such, and it can be hidden. It
 * is one of the three consumers ADR-0003 permits: a debug view explicitly marked
 * as one.
 *
 * Nothing here is part of the control loop. Hiding it changes no pixel and no
 * command, which the tests check rather than assert.
 */

import { ShieldAlert, Waves } from 'lucide-react';

import { radiansToDegrees, radiansToMicroradians } from '@/core/contracts/units';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useSimulationStore } from '@/stores/simulation-store';

const urad = (value: number): string => `${radiansToMicroradians(value as never).toFixed(1)} µrad`;
const deg = (value: number): string => `${radiansToDegrees(value as never).toFixed(4)}°`;

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

/** One configured effect, on or off. */
function Effect({ label, active }: { label: string; active: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'rounded-sm px-1 py-px text-[9px] tracking-wider uppercase',
        active ? 'bg-sky-500/20 text-sky-700' : 'text-muted-foreground/60',
      )}
    >
      {label}
    </span>
  );
}

export function DisturbancePanel(): React.JSX.Element | null {
  const config = useSimulationStore((state) => state.config.disturbances);
  const truth = useSimulationStore((state) => state.sensorTruth);
  const visible = useSimulationStore((state) => state.showDisturbanceTruth);
  const setVisible = useSimulationStore((state) => state.setDisturbanceTruthVisible);
  const dropped = useSimulationStore((state) => state.framesDropped);

  const platformActive =
    config.platform.enabled &&
    (config.platform.tones.length > 0 ||
      config.platform.jitter.enabled ||
      config.platform.biasAzimuth !== 0 ||
      config.platform.biasElevation !== 0);

  const effects: readonly { label: string; active: boolean }[] = [
    { label: 'platform', active: platformActive },
    { label: 'attenuation', active: config.atmosphere.attenuation.enabled },
    { label: 'scintillation', active: config.atmosphere.scintillation.enabled },
    { label: 'wander', active: config.atmosphere.wander.enabled },
    { label: 'exposure', active: config.optics.exposure.enabled },
    { label: 'defocus', active: config.optics.defocus.enabled },
    { label: 'background', active: config.optics.background.enabled },
    { label: 'read noise', active: config.sensor.readNoise.enabled },
    { label: 'shot noise', active: config.sensor.shotNoise.enabled },
    { label: 'dropouts', active: config.dropouts.mode !== 'none' },
  ];

  const anyActive = effects.some((effect) => effect.active);
  const realization = truth?.disturbance ?? null;

  return (
    <div className="space-y-2 border-t px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Waves aria-hidden className="size-3.5 text-sky-700" />
          <h3 className="text-[10px] font-semibold tracking-wider text-sky-700 uppercase">
            Disturbances
          </h3>
          {config.preset !== null && (
            <Badge
              variant="outline"
              className="text-[9px] font-semibold tracking-wider uppercase"
              title="Provenance only. Every parameter is stored in the scenario, not looked up from this name."
            >
              {config.preset}
            </Badge>
          )}
        </div>
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-[10px]"
          aria-label={visible ? 'Hide disturbance truth' : 'Show disturbance truth'}
          aria-pressed={visible}
          onClick={() => {
            setVisible(!visible);
          }}
        >
          {visible ? 'Hide' : 'Show'}
        </Button>
      </div>

      {/* Configuration: what the scenario asked for. Not privileged. */}
      <div className="flex flex-wrap gap-1">
        {anyActive ? (
          effects.map((effect) => (
            <Effect key={effect.label} label={effect.label} active={effect.active} />
          ))
        ) : (
          <span className="text-[10px] text-muted-foreground">
            None. Image formation is taking the undisturbed path.
          </span>
        )}
      </div>

      {anyActive && (
        <div className="text-[11px]">
          <Row label="Frames dropped" value={String(dropped)} muted={dropped === 0} />
        </div>
      )}

      {/* Realization: ground truth, labelled, and hideable. */}
      {anyActive &&
        (visible ? (
          <div className="space-y-1.5 rounded-sm border border-amber-500/30 bg-amber-500/5 p-2">
            <div className="flex items-center gap-1.5">
              <ShieldAlert aria-hidden className="size-3 text-amber-700" />
              <Badge
                variant="outline"
                className="border-amber-500/40 text-[9px] font-semibold tracking-wider text-amber-700 uppercase"
              >
                Disturbance truth — debug only
              </Badge>
            </div>
            {realization === null ? (
              <p className="text-[10px] text-muted-foreground">
                No frame yet. Values appear once the sensor has produced one.
              </p>
            ) : (
              <div className="text-[11px]">
                <Row label="Base azimuth" value={deg(realization.base.azimuth)} />
                <Row label="Base elevation" value={deg(realization.base.elevation)} />
                <Row label="Wander az" value={urad(realization.wander.azimuth)} />
                <Row label="Wander el" value={urad(realization.wander.elevation)} />
                <Row label="Scintillation" value={`${realization.scintillation.toFixed(3)}×`} />
              </div>
            )}
            <p className="text-[9px] leading-snug text-muted-foreground">
              The true platform attitude and the true apparent beacon displacement. The encoder
              cannot measure either, and no algorithm receives them.
            </p>
          </div>
        ) : (
          <p className="text-[10px] text-muted-foreground">
            Truth hidden. The disturbances still act; only this readout is off.
          </p>
        ))}
    </div>
  );
}
