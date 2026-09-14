/**
 * Bounded, explicitly-owned pixel buffers.
 *
 * A 640x480 GRAY8 frame is 307,200 bytes. At 60 FPS that is 18 MB/s of fresh
 * allocation, which a garbage collector will notice — as pauses, in the middle
 * of the thing being measured. Frames are therefore drawn from a small ring of
 * reused buffers rather than allocated per capture.
 *
 * Phase 2 reused those buffers unconditionally, so a frame held past the next
 * few captures would silently observe someone else's pixels. That was tolerable
 * while the only consumer was a synchronous draw call. It is not tolerable for
 * an asynchronous consumer, which is what a perception stage will be: the
 * failure mode is a detector that reads a half-overwritten image and produces a
 * plausible, wrong answer with no error anywhere.
 *
 * The fix is a **lease**. A buffer is loaned to exactly one holder, and the
 * pool will not hand it out again until that holder releases it. Two rules make
 * misuse hard rather than merely discouraged:
 *
 *   - reading a released lease throws, instead of returning stale pixels;
 *   - a pool with every buffer leased throws, instead of quietly aliasing.
 *
 * Both turn a silent data race into an immediate, local error. A consumer that
 * needs a frame to outlive its lease copies it — `toOwned` on the capture — and
 * pays for the copy knowingly.
 *
 * See docs/SENSOR_MODEL.md.
 */

/** Raised when a lease is used after it has gone back to the pool. */
export class FrameLeaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FrameLeaseError';
  }
}

/**
 * A pixel buffer on loan.
 *
 * Valid until `release`. Reading `pixels` afterwards throws rather than
 * returning whatever the next capture wrote there.
 */
export interface FrameLease {
  /** @throws {FrameLeaseError} once the lease has been released. */
  readonly pixels: Uint8Array;
  readonly isReleased: boolean;
  /** Returns the buffer to the pool. Safe to call more than once. */
  release(): void;
}

interface PoolSlot {
  readonly buffer: Uint8Array;
  leased: boolean;
}

export class FrameBufferPool {
  public readonly byteLength: number;
  public readonly capacity: number;

  private readonly slots: PoolSlot[] = [];
  private nextIndex = 0;
  private acquiredCount = 0;
  private leasedCount = 0;

  /**
   * @param capacity how many frames may be in flight at once. Small on purpose:
   *   a live pipeline shows the newest frame and a recorder copies what it
   *   keeps, so nothing legitimately needs a deep backlog, and a small ring
   *   surfaces a forgotten release immediately rather than rarely.
   * @throws {RangeError} for a non-positive size or capacity.
   */
  constructor(byteLength: number, capacity = 3) {
    if (!Number.isInteger(byteLength) || byteLength <= 0) {
      throw new RangeError(
        `Frame byte length must be a positive integer, received ${String(byteLength)}`,
      );
    }
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(
        `Pool capacity must be a positive integer, received ${String(capacity)}`,
      );
    }
    this.byteLength = byteLength;
    this.capacity = capacity;
  }

  /** Buffers actually allocated. Never exceeds `capacity`. */
  public get allocated(): number {
    return this.slots.length;
  }

  /** Total leases handed out, including reuses of the same memory. */
  public get acquired(): number {
    return this.acquiredCount;
  }

  /** Leases currently outstanding. */
  public get leased(): number {
    return this.leasedCount;
  }

  /** Buffers that could be leased right now. */
  public get available(): number {
    return this.capacity - this.leasedCount;
  }

  /**
   * Leases the next free buffer.
   *
   * Grows lazily up to `capacity`, so a run that never captures never
   * allocates. Scans from a rotating cursor so buffers are reused in order,
   * which keeps a released buffer out of circulation for as long as possible
   * and makes a use-after-release show up sooner.
   *
   * @throws {FrameLeaseError} when every buffer is already leased. That is a
   * leak in the consumer, not a capacity problem: something acquired a frame
   * and never released it.
   */
  public acquire(): FrameLease {
    if (this.leasedCount >= this.capacity) {
      throw new FrameLeaseError(
        `All ${String(this.capacity)} frame buffers are leased. A consumer acquired a frame ` +
          `and did not release it; copy the frame with toOwned() if it needs to outlive the lease.`,
      );
    }

    if (this.slots.length < this.capacity) {
      const slot: PoolSlot = { buffer: new Uint8Array(this.byteLength), leased: false };
      this.slots.push(slot);
      return this.leaseSlot(slot);
    }

    for (let attempt = 0; attempt < this.capacity; attempt += 1) {
      const index = (this.nextIndex + attempt) % this.capacity;
      const slot = this.slots[index]!;
      if (!slot.leased) {
        this.nextIndex = (index + 1) % this.capacity;
        return this.leaseSlot(slot);
      }
    }

    // Unreachable: leasedCount < capacity guarantees a free slot exists.
    throw new FrameLeaseError('Frame pool accounting is inconsistent');
  }

  /**
   * Releases every outstanding lease.
   *
   * For reset and disposal. A run that is torn down mid-capture must not leave
   * the pool permanently exhausted, and the alternative — tracking down every
   * holder — is exactly the bookkeeping this class exists to avoid.
   */
  public releaseAll(): void {
    for (const slot of this.slots) slot.leased = false;
    this.leasedCount = 0;
  }

  private leaseSlot(slot: PoolSlot): FrameLease {
    const returnSlot = this.returnSlot;
    slot.leased = true;
    this.leasedCount += 1;
    this.acquiredCount += 1;

    let released = false;

    return {
      get pixels(): Uint8Array {
        if (released) {
          throw new FrameLeaseError(
            'This frame buffer has been released. Its pixels now belong to the pool and may ' +
              'already have been overwritten; copy the frame before releasing it if you need it.',
          );
        }
        return slot.buffer;
      },
      get isReleased(): boolean {
        return released;
      },
      release(): void {
        // Idempotent on purpose. A double release is a bookkeeping slip, not a
        // corruption; throwing would punish defensive cleanup code.
        if (released) return;
        released = true;
        // `releaseAll` may already have cleared the slot, in which case the
        // count must not go down twice.
        if (slot.leased) {
          slot.leased = false;
          returnSlot();
        }
      },
    };
  }

  /**
   * Books one slot back in.
   *
   * A method rather than a captured `this`, so the lease closure never holds a
   * reference to the pool's identity — only to the one operation it is allowed
   * to perform.
   */
  private readonly returnSlot = (): void => {
    this.leasedCount -= 1;
  };
}
