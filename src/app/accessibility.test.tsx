/**
 * The accessibility floor, checked across every workspace.
 *
 * Not a substitute for an audit. It defends one property that is cheap to
 * break and expensive to notice: **every control has an accessible name.**
 *
 * A workstation this dense is full of icon buttons and two-letter chips, and
 * an unnamed one is invisible to a screen reader and unaddressable from a
 * test. The failure mode is silent — the interface looks finished — so it is
 * checked rather than reviewed.
 *
 * The sweep opens every collapsed group in Mission Control first, because a
 * control that is not in the document cannot be missing a name.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { AppShell } from '@/app/AppShell';
import { VIEW_IDS, type ViewId } from '@/app/views';
import { TooltipProvider } from '@/components/ui/tooltip';
import { useNavigationStore } from '@/stores/navigation-store';

vi.mock('@react-three/fiber', () => ({
  Canvas: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
  useFrame: () => undefined,
}));

vi.mock('@/features/mission-control/components/ObserverScene', () => ({
  ObserverScene: () => <div />,
}));

vi.setConfig({ testTimeout: 120_000 });

/** Roles a user operates. A named control is one with text or an aria-label. */
const OPERABLE = ['button', 'checkbox', 'combobox', 'tab', 'textbox', 'spinbutton'] as const;

function unnamedControls(): readonly string[] {
  const unnamed: string[] = [];
  for (const role of OPERABLE) {
    for (const element of screen.queryAllByRole(role)) {
      const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim();
      if (name === '') unnamed.push(`${role}: ${element.outerHTML.slice(0, 160)}`);
    }
  }
  return unnamed;
}

describe('every workspace', () => {
  it.each(VIEW_IDS)('names every control it renders — %s', async (view: ViewId) => {
    useNavigationStore.setState({ activeView: view, engineeringMode: true });
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <AppShell />
      </TooltipProvider>,
    );

    for (const group of screen.queryAllByRole('button', { expanded: false })) {
      await user.click(group);
    }

    expect(unnamedControls()).toEqual([]);
  });

  it('names every control in the flight-representative view too', async () => {
    useNavigationStore.setState({ activeView: 'mission-control', engineeringMode: false });
    const user = userEvent.setup();
    render(
      <TooltipProvider>
        <AppShell />
      </TooltipProvider>,
    );

    for (const group of screen.queryAllByRole('button', { expanded: false })) {
      await user.click(group);
    }

    expect(unnamedControls()).toEqual([]);
  });
});

describe('the shell landmarks', () => {
  it('gives a screen reader something to navigate by', () => {
    useNavigationStore.setState({ activeView: 'mission-control' });
    render(
      <TooltipProvider>
        <AppShell />
      </TooltipProvider>,
    );

    expect(screen.getByRole('navigation', { name: 'Primary' })).toBeInTheDocument();
    expect(screen.getByRole('main')).toBeInTheDocument();
    expect(screen.getByRole('contentinfo')).toBeInTheDocument();
    // The workspace name is the document's heading; panels nest beneath it.
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(/mission control/i);
    expect(screen.getAllByRole('heading', { level: 2 }).length).toBeGreaterThan(3);
  });
});
