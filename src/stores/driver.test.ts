/**
 * The wall-clock driver that turns animation frames into simulation ticks.
 *
 * Its one job is to convert elapsed real time into a tick budget, and the
 * conversion has a sharp edge: the timestamp an animation frame callback
 * receives is when the browser began that frame, which is not necessarily after
 * the `performance.now()` reading taken when the driver started.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSimulationStore } from './simulation-store';

/** Installs a fake rAF whose callbacks fire only when the test says so. */
function fakeAnimationFrames(): { fire: (timestamp: number) => void; pending: () => number } {
  let callbacks = new Map<number, FrameRequestCallback>();
  let nextHandle = 1;

  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback): number => {
    const handle = nextHandle++;
    callbacks.set(handle, callback);
    return handle;
  });
  vi.stubGlobal('cancelAnimationFrame', (handle: number): void => {
    callbacks.delete(handle);
  });

  return {
    fire: (timestamp) => {
      const due = [...callbacks.values()];
      callbacks = new Map();
      for (const callback of due) callback(timestamp);
    },
    pending: () => callbacks.size,
  };
}

beforeEach(() => {
  useSimulationStore.getState().setAutonomy(false);
  useSimulationStore.getState().reset();
  vi.unstubAllGlobals();
});

describe('the animation frame driver', () => {
  // Found by flying the application: pressing play partway through a frame made
  // the first callback report about a millisecond of travel backwards. The
  // store rejected the negative elapsed time, and because the throw escaped
  // before the next frame was requested, playback stopped permanently.
  it('survives a frame timestamp that precedes the start of the driver', () => {
    const frames = fakeAnimationFrames();
    const startedAt = performance.now();

    useSimulationStore.getState().start();
    expect(frames.pending()).toBe(1);

    // A frame that began 1.1 ms before the driver read the clock.
    expect(() => {
      frames.fire(startedAt - 1.1);
    }).not.toThrow();

    // The world did not move — no time had passed — but the driver is still
    // alive and has asked for the next frame.
    expect(useSimulationStore.getState().tick).toBe(0);
    expect(frames.pending()).toBe(1);

    // And it keeps working afterwards.
    frames.fire(startedAt + 100);
    expect(useSimulationStore.getState().tick).toBeGreaterThan(0);

    useSimulationStore.getState().pause();
    vi.unstubAllGlobals();
  });

  it('advances the world in proportion to real time elapsed', () => {
    const frames = fakeAnimationFrames();

    useSimulationStore.getState().start();
    // The first frame establishes the baseline. Its delta is measured against
    // the clock reading `start` took for itself, which the test does not own,
    // so only the intervals after it are exact.
    const base = performance.now() + 1000;
    frames.fire(base);
    const start = useSimulationStore.getState().tick;

    frames.fire(base + 100);
    const afterFirst = useSimulationStore.getState().tick;

    frames.fire(base + 200);
    const afterSecond = useSimulationStore.getState().tick;

    // 100 ms at the default 200 Hz tick rate is exactly 20 ticks.
    expect(afterFirst - start).toBe(20);
    expect(afterSecond - afterFirst).toBe(20);

    useSimulationStore.getState().pause();
    vi.unstubAllGlobals();
  });

  it('caps a long stall rather than running a huge batch of ticks', () => {
    const frames = fakeAnimationFrames();

    useSimulationStore.getState().start();
    const base = performance.now() + 1000;
    frames.fire(base);
    const start = useSimulationStore.getState().tick;

    // Ten seconds of the tab being asleep. The cap is 0.25 s, so the world
    // falls behind real time rather than lurching forward by two thousand
    // ticks in one frame.
    frames.fire(base + 10_000);

    expect(useSimulationStore.getState().tick - start).toBe(50);

    useSimulationStore.getState().pause();
    vi.unstubAllGlobals();
  });
});
