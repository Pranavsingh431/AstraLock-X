/**
 * The tracker's state, where it is most needed: beside the image it is looking
 * at.
 *
 * The state is the first thing anyone reads on this screen, so it spells its own
 * name and carries a shape as well as a colour. Two states say more than their
 * name when the tracker knows more: RECOVER shows how long it has been
 * coasting, and HANDOFF READY shows the dwell it has accumulated, because in
 * both cases the number is the question the operator was about to ask.
 */

import { PAT_STATE, StatusBadge } from '@/components/astra';
import { useSimulationStore } from '@/stores/simulation-store';

export function PatStateChip({ size = 'sm' }: { size?: 'sm' | 'md' }): React.JSX.Element {
  const autonomy = useSimulationStore((state) => state.autonomyEnabled);
  const mode = useSimulationStore((state) => state.patMode);
  const debug = useSimulationStore((state) => state.algorithmDebug);

  if (!autonomy || mode === null) {
    return <StatusBadge status="idle" label="Autonomy off" size={size} />;
  }

  const state = PAT_STATE[mode];
  const robust = debug !== null && 'recoveryAge' in debug ? debug : null;

  // Only two states carry a number, and only when the tracker reports one.
  const detail =
    mode === 'reacquire' && robust?.recoveryAge !== null && robust !== null
      ? ` ${robust.recoveryAge.toFixed(1)} s`
      : mode === 'handoff' && robust?.handoffDwell != null
        ? ` ${robust.handoffDwell.toFixed(1)} s`
        : '';

  return (
    <StatusBadge
      status={state.status}
      label={`${state.label}${detail}`}
      size={size}
      pulse={state.pulse ?? false}
    />
  );
}
