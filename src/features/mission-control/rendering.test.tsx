/**
 * What the interface costs while the engine is running.
 *
 * Phase 1 shipped a Zustand selector that returned a fresh object every call,
 * which made React re-render on every store write and then loop. It was fixed
 * by selecting scalars, but nothing stopped it coming back — and the failure is
 * not a crash, it is an application that is merely slow, which nobody bisects.
 *
 * So this file measures the three properties that keep the workstation cheap
 * while the engine appends telemetry at about 60 Hz:
 *
 *   1. a panel that depends on unchanged state does not re-render;
 *   2. the telemetry buffers stay bounded, so a long run does not grow the
 *      heap or the work per frame;
 *   3. the PAT timeline keeps its array identity while the mode is unchanged,
 *      which is what stops a 60 Hz append invalidating a selector that only
 *      cares about transitions.
 *
 * These are counts and lengths, not wall-clock budgets, so they mean the same
 * thing on a loaded machine as on an idle one.
 */

import { act, render } from '@testing-library/react';
import { useEffect } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useSimulationStore } from '@/stores/simulation-store';

// Four thousand frames, each in its own React commit, is deliberately slow —
// that is what makes the count mean anything. The work is deterministic; the
// wall clock it takes is not.
vi.setConfig({ testTimeout: 180_000 });

/**
 * Commits, counted from an effect rather than from the render body.
 *
 * An effect with no dependency array runs after every commit, which is the
 * thing being measured: how often React actually had to do work. Counting in
 * the render body would mean mutating during render, which the compiler rules
 * forbid for good reason and which double-invoking would skew anyway.
 */
let commits = 0;

/** Subscribes exactly as a real diagnostics panel does. */
function CountingPanel(): React.JSX.Element {
  // The same shape the diagnostics panels use: scalars and stable references,
  // never an object assembled inside the selector.
  const mode = useSimulationStore((state) => state.patMode);
  const algorithmId = useSimulationStore((state) => state.algorithmId);
  const autonomy = useSimulationStore((state) => state.autonomyEnabled);

  useEffect(() => {
    commits += 1;
  });

  return <div>{`${String(mode)} ${algorithmId} ${String(autonomy)}`}</div>;
}

function stepFor(seconds: number): void {
  const ticks = Math.round(seconds * useSimulationStore.getState().config.tickRate);
  act(() => {
    for (let tick = 0; tick < ticks; tick += 1) useSimulationStore.getState().stepOnce();
  });
}

/**
 * Steps one frame at a time, each in its own `act`.
 *
 * Counting renders around a single `act` that runs two thousand frames would
 * measure React's batching and nothing else: the whole run collapses into one
 * commit and any selector, however wasteful, reports one render. Giving each
 * frame its own commit boundary is what the application actually does, and it
 * is the only way the count means anything.
 */
function stepEachFrame(seconds: number): number {
  const ticks = Math.round(seconds * useSimulationStore.getState().config.tickRate);
  for (let tick = 0; tick < ticks; tick += 1) {
    act(() => {
      useSimulationStore.getState().stepOnce();
    });
  }
  return ticks;
}

beforeEach(() => {
  useSimulationStore.getState().setAutonomy(false);
  useSimulationStore.getState().setAlgorithm('astralock-x');
  useSimulationStore.getState().loadScenarioById('astralock-stationary');
});

describe('the cost of a running engine', () => {
  it('does not re-render a panel once per frame', () => {
    commits = 0;
    render(<CountingPanel />);

    act(() => {
      useSimulationStore.getState().setAutonomy(true);
    });
    const before = commits;

    const frames = stepEachFrame(20);
    const renders = commits - before;

    // The panel re-renders on PAT transitions, of which a twenty-second
    // acquisition has a handful. Anything approaching the frame count means a
    // selector has started returning a new value on every store write — the
    // Phase 1 mistake, which did not announce itself either.
    expect(frames).toBeGreaterThan(2000);
    // It really did pass through the states, so the count is not low merely
    // because nothing happened.
    expect(useSimulationStore.getState().patMode).not.toBe('scan');
    expect(renders).toBeLessThan(20);
    expect(renders).toBeLessThan(frames / 100);
  });

  it('keeps the telemetry buffers bounded over a long run', () => {
    act(() => {
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(45);

    const state = useSimulationStore.getState();
    expect(state.responseHistory.length).toBeLessThanOrEqual(600);
    expect(state.patTimeline.length).toBeLessThanOrEqual(200);
    // And it really did run long enough for the cap to matter.
    expect(state.tick).toBeGreaterThan(2000);
  });

  it('keeps the timeline’s identity while the mode is unchanged', () => {
    act(() => {
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(12);

    const settled = useSimulationStore.getState().patTimeline;
    const mode = useSimulationStore.getState().patMode;
    stepFor(0.5);

    if (useSimulationStore.getState().patMode === mode) {
      // Same array, not an equal one: a new array on every frame would wake
      // every consumer of the timeline sixty times a second.
      expect(useSimulationStore.getState().patTimeline).toBe(settled);
    }
  });
});
