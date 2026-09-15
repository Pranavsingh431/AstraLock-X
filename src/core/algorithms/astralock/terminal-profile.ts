/**
 * Terminal beacon profiles: the signalling pattern a receiver is set to expect.
 *
 * **Configuration, chosen by the operator or written into a benchmark arm.**
 * Never derived from the loaded scenario. Phase 8's application read the
 * designated emitter's `identityCode` out of the scenario and copied it into the
 * tracker's configuration when the runtime was built; that made the receiver
 * setting a function of the physical answer — change what the target transmits
 * and the receiver silently followed — and it was removed in Phase 9. See
 * docs/BEACON_IDENTITY.md ("Expected code versus emitted code").
 *
 * The consequence is deliberate and tested: a scenario whose target transmits
 * code B, flown by a terminal expecting code A, fails identity exactly as a
 * misconfigured real terminal would. Choosing the code-B profile is a
 * configuration change the record shows in `algorithm.json`, while what the
 * emitter actually sent stays in `scenario.json`.
 *
 * Nothing here names an emitter, a target index or a phase. A profile is two
 * numbers a mission card would carry: a sequence and a symbol duration.
 */

import { CODE_A, CODE_B } from '@/core/contracts/code-library';
import type { CodeSymbol } from '@/core/contracts/code-waveform';

import type { AstraLockConfig } from './config';

export interface TerminalBeaconProfile {
  /** Stable machine identifier, recorded wherever the profile is chosen. */
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly sequence: readonly CodeSymbol[];
  /** Seconds per symbol. */
  readonly symbolDuration: number;
}

/**
 * The bundled profiles.
 *
 * Both at four frames per symbol for the bundled 60 fps camera — the timing
 * docs/BEACON_IDENTITY.md justifies. They are the two length-15 m-sequences;
 * there are no others at that length.
 */
export const TERMINAL_BEACON_PROFILES: readonly TerminalBeaconProfile[] = [
  {
    id: 'code-a-15-66ms',
    label: 'Code A · 15 symbols · 66.7 ms',
    description: 'The m-sequence from x⁴ + x + 1, four 60 fps frames per symbol.',
    sequence: CODE_A,
    symbolDuration: 4 / 60,
  },
  {
    id: 'code-b-15-66ms',
    label: 'Code B · 15 symbols · 66.7 ms',
    description: 'The m-sequence from x⁴ + x³ + 1, four 60 fps frames per symbol.',
    sequence: CODE_B,
    symbolDuration: 4 / 60,
  },
];

export const DEFAULT_TERMINAL_PROFILE_ID = 'code-a-15-66ms';

export function terminalProfileById(id: string): TerminalBeaconProfile | undefined {
  return TERMINAL_BEACON_PROFILES.find((profile) => profile.id === id);
}

/**
 * A configuration with the receiver set to a profile, or with identity off.
 *
 * Pure: the result depends on the configuration and the profile and on nothing
 * else. There is deliberately no parameter through which a scenario could
 * reach it.
 */
export function withExpectedBeacon(
  config: AstraLockConfig,
  profile: TerminalBeaconProfile | null,
): AstraLockConfig {
  if (profile === null) return { ...config, identity: { ...config.identity, enabled: false } };
  return {
    ...config,
    identity: {
      ...config.identity,
      enabled: true,
      expectedSequence: [...profile.sequence],
      symbolDuration: profile.symbolDuration,
    },
  };
}

/**
 * The bundled profile a configuration's receiver is set to, `null` when identity
 * is off, or `'custom'` for a pattern that is not one of the bundled profiles.
 *
 * For display. Read from the configuration, which is where the setting lives.
 */
export function expectedBeaconProfileOf(
  config: AstraLockConfig,
): TerminalBeaconProfile | 'custom' | null {
  if (!config.identity.enabled) return null;
  const { expectedSequence, symbolDuration } = config.identity;
  return (
    TERMINAL_BEACON_PROFILES.find(
      (profile) =>
        profile.symbolDuration === symbolDuration &&
        profile.sequence.length === expectedSequence.length &&
        profile.sequence.every((symbol, index) => symbol === expectedSequence[index]),
    ) ?? 'custom'
  );
}
