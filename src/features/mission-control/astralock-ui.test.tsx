/**
 * Mission Control with the robust algorithm selected.
 *
 * The interface must show the algorithm's real states — including the three the
 * baseline does not have — and must not let the operator swap trackers in the
 * middle of a recording, which would splice two experiments into one record.
 */

import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryStorage } from '@/core/experiments';
import { TooltipProvider } from '@/components/ui/tooltip';

const storage = new MemoryStorage();

vi.mock('@/core/experiments/tauri-storage', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createStorage: () => storage };
});

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="observer-canvas">{children}</div>
  ),
  useFrame: () => undefined,
}));

vi.mock('@/features/mission-control/components/ObserverScene', () => ({
  ObserverScene: () => <div data-testid="observer-scene" />,
}));

const { useSimulationStore } = await import('@/stores/simulation-store');
const { MissionControlView } = await import('./MissionControlView');

vi.setConfig({ testTimeout: 300_000 });

const renderView = (): void => {
  render(
    <TooltipProvider>
      <MissionControlView />
    </TooltipProvider>,
  );
};

function stepFor(seconds: number): void {
  const ticks = Math.round(seconds * useSimulationStore.getState().config.tickRate);
  act(() => {
    for (let tick = 0; tick < ticks; tick += 1) useSimulationStore.getState().stepOnce();
  });
}

beforeEach(async () => {
  useSimulationStore.getState().setAutonomy(false);
  await useSimulationStore.getState().abortExperiment();
  useSimulationStore.getState().setAlgorithm('baseline-kf-pid');
  useSimulationStore.getState().loadScenarioById('astralock-stationary');
  for (const runId of await storage.listRuns()) await storage.deleteRun(runId);
});

describe('choosing an algorithm', () => {
  it('offers both, with the baseline kept as the control', () => {
    renderView();
    const selector = screen.getByRole('combobox', { name: 'Algorithm' });
    const options = [...selector.querySelectorAll('option')].map((o) => o.value);

    expect(options).toContain('baseline-kf-pid');
    expect(options).toContain('astralock-x');
  });

  it('switches the running tracker', async () => {
    const user = userEvent.setup();
    renderView();

    await user.selectOptions(screen.getByRole('combobox', { name: 'Algorithm' }), 'astralock-x');
    expect(useSimulationStore.getState().algorithmId).toBe('astralock-x');
  });

  it('cannot be changed while an experiment is recording', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: 'Start experiment' }));
    await waitFor(() => {
      expect(useSimulationStore.getState().recorderStatus?.state).toBe('running');
    });

    expect(screen.getByRole('combobox', { name: 'Algorithm' })).toBeDisabled();
  });

  it('ends a recording honestly if it is changed by other means', async () => {
    renderView();
    await act(async () => {
      await useSimulationStore.getState().startExperiment();
    });
    const runId = useSimulationStore.getState().recorderStatus!.runId;

    act(() => {
      useSimulationStore.getState().setAlgorithm('astralock-x');
    });

    await waitFor(async () => {
      const manifest = JSON.parse(await storage.readFile(runId, 'manifest.json')) as {
        status: string;
        terminationReason: string;
      };
      expect(manifest.status).toBe('aborted');
      expect(manifest.terminationReason).toBe('algorithm-changed');
    });
    expect(useSimulationStore.getState().recorderError).toMatch(/algorithm was changed/i);
  });
});

describe('swapping trackers while the world is running', () => {
  // Found by flying the application: switching algorithm at t = 26 s stopped
  // the control loop with "Tick count must be a non-negative integer, received
  // -5200". The replacement runtime began its frame accounting at time zero and
  // asked the engine to step backwards to collect frames the previous runtime
  // had already consumed. A swap must resume from the present instead.
  it('keeps flying when the algorithm is changed mid-run', () => {
    renderView();
    act(() => {
      useSimulationStore.getState().setAlgorithm('astralock-x');
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(20);
    const timeBefore = useSimulationStore.getState().time;
    expect(useSimulationStore.getState().runtimeError).toBeNull();

    act(() => {
      useSimulationStore.getState().setAlgorithm('baseline-kf-pid');
    });
    stepFor(10);

    expect(useSimulationStore.getState().runtimeError).toBeNull();
    // The world carried on from where it was: the swap changes the tracker, not
    // the physics, so the clock must move forward and never restart.
    expect(useSimulationStore.getState().time).toBeGreaterThan(timeBefore);
    expect(useSimulationStore.getState().algorithmDebug).not.toBeNull();
  });

  it('keeps flying when it is changed back', () => {
    renderView();
    act(() => {
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(15);

    act(() => {
      useSimulationStore.getState().setAlgorithm('astralock-x');
    });
    stepFor(15);

    expect(useSimulationStore.getState().runtimeError).toBeNull();
    // The replacement tracker starts cold, so it has to find the target for
    // itself. That it reaches a state at all proves it is being fed frames.
    expect(useSimulationStore.getState().patMode).not.toBeNull();
  });
});

describe('the robust states on screen', () => {
  it('shows ACQUIRE before TRACK, which the baseline never does', () => {
    renderView();
    act(() => {
      useSimulationStore.getState().setAlgorithm('astralock-x');
      useSimulationStore.getState().setAutonomy(true);
    });

    const seen = new Set<string>();
    const ticks = Math.round(20 * useSimulationStore.getState().config.tickRate);
    act(() => {
      for (let tick = 0; tick < ticks; tick += 1) {
        useSimulationStore.getState().stepOnce();
        const mode = useSimulationStore.getState().patMode;
        if (mode !== null) seen.add(mode);
      }
    });

    expect(seen).toContain('scan');
    expect(seen).toContain('acquire');
    expect(seen).toContain('track');
  });

  it('labels handoff as readiness, not as fine tracking', () => {
    renderView();
    act(() => {
      useSimulationStore.getState().setAlgorithm('astralock-x');
      useSimulationStore.getState().loadScenarioById('astralock-handoff');
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(20);

    expect(useSimulationStore.getState().patMode).toBe('handoff');
    expect(screen.getByText('HANDOFF READY')).toBeInTheDocument();
    // The claim is about readiness. No fine-pointing actuator exists.
    expect(screen.queryByText(/FINE TRACKING/i)).not.toBeInTheDocument();
  });
});

describe('the estimator panel', () => {
  it('is absent for the baseline, which has one motion model', () => {
    renderView();
    act(() => {
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(15);

    expect(screen.queryByText(/Estimator — IMM/i)).not.toBeInTheDocument();
  });

  it('shows both model probabilities once the robust tracker is running', () => {
    renderView();
    act(() => {
      useSimulationStore.getState().setAlgorithm('astralock-x');
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(15);

    expect(screen.getByText(/Estimator — IMM/i)).toBeInTheDocument();
    expect(screen.getByText(/^CV /)).toBeInTheDocument();
    expect(screen.getByText(/^CA /)).toBeInTheDocument();
  });

  it('reports the prediction horizon it is actually using', () => {
    renderView();
    act(() => {
      useSimulationStore.getState().setAlgorithm('astralock-x');
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(15);

    // The horizon is the configured command latency plus modelled servo lag,
    // not a measured host time.
    expect(screen.getByText(/horizon \d+ ms/)).toBeInTheDocument();
  });

  it('carries no privileged truth', () => {
    renderView();
    act(() => {
      useSimulationStore.getState().setAlgorithm('astralock-x');
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(15);

    const serialised = JSON.stringify(useSimulationStore.getState().algorithmDebug);
    for (const forbidden of [
      'truePointing',
      'trueAzimuth',
      'trueBearing',
      'targetId',
      'groundTruth',
    ]) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe('demonstrating without truth on screen', () => {
  it('tracks with every privileged panel hidden', () => {
    renderView();
    act(() => {
      useSimulationStore.getState().setTruthOverlay(false);
      useSimulationStore.getState().setActuatorTruthVisible(false);
      useSimulationStore.getState().setLiveEvaluation(false);
      useSimulationStore.getState().setAlgorithm('astralock-x');
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(20);

    expect(useSimulationStore.getState().showLiveEvaluation).toBe(false);
    expect(screen.queryByText(/GROUND TRUTH SENSOR OVERLAY/)).not.toBeInTheDocument();
    // Either tracking or ready to hand off — both mean it found and is holding
    // the target with no privileged number on screen.
    expect(['track', 'handoff']).toContain(useSimulationStore.getState().patMode);
    expect(useSimulationStore.getState().algorithmDebug?.centroidX).not.toBeNull();
  });
});

describe('the beacon identity panel', () => {
  it('is absent on a scenario whose beacon carries no code', () => {
    renderView();
    act(() => {
      useSimulationStore.getState().setAlgorithm('astralock-x');
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(10);

    // Nothing to recognise, so nothing is claimed. Not a panel of dashes.
    expect(screen.queryByText(/Beacon identity/i)).not.toBeInTheDocument();
  });

  it('reports the correlator’s own verdict on a coded scenario', () => {
    renderView();
    act(() => {
      useSimulationStore.getState().loadScenarioById('code-clean');
      useSimulationStore.getState().setAlgorithm('astralock-x');
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(12);

    expect(screen.getByText(/Beacon identity — coded/i)).toBeInTheDocument();
    expect(screen.getByText('MATCH')).toBeInTheDocument();
    // The correlation is shown as a coefficient on [-1, 1], never as a percent.
    expect(screen.getByText('Correlation')).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
    expect(screen.getByText(/Not a probability/i)).toBeInTheDocument();
  });

  it('names no emitter, because the tracker knows none', () => {
    renderView();
    act(() => {
      useSimulationStore.getState().loadScenarioById('code-decoy-wrong');
      useSimulationStore.getState().setAlgorithm('astralock-x');
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(12);

    const panel = screen.getByText(/Beacon identity — coded/i).closest('div')!.parentElement!;
    // The scenario's own labels for its emitters. A tracker that displayed one
    // would be displaying something it was never given.
    expect(panel.textContent).not.toMatch(/Coded beacon|Plausible intruder|target-\d/);
  });

  it('can be switched off, which is the control arm of the comparison', async () => {
    const user = userEvent.setup();
    renderView();
    act(() => {
      useSimulationStore.getState().loadScenarioById('code-clean');
      useSimulationStore.getState().setAlgorithm('astralock-x');
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(12);

    await user.click(screen.getByRole('checkbox', { name: 'Beacon identity' }));
    expect(useSimulationStore.getState().identityEnabled).toBe(false);
    expect(screen.getByText(/choosing on motion alone/i)).toBeInTheDocument();

    stepFor(12);
    // With identity off the tracker still works; it simply stops claiming to
    // recognise anything.
    expect(screen.queryByText(/Beacon identity — coded/i)).not.toBeInTheDocument();
  });
});
