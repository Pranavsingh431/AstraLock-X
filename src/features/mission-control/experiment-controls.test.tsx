/**
 * Mission Control's recording controls, against the real store and loop.
 *
 * Beyond the buttons working, three things matter: the panel never shows
 * activity that is not happening; every way a recording can end — finalise,
 * abort, reset, scenario change, autonomy off, duration reached — ends it
 * honestly, with the reason on disk; and the privileged evaluation readout can
 * be hidden with the tracker still working.
 */

import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryStorage, readManifest, RUN_FILES } from '@/core/experiments';
import { TooltipProvider } from '@/components/ui/tooltip';
import { parseSimulationConfig } from '@/core/contracts/simulation';
import { loadScenario } from '@/scenarios';

const storage = new MemoryStorage();

// The store resolves its storage through `createStorage`, so swapping that one
// function points every recording at an in-memory archive.
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

vi.setConfig({ testTimeout: 180_000 });

const renderView = (): void => {
  render(
    <TooltipProvider>
      <MissionControlView />
    </TooltipProvider>,
  );
};

/**
 * Opens the rail's Experiment group.
 *
 * It is collapsed on load, like every group an operator does not need to start
 * a run. Recording lives behind one click rather than permanently occupying
 * the rail, so the tests take that click too.
 */
const openExperiment = async (): Promise<void> => {
  const group = screen.getByRole('button', { name: 'Experiment' });
  if (group.getAttribute('aria-expanded') !== 'true') {
    await userEvent.setup().click(group);
  }
};

const store = () => useSimulationStore.getState();

function stepFor(seconds: number): void {
  const ticks = Math.round(seconds * store().config.tickRate);
  act(() => {
    for (let tick = 0; tick < ticks; tick += 1) store().stepOnce();
  });
}

async function startRecording(): Promise<string> {
  await act(async () => {
    await store().startExperiment();
  });
  const status = store().recorderStatus;
  expect(status?.state).toBe('running');
  return status!.runId;
}

async function settled(runId: string) {
  await waitFor(() => {
    expect(store().recorderBusy).toBe(false);
    expect(store().recorderStatus?.state).not.toBe('running');
  });
  return readManifest(storage, runId);
}

beforeEach(async () => {
  vi.restoreAllMocks();
  store().setAutonomy(false);
  await store().abortExperiment();
  // A recording a previous test left finalising must finish before its files go.
  await waitFor(() => {
    expect(store().recorderBusy).toBe(false);
  });
  store().loadScenarioById('pat-stationary-outside-fov');
  store().setLiveEvaluation(true);
  useSimulationStore.setState({ recorderStatus: null, recorderError: null });
  for (const runId of await storage.listRuns()) await storage.deleteRun(runId);
});

describe('before a recording starts', () => {
  it('shows no run and no counters, and asks for recording before autonomy', async () => {
    renderView();
    await openExperiment();
    expect(screen.getByText(/Not recording/i)).toBeInTheDocument();
    expect(screen.queryByText('Run ID')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Stop and finalise experiment' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Abort experiment' })).toBeDisabled();
  });
});

describe('recording a real run', () => {
  it('creates a run, counts real rows, and finalises it from the files', async () => {
    const user = userEvent.setup();
    renderView();
    await openExperiment();

    await user.click(screen.getByRole('button', { name: 'Start experiment' }));
    await waitFor(() => {
      expect(store().recorderStatus?.state).toBe('running');
    });
    const runId = store().recorderStatus!.runId;
    expect(screen.getByText(runId)).toBeInTheDocument();
    // Recording, but no tracker yet: nothing is being recorded, and it says so.
    expect(screen.getByText(/Enable autonomy to begin the measured run/i)).toBeInTheDocument();
    expect(store().recorderStatus!.telemetryRows).toBe(0);

    act(() => {
      store().setAutonomy(true);
    });
    stepFor(15);

    // One telemetry row per processed frame, and not a row more: frames at
    // 0, 1/60, ..., 15 s inclusive.
    expect(store().recorderStatus!.telemetryRows).toBe(15 * 60 + 1);

    await user.click(screen.getByRole('button', { name: 'Stop and finalise experiment' }));
    const manifest = await settled(runId);
    expect(manifest.status).toBe('completed');
    expect(manifest.terminationReason).toBe('operator-finalised');
    expect(await storage.fileSize(runId, RUN_FILES.summary)).toBeGreaterThan(0);
    expect(await storage.fileSize(runId, RUN_FILES.report)).toBeGreaterThan(0);
    expect(within(screen.getByLabelText('Recording status')).getByText('completed')).toBeTruthy();
  });

  it('starting and stopping a recording mid-track does not disturb the tracker', async () => {
    // The recorder attaches to the running loop; it must not rebuild it.
    act(() => {
      store().setAutonomy(true);
    });
    stepFor(20);
    expect(store().patMode).toBe('track');

    const runId = await startRecording();
    stepFor(0.5);
    await act(async () => {
      await store().finaliseExperiment();
    });
    await settled(runId);

    // Still tracking — a rebuilt algorithm would have fallen back to search.
    stepFor(0.1);
    expect(store().patMode).toBe('track');
  });

  it('aborts only after confirmation, leaving no result', async () => {
    const user = userEvent.setup();
    renderView();
    await openExperiment();
    const runId = await startRecording();
    stepFor(1);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Abort experiment' }));
    expect(confirm).toHaveBeenCalled();
    expect(store().recorderStatus?.state).toBe('running');

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Abort experiment' }));
    const manifest = await settled(runId);
    expect(manifest.status).toBe('aborted');
    await expect(storage.readFile(runId, RUN_FILES.summary)).rejects.toThrow();
  });
});

describe('every way a recording can end', () => {
  it('reset asks first, and if confirmed aborts with the reason recorded', async () => {
    const user = userEvent.setup();
    renderView();
    await openExperiment();
    const runId = await startRecording();
    act(() => {
      store().setAutonomy(true);
    });
    stepFor(2);

    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false);
    await user.click(screen.getByRole('button', { name: 'Reset to tick zero' }));
    expect(confirm).toHaveBeenCalled();
    expect(store().recorderStatus?.state).toBe('running');
    expect(store().tick).toBeGreaterThan(0);

    confirm.mockReturnValueOnce(true);
    await user.click(screen.getByRole('button', { name: 'Reset to tick zero' }));
    const manifest = await settled(runId);
    expect(manifest.status).toBe('aborted');
    expect(manifest.terminationReason).toBe('simulation-reset');
    expect(store().tick).toBe(0);
  });

  it('changing scenario aborts with its own reason', async () => {
    const runId = await startRecording();
    stepFor(0.5);
    act(() => {
      store().loadScenarioById('pat-moving-target');
    });
    const manifest = await settled(runId);
    expect(manifest.status).toBe('aborted');
    expect(manifest.terminationReason).toBe('scenario-changed');
  });

  it('switching autonomy off ends the measurement window and finalises', async () => {
    const runId = await startRecording();
    act(() => {
      store().setAutonomy(true);
    });
    stepFor(3);
    act(() => {
      store().setAutonomy(false);
    });
    const manifest = await settled(runId);
    expect(manifest.status).toBe('completed');
    expect(manifest.terminationReason).toBe('autonomy-disabled');
    const events = await storage.readFile(runId, RUN_FILES.events);
    expect(events).toContain('"autonomy-disabled"');
  });

  it('the emergency stop never asks, and finalises honestly', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    const runId = await startRecording();
    act(() => {
      store().setAutonomy(true);
    });
    stepFor(1);
    act(() => {
      store().emergencyStop();
    });
    const manifest = await settled(runId);
    expect(confirm).not.toHaveBeenCalled();
    expect(manifest.status).toBe('completed');
    expect(manifest.terminationReason).toBe('autonomy-disabled');
  });

  it('reaching the scenario duration finalises with that reason', async () => {
    const short = parseSimulationConfig({
      ...loadScenario('pat-stationary-outside-fov'),
      duration: 2,
    });
    act(() => {
      store().loadConfig(short, null);
    });
    const runId = await startRecording();
    act(() => {
      store().setAutonomy(true);
      store().start();
      store().pause();
      store().resume();
      // Advance in frame-sized pieces, as the driver does, past the end.
      for (let i = 0; i < 400 && store().recorderStatus?.state === 'running'; i += 1) {
        store().advance(1 / 60);
      }
      store().pause();
    });
    const manifest = await settled(runId);
    expect(manifest.status).toBe('completed');
    expect(manifest.terminationReason).toBe('scenario-duration-reached');
    const events = await storage.readFile(runId, RUN_FILES.events);
    expect(events).toContain('"simulation-completed"');
    expect(events).toContain('"simulation-paused"');
  });

  it('a storage that refuses to start shows the error and records nothing', async () => {
    vi.spyOn(storage, 'createRun').mockRejectedValueOnce(new Error('read-only volume'));
    renderView();
    await openExperiment();
    await act(async () => {
      await store().startExperiment();
    });
    expect(store().recorderStatus).toBeNull();
    expect(screen.getByRole('alert')).toHaveTextContent(/read-only volume/);
    expect(await storage.listRuns()).toEqual([]);
  });

  it('a writer that fails mid-run detaches the recorder, and the tracker carries on', async () => {
    renderView();
    await openExperiment();
    const runId = await startRecording();
    act(() => {
      store().setAutonomy(true);
    });
    stepFor(1);
    vi.spyOn(storage, 'append').mockRejectedValue(new Error('disk full'));
    stepFor(4);
    // No further stepping: the failure must surface while the run is idle.
    await waitFor(() => {
      expect(store().recorderError).toBe('disk full');
    });
    expect(store().recorderStatus?.state).toBe('failed');
    expect(store().isRecording()).toBe(false);
    expect((await readManifest(storage, runId)).status).toBe('failed');
    stepFor(15);
    expect(store().patMode).toBe('track');
  });
});

describe('the live evaluation readout', () => {
  it('is labelled as ground truth', async () => {
    renderView();
    await openExperiment();
    expect(screen.getByText(/Evaluation — ground truth/i)).toBeInTheDocument();
  });

  it('shows instantaneous figures without a recording, and confirmed lock with one', async () => {
    act(() => {
      store().setAutonomy(true);
    });
    stepFor(20);
    const instantaneous = store().liveEvaluation!;
    expect(instantaneous.source).toBe('instantaneous');
    expect(instantaneous.angularPointingErrorRad).not.toBeNull();
    expect(instantaneous.lockConditionMet).toBe(true);
    // Confirmed lock needs a history; without one it is N/A, not a guess.
    expect(instantaneous.locked).toBeNull();
    expect(instantaneous.retention).toBeNull();

    await startRecording();
    stepFor(1);
    const recorded = store().liveEvaluation!;
    expect(recorded.source).toBe('recording');
    expect(recorded.locked).toBe(true);
    expect(recorded.retention).toBe(1);
    expect(recorded.framesProcessed).toBe(60);
  });

  it('describes the new recording as soon as it starts, not the previous one', async () => {
    act(() => {
      store().setAutonomy(true);
    });
    stepFor(20);
    const first = await startRecording();
    stepFor(1);
    expect(store().liveEvaluation!.locked).toBe(true);
    await act(async () => {
      await store().finaliseExperiment();
    });
    await settled(first);

    // Straight after starting, with no frame recorded yet.
    await startRecording();
    const fresh = store().liveEvaluation!;
    expect(fresh.source).toBe('recording');
    expect(fresh.framesProcessed).toBe(0);
    expect(fresh.locked).toBe(false);
    expect(fresh.retention).toBeNull();
  });

  it('can be hidden — then it is not computed — and the tracker still acquires', async () => {
    const user = userEvent.setup();
    renderView();
    await openExperiment();

    await user.click(screen.getByRole('button', { name: 'Hide live evaluation' }));
    expect(store().showLiveEvaluation).toBe(false);
    expect(screen.getByText(/Hidden, and not computed/i)).toBeInTheDocument();

    act(() => {
      store().setAutonomy(true);
    });
    stepFor(20);

    expect(store().liveEvaluation).toBeNull();
    const panel = screen.getByText(/Evaluation — ground truth/i).closest('div')!.parentElement!;
    expect(within(panel).queryByText(/µrad/)).not.toBeInTheDocument();
    expect(store().patMode).toBe('track');
    expect(store().algorithmDebug?.centroidX).not.toBeNull();
  });
});

describe('unmodelled values', () => {
  it('show as not modelled, never as a number', async () => {
    renderView();
    await openExperiment();
    act(() => {
      store().setAutonomy(true);
    });
    stepFor(20);

    expect(store().detectionSnr).toEqual({ value: null, status: 'not-modelled', unit: 'dB' });
    const snrLabel = screen.getByText('SNR');
    expect(snrLabel.parentElement).toHaveTextContent('Not modelled');
    expect(screen.queryByText(/\b0(\.0)? dB\b/)).not.toBeInTheDocument();
  });
});

describe('what the operator cannot type', () => {
  it('offers no editable field for any measured value', async () => {
    renderView();
    await openExperiment();
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryAllByRole('spinbutton')).toEqual([]);
  });
});
