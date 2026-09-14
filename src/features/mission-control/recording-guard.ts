/**
 * Asking before an action ends a recording.
 *
 * Reset, changing scenario and switching autonomy off all end an experiment in
 * progress — honestly, with the reason recorded — but an operator should never
 * lose a recording by clicking the wrong button. The emergency stop is the
 * exception and never asks: stopping the mount comes first.
 */

import { useSimulationStore } from '@/stores/simulation-store';

/**
 * Returns whether to go ahead.
 *
 * @param consequence what happens to the recording, in a sentence.
 */
export function confirmIfRecording(consequence: string): boolean {
  if (!useSimulationStore.getState().isRecording()) return true;
  return window.confirm(`An experiment is recording. ${consequence} Continue?`);
}
