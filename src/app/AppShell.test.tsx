import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';

import { useNavigationStore } from '@/stores/navigation-store';

import { AppShell } from './AppShell';
import { DEFAULT_VIEW, VIEWS, getView } from './views';

beforeEach(() => {
  useNavigationStore.setState({ activeView: DEFAULT_VIEW, previousView: null });
});

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

    // The third view in navigation order is AstraBench.
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
  it('states plainly that the view is not implemented', () => {
    render(<AppShell />);

    expect(screen.getAllByText('NOT IMPLEMENTED').length).toBeGreaterThan(0);
  });

  it('lists what the view will do and what it needs first', () => {
    render(<AppShell />);
    const view = getView(DEFAULT_VIEW);

    for (const capability of view.plannedCapabilities) {
      expect(screen.getByText(capability)).toBeInTheDocument();
    }
    for (const dependency of view.blockedBy) {
      expect(screen.getByText(dependency)).toBeInTheDocument();
    }
  });

  it('names the phase that will deliver the view', () => {
    render(<AppShell />);
    expect(screen.getByText(getView(DEFAULT_VIEW).plannedPhase)).toBeInTheDocument();
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
