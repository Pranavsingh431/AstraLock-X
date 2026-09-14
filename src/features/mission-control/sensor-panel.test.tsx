/**
 * The sensor panel shows the real frame.
 *
 * jsdom has no WebGL, so the 3D scene is stubbed; the sensor monitor is not,
 * because it draws to a 2D canvas and that is the thing worth testing — the
 * pixels on screen have to be the sensor's, not a substitute.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { useSimulationStore } from '@/stores/simulation-store';

import { MissionControlView } from './MissionControlView';

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="observer-canvas">{children}</div>
  ),
  useFrame: () => undefined,
}));

vi.mock('@/features/mission-control/components/ObserverScene', () => ({
  ObserverScene: () => <div data-testid="observer-scene" />,
}));

const renderView = (): void => {
  render(
    <TooltipProvider>
      <MissionControlView />
    </TooltipProvider>,
  );
};

beforeEach(() => {
  useSimulationStore.getState().loadScenarioById('camera-boresight');
});

describe('labelling', () => {
  it('names the two views so they cannot be confused', () => {
    renderView();
    expect(screen.getByText('3D WORLD — GROUND TRUTH / OBSERVER')).toBeInTheDocument();
    expect(screen.getByText(/Virtual camera — sensor feed/i)).toBeInTheDocument();
  });

  it('claims nothing about tracking, because nothing tracks yet', () => {
    renderView();
    for (const forbidden of [/LOCKED/i, /acquisition/i, /confidence/i, /centroid/i]) {
      expect(screen.queryByText(forbidden)).not.toBeInTheDocument();
    }
  });
});

describe('sensor metadata', () => {
  it('reports what a real camera reports about itself', () => {
    renderView();
    const panel = within(screen.getByLabelText('Virtual camera sensor feed').closest('section')!);

    expect(panel.getByText('Frame')).toBeInTheDocument();
    expect(panel.getByText('Capture time')).toBeInTheDocument();
    expect(panel.getByText('Resolution')).toBeInTheDocument();
    expect(panel.getByText('Configured FPS')).toBeInTheDocument();
    expect(panel.getByText('Camera az')).toBeInTheDocument();
    expect(panel.getByText('Camera el')).toBeInTheDocument();
  });

  it('shows the configured resolution and rate', () => {
    renderView();
    expect(screen.getByText('640×480')).toBeInTheDocument();
    expect(screen.getByText('60 Hz')).toBeInTheDocument();
  });
});

describe('manual pointing', () => {
  it('moves the mount without moving the world', () => {
    renderView();
    const before = useSimulationStore.getState();

    useSimulationStore.getState().nudgeCamera(0.05, 0);

    const after = useSimulationStore.getState();
    expect(after.cameraAzimuth).toBeCloseTo(before.cameraAzimuth + 0.05, 9);
    expect(after.tick).toBe(before.tick);
    // The target has not moved: its rendered world position is unchanged.
    expect(after.currentFrame.targets[0]!.position).toEqual(
      before.currentFrame.targets[0]!.position,
    );
  });

  it('changes the sensor image', async () => {
    const user = userEvent.setup();
    renderView();

    const before = useSimulationStore.getState().sensorFrame;
    await user.click(screen.getByRole('button', { name: 'Pan right' }));
    const after = useSimulationStore.getState().sensorFrame;

    expect(after?.pose.azimuth).not.toBe(before?.pose.azimuth);
  });

  it('returns to the configured boresight on reset', async () => {
    const user = userEvent.setup();
    renderView();

    const configured = useSimulationStore.getState().config.camera.initialAzimuth;
    useSimulationStore.getState().nudgeCamera(0.3, 0.1);
    await user.click(screen.getByRole('button', { name: 'Reset boresight' }));

    expect(useSimulationStore.getState().cameraAzimuth).toBeCloseTo(configured, 9);
  });

  it('keeps working while the world is paused', () => {
    // The camera does not stop existing because the run is held.
    renderView();
    useSimulationStore.getState().stepOnce();
    const tick = useSimulationStore.getState().tick;

    useSimulationStore.getState().nudgeCamera(0.02, 0);

    expect(useSimulationStore.getState().tick).toBe(tick);
    expect(useSimulationStore.getState().cameraAzimuth).not.toBe(0);
  });
});

describe('truth overlay', () => {
  it('is off by default', () => {
    renderView();
    expect(useSimulationStore.getState().showTruthOverlay).toBe(false);
    expect(screen.queryByText(/GROUND TRUTH SENSOR OVERLAY/)).not.toBeInTheDocument();
  });

  it('is labelled as debug-only when enabled', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('checkbox', { name: 'Ground truth sensor overlay' }));

    expect(screen.getByText('GROUND TRUTH SENSOR OVERLAY — DEBUG ONLY')).toBeInTheDocument();
  });

  it('draws from the evaluation record, not from the frame', () => {
    // The frame does not contain the true projected centre; the overlay needs
    // it, so it must come from the privileged object.
    renderView();
    const state = useSimulationStore.getState();

    expect(state.sensorTruth).not.toBeNull();
    expect(state.sensorTruth?.projections[0]?.imageX).not.toBeNull();
    expect(Object.keys(state.sensorFrame ?? {})).not.toContain('imageX');
  });
});

describe('the frame handed to the UI', () => {
  it('is the sensor frame contract, carrying no truth', () => {
    renderView();
    const frame = useSimulationStore.getState().sensorFrame;

    expect(frame).not.toBeNull();
    expect(frame?.data.length).toBe(640 * 480);
    expect(frame?.format).toBe('mono8');
    expect(Object.keys(frame ?? {})).not.toContain('truth');
  });
});
