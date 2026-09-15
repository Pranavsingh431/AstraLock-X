/**
 * What the mount was asked for, and what it did.
 *
 * The two columns are different quantities and the panel keeps them apart:
 * **commanded** is the setpoint the controller issued, **measured** is what the
 * encoder reports. They differ by transport delay, servo dynamics, backlash and
 * encoder quantisation, and the gap between them is the actuator's behaviour
 * rather than an error in either.
 *
 * Angles are shown in degrees because that is what a human reads. The core works
 * in radians throughout and converts only here, at the display.
 */

import { SlidersHorizontal } from 'lucide-react';

import { radiansToDegrees } from '@/core/contracts/units';
import {
  DiagnosticRow,
  Panel,
  PanelHeader,
  Section,
  StatusBadge,
  EngineeringTable,
  TableBody,
  TableHead,
  Td,
  Th,
  Rh,
  Tr,
} from '@/components/astra';
import { useSimulationStore } from '@/stores/simulation-store';

const deg = (value: number, digits = 3): string => radiansToDegrees(value as never).toFixed(digits);

export function ControllerPanel(): React.JSX.Element {
  const commandedPan = useSimulationStore((state) => state.commandedPan);
  const commandedTilt = useSimulationStore((state) => state.commandedTilt);
  const measuredPan = useSimulationStore((state) => state.measuredPan);
  const measuredTilt = useSimulationStore((state) => state.measuredTilt);
  const measuredPanRate = useSimulationStore((state) => state.measuredPanRate);
  const measuredTiltRate = useSimulationStore((state) => state.measuredTiltRate);
  const panAtLimit = useSimulationStore((state) => state.panAtLimit);
  const tiltAtLimit = useSimulationStore((state) => state.tiltAtLimit);
  const panRateSaturated = useSimulationStore((state) => state.panRateSaturated);
  const tiltRateSaturated = useSimulationStore((state) => state.tiltRateSaturated);
  const clamped = useSimulationStore((state) => state.lastCommandClamped);
  const debug = useSimulationStore((state) => state.algorithmDebug);

  const robust = debug !== null && 'feedforwardPan' in debug ? debug : null;
  const saturated = panRateSaturated || tiltRateSaturated;
  const limited = panAtLimit || tiltAtLimit;

  return (
    <Panel className="min-h-0">
      <PanelHeader
        icon={SlidersHorizontal}
        title="Controller — mount"
        actions={
          saturated || limited || clamped ? (
            <StatusBadge
              status={limited ? 'limited' : 'degraded'}
              label={limited ? 'At travel limit' : saturated ? 'Rate saturated' : 'Command clamped'}
            />
          ) : (
            <StatusBadge status="nominal" label="Nominal" />
          )
        }
      />

      <Section title="Axes">
        <EngineeringTable>
          <TableHead>
            <Tr>
              <Th>Axis</Th>
              <Th numeric>Commanded</Th>
              <Th numeric>Measured</Th>
              <Th numeric>Rate</Th>
            </Tr>
          </TableHead>
          <TableBody>
            <Tr>
              <Rh>Pan</Rh>
              <Td numeric>{deg(commandedPan)}°</Td>
              <Td numeric>{deg(measuredPan)}°</Td>
              <Td numeric>{deg(measuredPanRate, 2)}°/s</Td>
            </Tr>
            <Tr>
              <Rh>Tilt</Rh>
              <Td numeric>{deg(commandedTilt)}°</Td>
              <Td numeric>{deg(measuredTilt)}°</Td>
              <Td numeric>{deg(measuredTiltRate, 2)}°/s</Td>
            </Tr>
          </TableBody>
        </EngineeringTable>
        <p className="mt-1 text-[9px] leading-snug text-muted-foreground/80">
          Commanded is the setpoint issued; measured is what the encoder reports. The gap is
          transport delay, servo dynamics, backlash and quantisation.
        </p>
      </Section>

      {robust !== null && (
        <Section title="Command composition">
          <div className="space-y-px">
            <DiagnosticRow
              label="Feed-forward (pan)"
              value={robust.feedforwardPan === null ? null : deg(robust.feedforwardPan, 4)}
              unit="deg"
            />
            <DiagnosticRow
              label="Feed-forward (tilt)"
              value={robust.feedforwardTilt === null ? null : deg(robust.feedforwardTilt, 4)}
              unit="deg"
            />
            <DiagnosticRow label="Feedback (pan)" value={deg(robust.panCorrection, 4)} unit="deg" />
            <DiagnosticRow
              label="Feedback (tilt)"
              value={deg(robust.tiltCorrection, 4)}
              unit="deg"
            />
            <DiagnosticRow
              label="Prediction horizon"
              value={
                robust.predictionHorizon === null
                  ? null
                  : (robust.predictionHorizon * 1000).toFixed(0)
              }
              unit="ms"
            />
          </div>
          <p className="mt-1 text-[9px] leading-snug text-muted-foreground/80">
            The horizon is the configured command latency plus modelled servo lag — where the target
            will be when this command takes effect, not a measured delay.
          </p>
        </Section>
      )}
    </Panel>
  );
}
