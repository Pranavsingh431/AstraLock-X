/**
 * The physical environment the link is operating through.
 *
 * Two halves, deliberately separated because they are different kinds of thing.
 *
 * The **configuration** half says what the scenario asked for. That is not
 * privileged — it is the experiment's own definition, visible in the scenario
 * file — and an operator has to be able to see what they loaded.
 *
 * The **realization** half is the answer key: the true base attitude, the true
 * apparent displacement of the beacon, the true scintillation gain at this
 * instant. It is ground truth, it is framed and labelled as such, and it can be
 * hidden. Hiding it changes no pixel and no command.
 */

import { Radio, ShieldAlert } from 'lucide-react';

import { radiansToDegrees, radiansToMicroradians } from '@/core/contracts/units';
import {
  DiagnosticRow,
  MetricReadout,
  Panel,
  PanelHeader,
  Section,
  StatusBadge,
} from '@/components/astra';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useEngineeringView } from '@/app/privileged';
import { useSimulationStore } from '@/stores/simulation-store';

const urad = (value: number): string => radiansToMicroradians(value as never).toFixed(1);
const deg = (value: number): string => radiansToDegrees(value as never).toFixed(4);

/** One configured effect, on or off. Off is dimmed rather than hidden. */
function Effect({ label, active }: { label: string; active: boolean }): React.JSX.Element {
  return (
    <span
      className={cn(
        'rounded-sm px-1 py-px text-[9px] tracking-wider uppercase',
        active
          ? 'bg-status-active/18 text-status-active'
          : 'text-muted-foreground/45 line-through decoration-muted-foreground/30',
      )}
    >
      {label}
    </span>
  );
}

export function ChannelPanel(): React.JSX.Element {
  const config = useSimulationStore((state) => state.config.disturbances);
  const camera = useSimulationStore((state) => state.config.camera);
  const targets = useSimulationStore((state) => state.config.targets);
  const truth = useSimulationStore((state) => state.sensorTruth);
  const visible = useSimulationStore((state) => state.showDisturbanceTruth);
  const engineering = useEngineeringView();
  const setVisible = useSimulationStore((state) => state.setDisturbanceTruthVisible);
  const dropped = useSimulationStore((state) => state.framesDropped);
  const scheduled = useSimulationStore((state) => state.framesScheduled);

  const platformActive =
    config.platform.enabled &&
    (config.platform.tones.length > 0 ||
      config.platform.jitter.enabled ||
      config.platform.biasAzimuth !== 0 ||
      config.platform.biasElevation !== 0);

  const effects = [
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
  ] as const;

  const anyActive = effects.some((effect) => effect.active);
  const realization = truth?.disturbance ?? null;
  // Measured, not configured: frames the transport actually lost over frames
  // the sensor actually scheduled.
  const lossRate = scheduled === 0 ? null : dropped / scheduled;
  const decoys = Math.max(0, targets.length - 1);

  return (
    <Panel className="min-h-0">
      <PanelHeader
        icon={Radio}
        title="Channel / platform"
        actions={
          <StatusBadge
            status={anyActive ? 'degraded' : 'nominal'}
            label={anyActive ? (config.preset ?? 'Disturbed') : 'Clean'}
          />
        }
      />

      <Section title="Configured effects">
        <div className="flex flex-wrap gap-1">
          {effects.map((effect) => (
            <Effect key={effect.label} label={effect.label} active={effect.active} />
          ))}
        </div>
        {!anyActive && (
          <p className="mt-1 text-[9px] text-muted-foreground">
            Image formation is taking the undisturbed path.
          </p>
        )}
      </Section>

      <Section title="Observed">
        <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
          <MetricReadout
            label="Frame loss"
            value={lossRate === null ? null : (lossRate * 100).toFixed(1)}
            unit="%"
            hint={`${String(dropped)} of ${String(scheduled)}`}
            tone={dropped > 0 ? 'degraded' : 'default'}
          />
          <MetricReadout label="Exposure" value={(camera.exposure * 1000).toFixed(1)} unit="ms" />
          <MetricReadout
            label="Sources"
            value={targets.length}
            hint={decoys === 0 ? 'beacon only' : `${String(decoys)} besides the beacon`}
          />
        </div>
      </Section>

      {engineering && (
        <Section
          title="Realization"
          actions={
            <Button
              size="sm"
              variant="ghost"
              className="h-5 px-1.5 text-[9px]"
              aria-label={visible ? 'Hide disturbance truth' : 'Show disturbance truth'}
              aria-pressed={visible}
              onClick={() => {
                setVisible(!visible);
              }}
            >
              {visible ? 'Hide' : 'Show'}
            </Button>
          }
        >
          {!visible ? (
            <p className="text-[10px] text-muted-foreground">
              Truth hidden. The disturbances still act; only this readout is off.
            </p>
          ) : (
            <div className="rounded-sm border border-truth/40 bg-truth/8 p-2">
              <div className="mb-1 flex items-center gap-1.5">
                <ShieldAlert aria-hidden className="size-3 text-truth" />
                <span className="text-[9px] font-semibold tracking-[0.08em] text-truth uppercase">
                  Ground truth — debug only
                </span>
              </div>
              {realization === null ? (
                <p className="text-[10px] text-muted-foreground">
                  No frame yet. Values appear once the sensor has produced one.
                </p>
              ) : (
                <div className="space-y-px">
                  <DiagnosticRow
                    label="Base azimuth"
                    value={deg(realization.base.azimuth)}
                    unit="deg"
                    tone="truth"
                  />
                  <DiagnosticRow
                    label="Base elevation"
                    value={deg(realization.base.elevation)}
                    unit="deg"
                    tone="truth"
                  />
                  <DiagnosticRow
                    label="Wander az"
                    value={urad(realization.wander.azimuth)}
                    unit="µrad"
                    tone="truth"
                  />
                  <DiagnosticRow
                    label="Wander el"
                    value={urad(realization.wander.elevation)}
                    unit="µrad"
                    tone="truth"
                  />
                  <DiagnosticRow
                    label="Scintillation"
                    value={`${realization.scintillation.toFixed(3)}×`}
                    tone="truth"
                  />
                </div>
              )}
              <p className="mt-1 text-[9px] leading-snug text-muted-foreground/80">
                The true platform attitude and the true apparent beacon displacement. The encoder
                cannot measure either, and no algorithm receives them.
              </p>
            </div>
          )}
        </Section>
      )}
    </Panel>
  );
}
