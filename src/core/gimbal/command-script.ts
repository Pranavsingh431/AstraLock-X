/**
 * A scripted sequence of pointing commands.
 *
 * A validation facility, not an experiment recorder. Its job is to let a test
 * say "issue these commands at these simulated times" and get the same actuator
 * trajectory and the same pixels every run, which is what makes an actuator
 * regression detectable at all.
 *
 * Commands are issued when simulated time reaches their entry, so the script is
 * a function of simulated time alone. Nothing here reads a wall clock.
 */

import { radians, seconds } from '@/core/contracts/units';
import type { Radians, Seconds } from '@/core/contracts/units';

import type { DynamicGimbal } from './dynamic-gimbal';

/** One scripted command. */
export interface ScriptedCommand {
  /** Simulated time at which to issue it. */
  readonly at: Seconds;
  readonly pan: Radians;
  readonly tilt: Radians;
}

/** Builds a script entry from plain numbers, for readability at call sites. */
export const at = (time: number, pan: number, tilt: number): ScriptedCommand => ({
  at: seconds(time),
  pan: radians(pan),
  tilt: radians(tilt),
});

/**
 * Issues scripted commands as simulated time passes.
 *
 * Sorted once at construction, then consumed in order. Entries at the same
 * instant are issued in the order they were written, so a script reads the way
 * it behaves.
 */
export class GimbalCommandScript {
  private readonly entries: readonly ScriptedCommand[];
  private nextIndex = 0;

  constructor(entries: readonly ScriptedCommand[]) {
    for (const entry of entries) {
      if (!Number.isFinite(entry.at) || entry.at < 0) {
        throw new RangeError(
          `Scripted command time must be finite and non-negative, got ${String(entry.at)}`,
        );
      }
    }
    // Stable sort by time; ties keep their written order.
    this.entries = [...entries]
      .map((entry, index) => ({ entry, index }))
      .sort((a, b) => a.entry.at - b.entry.at || a.index - b.index)
      .map(({ entry }) => entry);
  }

  public get length(): number {
    return this.entries.length;
  }

  public get issued(): number {
    return this.nextIndex;
  }

  public get isComplete(): boolean {
    return this.nextIndex >= this.entries.length;
  }

  /**
   * Issues every entry whose time has arrived.
   *
   * Called after the engine advances, with the new simulated time. Entries are
   * issued at the tick they become due rather than at their exact scripted
   * instant — the script says when the *operator* acts, and an operator acts at
   * whatever moment the system next looks. Command *latency*, which is a
   * property of the hardware rather than of the operator, is applied exactly.
   *
   * @returns how many commands were issued.
   */
  public issueDue(gimbal: DynamicGimbal, currentTime: number): number {
    let issued = 0;
    while (this.nextIndex < this.entries.length) {
      const entry = this.entries[this.nextIndex]!;
      if (entry.at > currentTime) break;
      gimbal.commandPosition(entry.pan, entry.tilt);
      this.nextIndex += 1;
      issued += 1;
    }
    return issued;
  }

  /** Rewinds to the beginning. */
  public reset(): void {
    this.nextIndex = 0;
  }
}
