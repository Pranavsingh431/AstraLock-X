/**
 * Commands in flight.
 *
 * A command does not take effect when it is issued. It takes effect
 * `commandLatency` later — bus transport, controller scheduling and drive
 * processing, lumped into one delay — and that delay is measured in *simulated*
 * time. Using a wall-clock timer would make the mount's behaviour depend on how
 * busy the machine was, which is the one thing a reproducible experiment cannot
 * tolerate.
 *
 * The queue holds commands ordered by when they become due. Ties are broken by
 * command id, so two commands issued at the same instant always apply in the
 * order they were issued, on every run.
 */

import type { GimbalCommand, GimbalCommandId } from '@/core/contracts/gimbal';

/** A command waiting for its due time. */
export interface PendingCommand {
  readonly command: GimbalCommand;
  /** `issuedAt + commandLatency`. */
  readonly dueAt: number;
}

export class GimbalCommandQueue {
  private pending: PendingCommand[] = [];
  private nextId = 0;

  /** Next command id. Monotonic within a run, and reset with it. */
  public allocateId(): GimbalCommandId {
    const id = this.nextId as GimbalCommandId;
    this.nextId += 1;
    return id;
  }

  /** Commands still waiting, soonest first. */
  public get pendingCommands(): readonly PendingCommand[] {
    return this.pending;
  }

  public get size(): number {
    return this.pending.length;
  }

  /**
   * Queues a command.
   *
   * Insertion keeps the list sorted by due time and then by command id. Sorting
   * on insert rather than on read means the order a command applies in is fixed
   * the moment it is issued, which is what makes a replay reproduce it.
   */
  public enqueue(command: GimbalCommand, latencySeconds: number): PendingCommand {
    const dueAt = command.issuedAt + latencySeconds;
    const entry: PendingCommand = { command, dueAt };

    let index = this.pending.length;
    while (index > 0) {
      const previous = this.pending[index - 1]!;
      const later =
        previous.dueAt > dueAt ||
        (previous.dueAt === dueAt && previous.command.commandId > command.commandId);
      if (!later) break;
      index -= 1;
    }
    this.pending.splice(index, 0, entry);
    return entry;
  }

  /**
   * Removes and returns every command due at or before `throughTime`.
   *
   * There is no lower bound. Removal from the queue is what stops a command
   * applying twice, and an interval-based lower bound would strand the case
   * that matters most: a zero-latency command issued at the instant the
   * interval begins is due exactly then, and must still be applied. The caller
   * clamps the application time into the interval it is integrating.
   */
  public takeDue(throughTime: number): readonly PendingCommand[] {
    if (this.pending.length === 0) return [];

    const due: PendingCommand[] = [];
    while (this.pending.length > 0) {
      const next = this.pending[0]!;
      if (next.dueAt > throughTime) break;
      due.push(next);
      this.pending.shift();
    }
    return due;
  }

  /** Discards everything in flight and rewinds the id counter. */
  public reset(): void {
    this.pending = [];
    this.nextId = 0;
  }
}
