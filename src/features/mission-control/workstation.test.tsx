/**
 * The workstation itself: the layout, the two view modes, and the rule that
 * decides what may be drawn.
 *
 * The property worth defending here is not that a panel looks right. It is that
 * **switching to the flight-representative view changes only what is drawn**.
 * A demonstration mode that quietly altered the simulation, the recording or
 * the tracker would make every comparison between the two modes worthless, and
 * it is exactly the kind of thing that is easy to introduce by accident and
 * impossible to notice by looking.
 */

import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AppShell } from '@/app/AppShell';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useNavigationStore } from '@/stores/navigation-store';
import { useSimulationStore } from '@/stores/simulation-store';
import { selectTab } from '@/test/setup';

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="observer-canvas">{children}</div>
  ),
  useFrame: () => undefined,
}));

vi.mock('@/features/mission-control/components/ObserverScene', () => ({
  ObserverScene: () => <div data-testid="observer-scene" />,
}));

// These drive the real engine for tens of simulated seconds. The work is
// deterministic, but the wall clock it takes is not: on a loaded machine the
// default five seconds is not enough, and a timeout here would look like a
// regression rather than like contention.
vi.setConfig({ testTimeout: 180_000 });

const renderShell = (): void => {
  render(
    <TooltipProvider>
      <AppShell />
    </TooltipProvider>,
  );
};

function stepFor(seconds: number): void {
  const ticks = Math.round(seconds * useSimulationStore.getState().config.tickRate);
  act(() => {
    for (let tick = 0; tick < ticks; tick += 1) useSimulationStore.getState().stepOnce();
  });
}

beforeEach(() => {
  useNavigationStore.setState({ activeView: 'mission-control', engineeringMode: true });
  useSimulationStore.getState().setAutonomy(false);
  useSimulationStore.getState().setAlgorithm('astralock-x');
  useSimulationStore.getState().loadScenarioById('astralock-stationary');
});

describe('the workspace rail', () => {
  it('names every workspace rather than relying on an icon', () => {
    renderShell();
    const rail = within(screen.getByRole('navigation', { name: 'Primary' }));

    for (const label of [
      'Mission Control',
      'Scenario Lab',
      'AstraBench',
      'Replay',
      'Calibration',
      'Reports',
    ]) {
      expect(rail.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('switches workspaces and marks the current one for assistive technology', async () => {
    const user = userEvent.setup();
    renderShell();
    const rail = within(screen.getByRole('navigation', { name: 'Primary' }));

    expect(rail.getByRole('button', { name: 'Mission Control' })).toHaveAttribute(
      'aria-current',
      'page',
    );

    await user.click(rail.getByRole('button', { name: 'Scenario Lab' }));

    expect(useNavigationStore.getState().activeView).toBe('scenario-lab');
    expect(rail.getByRole('button', { name: 'Scenario Lab' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(rail.getByRole('button', { name: 'Mission Control' })).not.toHaveAttribute(
      'aria-current',
    );
  });
});

describe('the flight-representative view', () => {
  it('is off by default, because this is an engineering workbench', () => {
    renderShell();
    expect(useNavigationStore.getState().engineeringMode).toBe(true);
    expect(screen.getByText(/3D digital twin/i)).toBeInTheDocument();
  });

  it('removes every privileged panel at once', async () => {
    const user = userEvent.setup();
    renderShell();

    // Everything privileged switched on first, so the test is about the mode
    // rather than about the toggles happening to be off.
    act(() => {
      useSimulationStore.getState().setTruthOverlay(true);
      useSimulationStore.getState().setDisturbanceTruthVisible(true);
      useSimulationStore.getState().setActuatorTruthVisible(true);
    });

    expect(screen.getByText(/sensor overlay — debug only/i)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Switch to flight-representative view' }));

    expect(screen.queryByText(/3D digital twin/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/sensor overlay — debug only/i)).not.toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'Pointing' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Ground truth — debug only/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Actuator truth — debug only/i)).not.toBeInTheDocument();
  });

  it('restores exactly what was there when it is switched back', async () => {
    const user = userEvent.setup();
    renderShell();
    act(() => {
      useSimulationStore.getState().setTruthOverlay(true);
    });

    const toggle = (): HTMLElement =>
      screen.getByRole('button', { name: /Switch to (flight-representative|engineering) view/ });

    await user.click(toggle());
    await user.click(toggle());

    // The individual toggles were never touched, only the gate above them.
    expect(useSimulationStore.getState().showTruthOverlay).toBe(true);
    expect(screen.getByText(/sensor overlay — debug only/i)).toBeInTheDocument();
  });

  it('changes nothing the tracker does', () => {
    renderShell();
    act(() => {
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(12);

    const engineering = {
      mode: useSimulationStore.getState().patMode,
      time: useSimulationStore.getState().time,
      tick: useSimulationStore.getState().tick,
      centroidX: useSimulationStore.getState().algorithmDebug?.centroidX,
      frames: useSimulationStore.getState().algorithmDebug?.framesProcessed,
    };

    act(() => {
      useNavigationStore.getState().setEngineeringMode(false);
    });
    stepFor(0);

    expect(useSimulationStore.getState().patMode).toBe(engineering.mode);
    expect(useSimulationStore.getState().time).toBe(engineering.time);
    expect(useSimulationStore.getState().tick).toBe(engineering.tick);
    expect(useSimulationStore.getState().algorithmDebug?.centroidX).toBe(engineering.centroidX);
    expect(useSimulationStore.getState().algorithmDebug?.framesProcessed).toBe(engineering.frames);

    // And the run carries on identically from there.
    stepFor(6);
    expect(useSimulationStore.getState().runtimeError).toBeNull();
    expect(['track', 'handoff']).toContain(useSimulationStore.getState().patMode);
  });

  it('says which view it is in, in the status bar as well as the control', async () => {
    const user = userEvent.setup();
    renderShell();

    expect(
      within(screen.getByRole('contentinfo')).getByText(/^engineering view$/i),
    ).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Switch to flight-representative view' }));

    expect(within(screen.getByRole('contentinfo')).getByText(/^flight view$/i)).toBeInTheDocument();
  });
});

describe('the layout presets', () => {
  it('offers three, and marks the selected one', async () => {
    const user = userEvent.setup();
    renderShell();

    expect(screen.getByRole('button', { name: 'Operations layout' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(screen.getByRole('button', { name: 'Presentation layout' }));

    expect(screen.getByRole('button', { name: 'Presentation layout' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Operations layout' })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('hides nothing: the presentation layout still shows the diagnostics', async () => {
    const user = userEvent.setup();
    renderShell();
    act(() => {
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(10);

    await user.click(screen.getByRole('button', { name: 'Presentation layout' }));

    // A presentation view that dropped the diagnostics would be presenting a
    // different product from the one that exists.
    expect(screen.getByRole('heading', { name: /Detector/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Estimator/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Controller/i })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Channel/i })).toBeInTheDocument();
    expect(useSimulationStore.getState().patMode).not.toBeNull();
  });
});

describe('the detector panel', () => {
  it('claims nothing before the tracker is running', () => {
    renderShell();
    expect(screen.getByText('Not running')).toBeInTheDocument();
    expect(screen.queryByText('Candidates')).not.toBeInTheDocument();
  });

  it('reports the detector’s own numbers once it is', () => {
    renderShell();
    act(() => {
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(12);

    const panel = within(screen.getByRole('heading', { name: 'Detector' }).closest('section')!);
    expect(panel.getByText('Candidates')).toBeInTheDocument();
    expect(panel.getByText('Centroid')).toBeInTheDocument();
    expect(panel.getByText('Frames')).toBeInTheDocument();

    // Every one of them is the algorithm's, not the simulator's.
    const serialised = JSON.stringify(useSimulationStore.getState().algorithmDebug);
    for (const forbidden of ['truePointing', 'trueAzimuth', 'targetId', 'groundTruth']) {
      expect(serialised).not.toContain(forbidden);
    }
  });
});

describe('the telemetry dock', () => {
  it('plots the model probabilities the estimator actually reported', () => {
    renderShell();
    act(() => {
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(12);

    selectTab(screen.getByRole('tab', { name: 'Estimator' }));

    const samples = useSimulationStore.getState().responseHistory;
    expect(samples.some((sample) => sample.immCv !== null)).toBe(true);
    expect(screen.getByText(/IMM model probability/i)).toBeInTheDocument();
  });

  it('says the baseline has none rather than drawing a flat pair of lines', () => {
    act(() => {
      useSimulationStore.getState().setAlgorithm('baseline-kf-pid');
    });
    renderShell();
    act(() => {
      useSimulationStore.getState().setAutonomy(true);
    });
    stepFor(12);

    selectTab(screen.getByRole('tab', { name: 'Estimator' }));

    expect(screen.getByText(/No IMM to plot/i)).toBeInTheDocument();
    expect(useSimulationStore.getState().responseHistory.every((s) => s.immCv === null)).toBe(true);
  });
});
