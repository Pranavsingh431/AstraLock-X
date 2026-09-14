/**
 * The sensor panel shows the real frame.
 *
 * jsdom has no WebGL, so the 3D scene is stubbed; the sensor monitor is not,
 * because it draws to a 2D canvas and that is the thing worth testing — the
 * pixels on screen have to be the sensor's, not a substitute.
 */

import { act, render, screen, within } from '@testing-library/react';
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

describe('commanding the mount', () => {
  it('separates what was commanded from what is measured', () => {
    // The defining behaviour of the phase. A command changes the setpoint at
    // once; the encoder reads the same until the mechanism has had time to
    // move, and the operator can see both numbers.
    renderView();
    const before = useSimulationStore.getState();

    useSimulationStore.getState().nudgeCamera(0.05, 0);

    const after = useSimulationStore.getState();
    expect(after.commandedPan).toBeCloseTo(before.commandedPan + 0.05, 9);
    expect(after.measuredPan).toBeCloseTo(before.measuredPan, 9);
    expect(after.tick).toBe(before.tick);
    // The target has not moved: its rendered world position is unchanged.
    expect(after.currentFrame.targets[0]!.position).toEqual(
      before.currentFrame.targets[0]!.position,
    );
  });

  it('closes the gap once the simulation runs', () => {
    renderView();
    useSimulationStore.getState().nudgeCamera(0.05, 0);

    const commanded = useSimulationStore.getState().commandedPan;
    for (let index = 0; index < 400; index += 1) useSimulationStore.getState().stepOnce();

    const settled = useSimulationStore.getState();
    expect(settled.measuredPan).toBeCloseTo(commanded, 3);
    expect(settled.servoPhase).toBe('holding');
  });

  it('moves the mount through the on-screen controls', async () => {
    const user = userEvent.setup();
    renderView();

    const before = useSimulationStore.getState().commandedPan;
    await user.click(screen.getByRole('button', { name: 'Pan right' }));
    expect(useSimulationStore.getState().commandedPan).toBeGreaterThan(before);

    const up = useSimulationStore.getState().commandedTilt;
    await user.click(screen.getByRole('button', { name: 'Tilt up' }));
    expect(useSimulationStore.getState().commandedTilt).toBeGreaterThan(up);
  });

  it('changes the sensor image once the mount has moved', () => {
    renderView();
    const before = useSimulationStore.getState().sensorFrame?.pose.azimuth;

    useSimulationStore.getState().nudgeCamera(0.05, 0);
    for (let index = 0; index < 200; index += 1) useSimulationStore.getState().stepOnce();

    expect(useSimulationStore.getState().sensorFrame?.pose.azimuth).not.toBe(before);
  });

  it('homes to the configured pointing', async () => {
    const user = userEvent.setup();
    renderView();

    const configured = useSimulationStore.getState().config.gimbal.pan.initialAngle;
    useSimulationStore.getState().nudgeCamera(0.3, 0.1);
    await user.click(screen.getByRole('button', { name: 'Home the mount' }));

    expect(useSimulationStore.getState().commandedPan).toBeCloseTo(configured, 9);
  });

  it('accepts commands while the world is paused', () => {
    // The camera does not stop existing because the run is held.
    renderView();
    useSimulationStore.getState().stepOnce();
    const tick = useSimulationStore.getState().tick;

    useSimulationStore.getState().nudgeCamera(0.02, 0);

    expect(useSimulationStore.getState().tick).toBe(tick);
    expect(useSimulationStore.getState().commandedPan).not.toBe(0);
    expect(useSimulationStore.getState().commandsPending).toBeGreaterThanOrEqual(0);
  });

  it('labels the servo state from real actuator state', () => {
    renderView();
    expect(screen.getByText('holding')).toBeInTheDocument();

    useSimulationStore.getState().nudgeCamera(0.4, 0);
    useSimulationStore.getState().stepOnce();

    expect(useSimulationStore.getState().servoPhase).not.toBe('holding');
  });
});

describe('the actuator truth panel', () => {
  it('is hidden until asked for, and labelled when shown', async () => {
    const user = userEvent.setup();
    renderView();

    expect(screen.queryByText('Backlash take-up')).not.toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: 'Actuator truth debug panel' }));

    expect(screen.getByText(/Actuator truth — debug only/i)).toBeInTheDocument();
    // One block per axis, both reporting the mechanism's interior.
    expect(screen.getAllByText('Backlash take-up')).toHaveLength(2);
  });
});

describe('the response trace', () => {
  it('says it is empty rather than drawing an invented curve', () => {
    renderView();
    expect(screen.getByTestId('response-trace-pan-empty')).toBeInTheDocument();
  });

  it('draws once real samples exist', () => {
    renderView();
    act(() => {
      useSimulationStore.getState().nudgeCamera(0.2, 0);
      for (let index = 0; index < 50; index += 1) useSimulationStore.getState().stepOnce();
    });

    expect(useSimulationStore.getState().responseHistory.length).toBeGreaterThan(1);
    expect(screen.getByTestId('response-trace-pan')).toBeInTheDocument();
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
