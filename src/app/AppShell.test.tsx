import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The shell tests are about navigation, not about WebGL.
 *
 * jsdom has no drawing context, so the 3D canvas is replaced with a plain
 * element. Everything around it — the transport controls, the readouts, the
 * ground-truth inspector — is real, and the rendered scene is verified by
 * running the application.
 */
vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: React.ReactNode }) => (
    <div data-testid="observer-canvas">{children}</div>
  ),
  useFrame: () => undefined,
}));

// drei's helpers call R3F hooks, which throw outside a real Canvas, so the
// scene contents are stubbed as well.
vi.mock('@/features/mission-control/components/ObserverScene', () => ({
  ObserverScene: () => <div data-testid="observer-scene" />,
}));

import { useNavigationStore } from '@/stores/navigation-store';

import { AppShell } from './AppShell';
import { DEFAULT_VIEW, VIEWS, getView } from './views';

beforeEach(() => {
  useNavigationStore.setState({ activeView: DEFAULT_VIEW, previousView: null });
});

/**
 * A view that is still a placeholder.
 *
 * Mission Control became real in Phase 1 and AstraBench in Phase 9, so the
 * placeholder assertions keep moving to a view that is genuinely still unbuilt
 * rather than being deleted. Replay is the next one.
 */
const PLACEHOLDER_VIEW = 'replay' as const;

describe('AppShell', () => {
  it('opens on the default view', () => {
    render(<AppShell />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(
      getView(DEFAULT_VIEW).label,
    );
  });

  it('offers one navigation control per view', () => {
    render(<AppShell />);

    const nav = screen.getByRole('navigation', { name: 'Primary' });
    for (const view of VIEWS) {
      expect(screen.getByRole('button', { name: view.label })).toBeInTheDocument();
    }
    expect(nav).toBeInTheDocument();
  });

  it('switches view when a navigation control is activated', async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole('button', { name: 'Scenario Lab' }));

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Scenario Lab');
    expect(useNavigationStore.getState().activeView).toBe('scenario-lab');
  });

  it('marks the active control for assistive technology', async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.click(screen.getByRole('button', { name: 'Replay' }));

    expect(screen.getByRole('button', { name: 'Replay' })).toHaveAttribute('aria-current', 'page');
    expect(screen.getByRole('button', { name: 'Reports' })).not.toHaveAttribute('aria-current');
  });

  it('switches view from the keyboard shortcut', async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    // The third view in navigation order is AstraBench, which became a real
    // workspace in Phase 9 — so this now exercises the shortcut against a view
    // that renders something rather than a placeholder.
    await user.keyboard('{Control>}3{/Control}');

    expect(useNavigationStore.getState().activeView).toBe('astrabench');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('AstraBench');
  });

  it('ignores a modified shortcut that belongs to something else', async () => {
    const user = userEvent.setup();
    render(<AppShell />);

    await user.keyboard('{Control>}{Shift>}3{/Shift}{/Control}');

    expect(useNavigationStore.getState().activeView).toBe(DEFAULT_VIEW);
  });
});

describe('placeholder views', () => {
  beforeEach(() => {
    useNavigationStore.setState({ activeView: PLACEHOLDER_VIEW, previousView: null });
  });

  it('states plainly that the view is not implemented', () => {
    render(<AppShell />);
    expect(screen.getAllByText(/FUTURE WORK/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/Not part of this prototype/i)).toBeInTheDocument();
  });

  it('lists what the view will do and what it needs first', () => {
    render(<AppShell />);
    const view = getView(PLACEHOLDER_VIEW);

    for (const capability of view.plannedCapabilities) {
      expect(screen.getByText(capability)).toBeInTheDocument();
    }
    for (const dependency of view.blockedBy) {
      expect(screen.getByText(dependency)).toBeInTheDocument();
    }
  });

  it('promises no delivery date, because there is no schedule', () => {
    // A deferred view used to name the phase that would deliver it. That was a
    // schedule claim about work this prototype has decided not to do, so the
    // registry now carries `null` and the screen says "deferred" instead.
    expect(getView(PLACEHOLDER_VIEW).deliveredIn).toBeNull();

    render(<AppShell />);
    expect(screen.getByText(/Deferred to a later stage/i)).toBeInTheDocument();
    expect(screen.queryByText(/^Phase \d+$/)).not.toBeInTheDocument();
  });

  it('does not label an implemented view as unimplemented', () => {
    useNavigationStore.setState({ activeView: 'mission-control', previousView: null });
    render(<AppShell />);
    expect(screen.queryByText(/FUTURE WORK/i)).not.toBeInTheDocument();
  });
});

describe('status bar', () => {
  it('reports real build facts', () => {
    render(<AppShell />);

    const footer = screen.getByRole('contentinfo');
    expect(footer).toHaveTextContent('AstraLock-X');
    expect(footer).toHaveTextContent(/v\d+\.\d+\.\d+/);
    // Vitest runs outside the Tauri webview, so the host must report as browser.
    expect(footer).toHaveTextContent('browser');
  });
});
