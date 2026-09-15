/**
 * What the detector found in this frame, and what the tracker did with it.
 *
 * This is the first link in the chain: pixels in, one candidate out. Everything
 * in the panels below it — the estimator's belief, the controller's correction,
 * the identity verdict — is downstream of the numbers here, so when a run goes
 * wrong this is where to look first.
 *
 * Nothing on this panel is privileged. Every field is something the algorithm
 * itself computed from the image, the believed calibration and the measured
 * mount state, which is exactly what a real terminal's software would have. If
 * the algorithm did not compute a field, it shows an em dash — never a zero,
 * and never a last-known value held over from an earlier frame.
 */

import { ScanSearch } from 'lucide-react';

import { formatMeasurement } from '@/core/contracts/measurement';
import { radiansToDegrees } from '@/core/contracts/units';
import {
  EmptyState,
  MetricReadout,
  Panel,
  PanelHeader,
  Section,
  StatusBadge,
} from '@/components/astra';
import { useSimulationStore } from '@/stores/simulation-store';

const deg = (value: number | null | undefined): string | null =>
  value == null ? null : radiansToDegrees(value as never).toFixed(3);

export function DetectorPanel(): React.JSX.Element {
  const enabled = useSimulationStore((state) => state.autonomyEnabled);
  const debug = useSimulationStore((state) => state.algorithmDebug);
  const snr = useSimulationStore((state) => state.detectionSnr);
  const runtimeError = useSimulationStore((state) => state.runtimeError);

  const detected = debug !== null && debug.centroidX != null;

  return (
    <Panel className="min-h-0">
      <PanelHeader
        icon={ScanSearch}
        title="Detector"
        actions={
          enabled ? (
            <StatusBadge
              status={detected ? 'nominal' : 'degraded'}
              label={detected ? 'Candidate' : 'No detection'}
            />
          ) : (
            <StatusBadge status="idle" label="Autonomy off" />
          )
        }
      />

      {runtimeError !== null && (
        <p
          role="alert"
          className="border-b border-status-fault/40 bg-status-fault/10 px-2.5 py-1.5 text-[10px] leading-snug text-status-fault"
        >
          Control loop stopped: {runtimeError}
        </p>
      )}

      {!enabled ? (
        <EmptyState
          title="Not running"
          hint="The mount is under manual control and nothing reads the pixels."
        />
      ) : (
        <>
          <Section title="This frame">
            <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
              <MetricReadout label="Candidates" value={debug?.candidateCount ?? null} />
              <MetricReadout label="Components" value={debug?.componentsFound ?? null} />
              <MetricReadout label="Score" value={debug?.candidateScore?.toFixed(3) ?? null} />
              <MetricReadout
                label="SNR"
                value={snr === null ? null : formatMeasurement(snr, 1)}
                hint="Aperture photometry against the local background"
              />
              <MetricReadout
                label="Centroid"
                value={
                  debug?.centroidX == null || debug.centroidY == null
                    ? null
                    : `${debug.centroidX.toFixed(1)}, ${debug.centroidY.toFixed(1)}`
                }
                unit="px"
              />
              <MetricReadout
                label="Misses"
                value={debug?.consecutiveMisses ?? null}
                tone={debug !== null && debug.consecutiveMisses > 0 ? 'degraded' : 'default'}
              />
            </div>
          </Section>

          <Section title="Line of sight">
            <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
              <MetricReadout label="Filtered az" value={deg(debug?.filteredAzimuth)} unit="deg" />
              <MetricReadout label="Filtered el" value={deg(debug?.filteredElevation)} unit="deg" />
              <MetricReadout
                label="Az rate"
                value={
                  debug?.azimuthRate == null
                    ? null
                    : radiansToDegrees(debug.azimuthRate as never).toFixed(2)
                }
                unit="deg/s"
              />
            </div>
          </Section>

          <Section title="Progress">
            <div className="grid grid-cols-3 gap-x-3 gap-y-1.5">
              <MetricReadout
                label="Waypoint"
                value={
                  debug?.searchWaypointIndex == null
                    ? null
                    : `${String(debug.searchWaypointIndex + 1)} / ${String(debug.searchWaypointCount)}`
                }
                hint="Position in the search pattern"
              />
              <MetricReadout label="Frames" value={debug?.framesProcessed ?? null} />
            </div>
          </Section>
        </>
      )}
    </Panel>
  );
}
