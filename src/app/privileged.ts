/**
 * One question, asked the same way everywhere: may this be drawn?
 *
 * Privileged data — ground truth, the simulator's interior, the evaluation
 * record — is shown when the operator's own toggle for it is on **and** the
 * application is in engineering view. Both have to agree, so switching to the
 * flight-representative view hides every privileged panel at once without
 * disturbing the individual toggles an engineer had set; switching back
 * restores exactly what was there.
 *
 * This gates rendering only. Nothing here changes what is computed, what is
 * recorded, or what any algorithm receives — which is the property that makes
 * the two views comparable: the same run produces the same numbers either way.
 */

import { useNavigationStore } from '@/stores/navigation-store';

/** Whether privileged panels may be drawn at all. */
export function useEngineeringView(): boolean {
  return useNavigationStore((state) => state.engineeringMode);
}

/** Combines a panel's own visibility toggle with the global view mode. */
export function usePrivilegedVisible(enabled: boolean): boolean {
  return useNavigationStore((state) => state.engineeringMode) && enabled;
}
