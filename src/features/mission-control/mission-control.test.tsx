/**
 * Behaviour of the observer view.
 *
 * The 3D scene is stubbed — jsdom has no drawing context — but everything
 * around it is real: the buttons call the real engine through the store, and
 * the readouts show what the engine actually reports.
 */

import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TooltipProvider } from '@/components/ui/tooltip';
import { DEFAULT_SCENARIO_ID, loadScenario } from '@/scenarios';
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
  useSimulationStore.getState().loadScenarioById(DEFAULT_SCENARIO_ID);
});

describe('labelling', () => {
  it('says plainly which view is the world and which is the sensor', () => {
    // The two are side by side now, so the labelling matters more than ever:
    // one shows where everything really is, the other shows what the
    // instrument can actually see.
    renderView();
    expect(screen.getByText('3D WORLD — GROUND TRUTH / OBSERVER')).toBeInTheDocument();
    expect(screen.getByText(/Virtual camera — sensor feed/i)).toBeInTheDocument();
    expect(screen.getByText(/Not the tracking sensor feed/)).toBeInTheDocument();
  });

  it('marks the debug inspector as privileged', () => {
    renderView();
    expect(screen.getByText(/Ground truth — debug only/i)).toBeInTheDocument();
  });

  it('says the markers are not to scale', () => {
    renderView();
    expect(screen.getByText(/Markers are not to scale/)).toBeInTheDocument();
  });
});

describe('transport controls', () => {
  it('starts at tick zero', () => {
    renderView();
    expect(useSimulationStore.getState().tick).toBe(0);
  });

  it('advances exactly one tick per step', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: 'Step one tick' }));
    expect(useSimulationStore.getState().tick).toBe(1);

    await user.click(screen.getByRole('button', { name: 'Step one tick' }));
    expect(useSimulationStore.getState().tick).toBe(2);
  });

  it('advances simulated time by exactly one fixed timestep', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: 'Step one tick' }));

    const { time, config } = useSimulationStore.getState();
    expect(time).toBeCloseTo(1 / config.tickRate, 15);
  });

  it('returns to tick zero on reset', async () => {
    const user = userEvent.setup();
    renderView();

    for (let index = 0; index < 5; index += 1) {
      await user.click(screen.getByRole('button', { name: 'Step one tick' }));
    }
    expect(useSimulationStore.getState().tick).toBe(5);

    await user.click(screen.getByRole('button', { name: 'Reset to tick zero' }));
    expect(useSimulationStore.getState().tick).toBe(0);
    expect(useSimulationStore.getState().time).toBe(0);
  });

  it('holds the world while paused', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: 'Step one tick' }));
    const tickAfterStep = useSimulationStore.getState().tick;

    // Stepping pauses; nothing may advance while it stays paused.
    expect(useSimulationStore.getState().status).toBe('paused');
    expect(useSimulationStore.getState().tick).toBe(tickAfterStep);
  });

  it('changes playback speed without touching the world', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: 'Step one tick' }));
    const before = useSimulationStore.getState().currentFrame.targets[0]!.position;

    await user.click(screen.getByRole('button', { name: '4x' }));

    expect(useSimulationStore.getState().speed).toBe(4);
    expect(useSimulationStore.getState().tick).toBe(1);
    expect(useSimulationStore.getState().currentFrame.targets[0]!.position).toEqual(before);
  });
});

describe('scenario selection', () => {
  it('loads a different scenario and restarts it at tick zero', async () => {
    const user = userEvent.setup();
    renderView();

    await user.click(screen.getByRole('button', { name: 'Step one tick' }));
    await user.selectOptions(screen.getByLabelText('Scenario'), 'circular');

    const state = useSimulationStore.getState();
    expect(state.scenarioId).toBe('circular');
    expect(state.config.id).toBe(loadScenario('circular').id);
    expect(state.tick).toBe(0);
  });

  it('shows the seed and trajectory family of the loaded scenario', async () => {
    const user = userEvent.setup();
    renderView();

    await user.selectOptions(screen.getByLabelText('Scenario'), 'seeded-maneuver');

    expect(
      screen.getAllByText(String(loadScenario('seeded-maneuver').seed)).length,
    ).toBeGreaterThan(0);
    expect(screen.getAllByText('seeded-maneuver').length).toBeGreaterThan(0);
  });
});

describe('the view does not drive the world', () => {
  it('does not advance the simulation by rendering', () => {
    // A step() reached from render would make the world depend on the render
    // tree, which is exactly the architecture this phase forbids.
    renderView();
    const before = useSimulationStore.getState().tick;

    render(
      <TooltipProvider>
        <MissionControlView />
      </TooltipProvider>,
    );

    expect(useSimulationStore.getState().tick).toBe(before);
  });
});

describe('ground-truth inspector', () => {
  it('reports measured state, and names what is not modelled', () => {
    renderView();
    // Scoped to the panel: the header readouts also show the seed.
    const inspector = within(screen.getByRole('complementary'));

    expect(inspector.getByText('Root seed')).toBeInTheDocument();
    expect(inspector.getByText('State hash')).toBeInTheDocument();
    expect(inspector.getByText('Not modelled in Phase 1')).toBeInTheDocument();
    expect(inspector.getByText('received beacon power')).toBeInTheDocument();
  });

  it('lists the draw count of every random stream', () => {
    renderView();
    const inspector = within(screen.getByRole('complementary'));
    for (const name of ['trajectory', 'environment', 'platform', 'sensor', 'disturbance']) {
      expect(inspector.getByText(name)).toBeInTheDocument();
    }
  });
});
