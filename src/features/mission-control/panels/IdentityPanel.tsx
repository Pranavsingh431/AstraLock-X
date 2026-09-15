/**
 * What the correlator currently believes about the source it is following.
 *
 * Every figure is the tracker's own evidence about pixels it saw: a
 * correlation, a recovered phase, and how much history went into them. There is
 * no emitter name here and there cannot be one — the terminal is configured
 * with a *pattern to expect*, the way a radio is set to a frequency, and it has
 * no way to know which object in the world it is looking at.
 *
 * The correlation is a Pearson coefficient on [-1, 1], invariant to brightness.
 * It is **not** a probability and is never shown as a percentage.
 */

import { Fingerprint } from 'lucide-react';

import { TERMINAL_BEACON_PROFILES } from '@/core/algorithms';
import {
  DiagnosticRow,
  EmptyState,
  MetricReadout,
  Panel,
  PanelHeader,
  Section,
  StatusBadge,
  type Status,
} from '@/components/astra';
import { useSimulationStore } from '@/stores/simulation-store';

/** How each verdict is presented. The wording is the tracker's, not truth's. */
const VERDICT: Record<string, { label: string; status: Status; meaning: string }> = {
  match: {
    label: 'Match',
    status: 'nominal',
    meaning: 'The watched source is sending the expected pattern.',
  },
  mismatch: {
    label: 'Mismatch',
    status: 'fault',
    meaning: 'The watched source is sending something else.',
  },
  ambiguous: {
    label: 'Ambiguous',
    status: 'degraded',
    meaning: 'More than one source fits the expected pattern. They cannot be told apart.',
  },
  unconfirmed: {
    label: 'Unconfirmed',
    status: 'idle',
    meaning: 'Between the thresholds: neither recognised nor refused.',
  },
  'insufficient-evidence': {
    label: 'No evidence',
    status: 'idle',
    meaning: 'Not watched long enough, or the source is not modulating.',
  },
};

export function IdentityPanel(): React.JSX.Element {
  const debug = useSimulationStore((state) => state.algorithmDebug);
  const profileId = useSimulationStore((state) => state.expectedBeaconProfileId);
  const robust = debug !== null && 'identityEnabled' in debug ? debug : null;
  const profile = TERMINAL_BEACON_PROFILES.find((entry) => entry.id === profileId);

  if (robust === null || !robust.identityEnabled) {
    return (
      <Panel className="min-h-0">
        <PanelHeader icon={Fingerprint} title="Beacon identity — off" />
        <EmptyState
          title="Identity off."
          hint="The tracker is choosing on motion alone, as it did before coded beacons existed. Enable it in the tracking controls to recognise a beacon by its signalling pattern."
        />
      </Panel>
    );
  }

  // A verdict the map does not know is shown as the tracker spelled it, rather
  // than silently as nothing: a new state should be visible, not invisible.
  const verdict =
    robust.identityState === null
      ? null
      : (VERDICT[robust.identityState] ?? {
          label: robust.identityState,
          status: 'idle' as Status,
          meaning: '',
        });

  return (
    <Panel className="min-h-0">
      <PanelHeader
        icon={Fingerprint}
        title="Beacon identity — coded optical"
        actions={
          verdict === null ? (
            <StatusBadge status="idle" label="Idle" />
          ) : (
            <StatusBadge status={verdict.status} label={verdict.label} />
          )
        }
      />

      <Section title="Expected profile">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <MetricReadout
            label="Pattern"
            value={profile?.label ?? 'Custom'}
            hint="A receiver setting, not read from the scenario"
          />
          <MetricReadout
            label="Symbol"
            value={(robust.expectedSymbolDuration * 1000).toFixed(1)}
            unit="ms"
            hint={`${String(robust.expectedSymbols)} symbols`}
          />
        </div>
      </Section>

      <Section title="Evidence">
        <div className="grid grid-cols-2 gap-x-3 gap-y-1.5">
          <MetricReadout
            label="Correlation"
            value={robust.codeCorrelation === null ? null : robust.codeCorrelation.toFixed(3)}
            size="md"
            tone={verdict?.status === 'nominal' ? 'nominal' : 'default'}
            hint="on [-1, 1]"
          />
          <MetricReadout
            label="Recovered phase"
            value={robust.codePhase === null ? null : (robust.codePhase * 1000).toFixed(0)}
            unit="ms"
            hint="found by search"
          />
        </div>
        {/* Said on the face of the panel rather than in a tooltip: reading a
            correlation as a confidence is the single most likely way for this
            number to be misquoted. */}
        <p className="mt-1 text-[9px] leading-snug text-muted-foreground">
          Not a probability. The correlation is a normalised match on [-1, 1], and the phase was
          recovered by search rather than given to the receiver.
        </p>
        <div className="mt-1.5 space-y-px">
          <DiagnosticRow
            label="Observations"
            value={robust.identitySamples}
            unit={
              robust.identitySpan === null ? undefined : `over ${robust.identitySpan.toFixed(1)} s`
            }
          />
          <DiagnosticRow label="Sources watched" value={robust.identityCandidates} />
          <DiagnosticRow
            label="Refused this frame"
            value={robust.identityRejected}
            tone={robust.identityRejected > 0 ? 'degraded' : 'default'}
          />
        </div>
        {verdict !== null && verdict.meaning !== '' && (
          <p className="mt-1.5 text-[9px] leading-snug text-muted-foreground/80">
            {verdict.meaning}
          </p>
        )}
      </Section>
    </Panel>
  );
}
