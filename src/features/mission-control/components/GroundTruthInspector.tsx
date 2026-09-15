/**
 * The privileged debug panel.
 *
 * It reads the restricted simulation API directly, which is legitimate: ADR-0003
 * names debug views as one of the three permitted consumers of ground truth,
 * alongside the simulator and evaluation. What matters is that this is a
 * *view*. It widens nothing — `AlgorithmPlugin`'s surface is untouched, and the
 * lint barrier still stops any tracking-side module importing what this file
 * imports.
 *
 * Everything shown is measured. Fields Phase 1 does not model say so rather
 * than displaying a plausible number.
 */

import { Eye } from 'lucide-react';

import { radiansToDegrees, radiansToMicroradians } from '@/core/contracts/units';
import { SeededManeuverTrajectory } from '@/core/simulation';
import { Badge } from '@/components/ui/badge';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { activeEngine, useSimulationStore } from '@/stores/simulation-store';

const metres = (value: number): string => `${value.toFixed(1)} m`;
const speed = (value: number): string => `${value.toFixed(2)} m/s`;

function Row({ label, value }: { label: string; value: string }): React.JSX.Element {
  return (
    <div className="flex items-baseline justify-between gap-4 py-0.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="tabular text-right text-foreground/90">{value}</span>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-1">
      <h3 className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
        {title}
      </h3>
      <div className="text-xs">{children}</div>
    </section>
  );
}

export function GroundTruthInspector(): React.JSX.Element | null {
  // Subscribing to the tick alone keeps this panel re-rendering once per
  // advance rather than on every store write.
  const tick = useSimulationStore((state) => state.tick);
  const time = useSimulationStore((state) => state.time);
  const config = useSimulationStore((state) => state.config);
  const visible = useSimulationStore((state) => state.showGroundTruthInspector);
  const setVisible = useSimulationStore((state) => state.setGroundTruthInspectorVisible);

  const engine = activeEngine();
  const truth = engine.snapshot().truth;
  const cursors = engine.randomStreamCursors();
  const target = truth.targets[0];
  const acceleration = engine.trajectoryAt(0)?.sampleAt(time).acceleration;

  // `Trajectory` is an interface rather than a discriminated union, so the
  // narrowing has to be nominal for the schedule to be reachable.
  const candidate = engine.trajectoryAt(0);
  const maneuver = candidate instanceof SeededManeuverTrajectory ? candidate : null;

  if (!visible) return null;

  return (
    <aside className="flex w-80 shrink-0 flex-col border-l bg-card/30">
      <header className="flex items-center gap-2 border-b px-3 py-2">
        <Eye aria-hidden className="size-3.5 text-amber-400" />
        <h2 className="text-[11px] font-semibold tracking-wider text-amber-400 uppercase">
          Ground truth — debug only
        </h2>
        <button
          type="button"
          aria-label="Hide ground truth inspector"
          className="ml-auto rounded-sm px-1.5 py-0.5 text-[10px] text-muted-foreground hover:bg-accent hover:text-foreground"
          onClick={() => {
            setVisible(false);
          }}
        >
          Hide
        </button>
      </header>

      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-3">
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            Simulator state. A tracking algorithm can reach none of this — it is shown here so a run
            can be explained, and it is what a tracker will eventually be scored against.
          </p>

          <Section title="Clock">
            <Row label="Tick" value={String(tick)} />
            <Row label="Simulated time" value={`${time.toFixed(3)} s`} />
            <Row label="Fixed timestep" value={`${engine.clock.fixedTimestep.toFixed(5)} s`} />
            <Row label="Tick rate" value={`${String(config.tickRate)} Hz`} />
            <Row label="Duration" value={`${String(config.duration)} s`} />
          </Section>

          <Separator />

          <Section title="Run identity">
            <Row label="Scenario" value={config.id} />
            <Row label="Root seed" value={String(config.seed)} />
            <Row label="State hash" value={engine.stateHash()} />
          </Section>

          <Separator />

          <Section title="Observer platform">
            <Row label="Entity" value="platform-0" />
            <Row label="East" value={metres(truth.platform.pose.position.x)} />
            <Row label="North" value={metres(truth.platform.pose.position.y)} />
            <Row label="Up" value={metres(truth.platform.pose.position.z)} />
            <Row
              label="Boresight az"
              value={`${radiansToDegrees(truth.gimbal.azimuth).toFixed(2)}°`}
            />
            <Row
              label="Boresight el"
              value={`${radiansToDegrees(truth.gimbal.elevation).toFixed(2)}°`}
            />
          </Section>

          {target !== undefined && (
            <>
              <Separator />
              <Section title="Target">
                <Row label="Entity" value={target.id} />
                <Row label="East" value={metres(target.pose.position.x)} />
                <Row label="North" value={metres(target.pose.position.y)} />
                <Row label="Up" value={metres(target.pose.position.z)} />
                <Row
                  label="Speed"
                  value={speed(Math.hypot(target.velocity.x, target.velocity.y, target.velocity.z))}
                />
                {acceleration !== undefined && (
                  <Row
                    label="Acceleration"
                    value={`${Math.hypot(acceleration.x, acceleration.y, acceleration.z).toFixed(2)} m/s²`}
                  />
                )}
                <Row label="Range" value={metres(target.range)} />
                <Row
                  label="Bearing az"
                  value={`${radiansToDegrees(target.bearingFromGimbal.azimuth).toFixed(3)}°`}
                />
                <Row
                  label="Bearing el"
                  value={`${radiansToDegrees(target.bearingFromGimbal.elevation).toFixed(3)}°`}
                />
                <Row label="In field of view" value={target.inFieldOfView ? 'yes' : 'no'} />
              </Section>
            </>
          )}

          <Separator />

          <Section title="Pointing">
            <Row
              label="True error"
              value={
                truth.pointingError === null
                  ? 'no designated target'
                  : `${radiansToMicroradians(truth.pointingError).toFixed(0)} µrad`
              }
            />
          </Section>

          <Separator />

          <Section title="Trajectory">
            <div className="pb-1 text-muted-foreground">{engine.describeTrajectories()[0]}</div>
            {maneuver !== null && (
              <>
                <Row label="Segments" value={String(maneuver.schedule.length)} />
                <div className="mt-2 max-h-40 overflow-auto rounded border bg-background/50 p-2 font-mono text-[10px] leading-relaxed">
                  {maneuver.schedule.slice(0, 12).map((segment) => (
                    <div key={segment.index} className="whitespace-nowrap text-muted-foreground">
                      {`#${String(segment.index).padStart(2, '0')} t=${segment.startTime.toFixed(1)}s ` +
                        `dt=${segment.duration.toFixed(2)}s ` +
                        `|a|=${Math.hypot(segment.acceleration.x, segment.acceleration.y, segment.acceleration.z).toFixed(2)}`}
                    </div>
                  ))}
                  {maneuver.schedule.length > 12 && (
                    <div className="text-muted-foreground/60">
                      … {maneuver.schedule.length - 12} more
                    </div>
                  )}
                </div>
              </>
            )}
          </Section>

          <Separator />

          <Section title="Random streams (draws)">
            {Object.entries(cursors).map(([name, draws]) => (
              <Row key={name} label={name} value={String(draws)} />
            ))}
          </Section>

          <Separator />

          <Section title="Not modelled in Phase 1">
            <div className="space-y-1 text-[11px] leading-relaxed text-muted-foreground">
              <Badge variant="outline" className="mr-1 font-normal">
                received beacon power
              </Badge>
              <Badge variant="outline" className="mr-1 font-normal">
                occlusion
              </Badge>
              <Badge variant="outline" className="mr-1 font-normal">
                base-motion disturbance
              </Badge>
              <Badge variant="outline" className="mr-1 font-normal">
                gimbal servo
              </Badge>
              <p className="pt-1">
                These fields report zero or null rather than an invented value. See
                docs/SIMULATION.md.
              </p>
            </div>
          </Section>
        </div>
      </ScrollArea>
    </aside>
  );
}
