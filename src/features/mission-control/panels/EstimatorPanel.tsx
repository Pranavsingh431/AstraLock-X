/**
 * The estimator's own account of what it believes.
 *
 * Every value is the tracker's, computed from pixels and the measured mount
 * state. The uncertainty is the filter's covariance — what it thinks it knows —
 * and not a measured error; the two are different quantities and only the
 * evaluator can produce the second.
 *
 * Shown only for a tracker that has an IMM. The baseline has one motion model
 * and reports no model probabilities, and a panel of dashes under its name
 * would describe a capability it does not have.
 */

import { Activity } from 'lucide-react';

import { radiansToDegrees } from '@/core/contracts/units';
import {
  DiagnosticRow,
  EmptyState,
  MetricReadout,
  Panel,
  PanelHeader,
  ProportionBar,
  Section,
  StatusBadge,
} from '@/components/astra';
import { useSimulationStore } from '@/stores/simulation-store';

const deg = (value: number | null, digits = 3): string | null =>
  value === null ? null : radiansToDegrees(value as never).toFixed(digits);

export function EstimatorPanel(): React.JSX.Element {
  const debug = useSimulationStore((state) => state.algorithmDebug);
  const robust = debug !== null && 'immCvProbability' in debug ? debug : null;

  return (
    <Panel className="min-h-0">
      <PanelHeader
        icon={Activity}
        // Only the tracker that runs one claims an IMM in its title. The
        // baseline's panel is an estimator panel with an empty state, not an
        // IMM panel reporting nothing.
        title={robust === null ? 'Estimator' : 'Estimator — IMM'}
        actions={
          robust === null ? undefined : (
            <span className="tabular text-[9px] text-muted-foreground">
              horizon{' '}
              {robust.predictionHorizon === null
                ? '—'
                : `${(robust.predictionHorizon * 1000).toFixed(0)} ms`}
            </span>
          )
        }
      />

      {robust === null ? (
        <EmptyState
          title="No interacting-multiple-model estimator."
          hint="Model probabilities come from AstraLock-X. The baseline runs a single constant-velocity model and reports none."
        />
      ) : (
        <div>
          <Section title="Model probability">
            <div className="space-y-1">
              <ProportionBar label="CV" value={robust.immCvProbability} tone="active" />
              <ProportionBar label="CA" value={robust.immCaProbability} tone="degraded" />
            </div>
            <p className="mt-1 text-[9px] leading-snug text-muted-foreground/80">
              The filter's own belief about which motion model explains the data. On a benign target
              the two relax toward the transition matrix rather than resolving.
            </p>
          </Section>

          <Section title="State">
            <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
              <MetricReadout label="Azimuth" value={deg(robust.filteredAzimuth)} unit="deg" />
              <MetricReadout label="Elevation" value={deg(robust.filteredElevation)} unit="deg" />
              <MetricReadout label="Az rate" value={deg(robust.azimuthRate, 4)} unit="deg/s" />
              <MetricReadout label="El rate" value={deg(robust.elevationRate, 4)} unit="deg/s" />
              <MetricReadout
                label="Az accel"
                value={deg(robust.azimuthAcceleration, 4)}
                unit="deg/s²"
              />
              <MetricReadout
                label="El accel"
                value={deg(robust.elevationAcceleration, 4)}
                unit="deg/s²"
              />
            </div>
          </Section>

          <Section title="Confidence and gating">
            <div className="space-y-px">
              <DiagnosticRow
                label="Angular uncertainty (1σ)"
                value={deg(robust.angularSigma, 4)}
                unit="deg"
              />
              <DiagnosticRow
                label="Innovation (NIS)"
                value={robust.innovationNis === null ? null : robust.innovationNis.toFixed(2)}
                tone={
                  robust.innovationNis !== null && robust.innovationNis > 13.82
                    ? 'degraded'
                    : 'default'
                }
              />
              <DiagnosticRow
                label="Track quality"
                value={robust.trackQuality === null ? null : robust.trackQuality.toFixed(2)}
              />
              <DiagnosticRow
                label="Acquisition evidence"
                value={
                  robust.acquisitionEvidence === null ? null : robust.acquisitionEvidence.toFixed(2)
                }
              />
              <DiagnosticRow label="Candidates this frame" value={robust.candidateCount} />
              <DiagnosticRow
                label="Rejected by the gate"
                value={robust.gateRejected}
                tone={robust.gateRejected > 0 ? 'degraded' : 'default'}
              />
            </div>

            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <StatusBadge
                status={robust.gateAccepted === true ? 'nominal' : 'idle'}
                label={
                  robust.gateAccepted === null
                    ? 'No association'
                    : robust.gateAccepted
                      ? 'Measurement accepted'
                      : 'No measurement'
                }
              />
              {robust.consecutiveMisses > 0 && (
                <StatusBadge
                  status="degraded"
                  label={`${String(robust.consecutiveMisses)} consecutive misses`}
                />
              )}
            </div>
          </Section>

          {robust.localSearchRadius !== null && (
            <Section title="Recovery">
              <div className="space-y-px">
                <DiagnosticRow
                  label="Recovery age"
                  value={robust.recoveryAge === null ? null : robust.recoveryAge.toFixed(2)}
                  unit="s"
                  tone="degraded"
                />
                <DiagnosticRow
                  label="Local search radius"
                  value={deg(robust.localSearchRadius, 3)}
                  unit="deg"
                />
                <DiagnosticRow label="Pattern step" value={robust.localSearchIndex} />
              </div>
            </Section>
          )}
        </div>
      )}
    </Panel>
  );
}
