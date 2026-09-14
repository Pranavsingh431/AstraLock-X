/**
 * Bounded ownership for frame pixel buffers.
 *
 * A 640x480 GRAY8 frame is 307,200 bytes. At 60 FPS that is 18 MB/s of fresh
 * allocation, which a garbage collector will notice — as pauses, in the middle
 * of the thing being measured. Frames are therefore drawn from a small ring of
 * reused buffers rather than allocated per capture.
 *
 * The cost of reuse is that a buffer is **not owned by the frame that was given
 * it**. After `capacity` further frames the same memory is handed out again and
 * the old frame's pixels change underneath it. That is a sharp edge, so it is
 * stated plainly here, enforced by a small capacity that makes the problem
 * appear immediately rather than rarely, and given an escape hatch: a consumer
 * that needs to keep a frame copies it.
 *
 * This is deliberately not a general allocator. It is a ring of buffers.
 */

export class FrameBufferPool {
  public readonly byteLength: number;
  public readonly capacity: number;

  private readonly buffers: Uint8Array[] = [];
  private nextIndex = 0;
  private acquiredCount = 0;

  /**
   * @param capacity how many frames may be in flight before memory is reused.
   *   Small on purpose: a live pipeline shows the newest frame and a recorder
   *   copies what it keeps, so nothing legitimately needs a deep backlog.
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

  /** Buffers actually allocated so far. Never exceeds `capacity`. */
  public get allocated(): number {
    return this.buffers.length;
  }

  /** Total buffers handed out, including reuses. */
  public get acquired(): number {
    return this.acquiredCount;
  }

  /**
   * Next buffer in the ring.
   *
   * Grows lazily up to `capacity`, so a run that never produces frames never
   * allocates one.
   */
  public acquire(): Uint8Array {
    this.acquiredCount += 1;

    if (this.buffers.length < this.capacity) {
      const created = new Uint8Array(this.byteLength);
      this.buffers.push(created);
      this.nextIndex = this.buffers.length % this.capacity;
      return created;
    }

    const reused = this.buffers[this.nextIndex]!;
    this.nextIndex = (this.nextIndex + 1) % this.capacity;
    return reused;
  }
}
