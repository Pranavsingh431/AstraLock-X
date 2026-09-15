/**
 * The AstraBench workspace, as an operator meets it.
 *
 * The things worth testing in an interface like this are the ones that would
 * otherwise become decorative: that the run count is arithmetic rather than a
 * label, that the suites offered are the real ones, and that the screen refuses
 * to invent results before there are any.
 */

import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { BENCHMARK_SUITES, totalRuns } from '@/core/benchmark';
import { TooltipProvider } from '@/components/ui/tooltip';

import { AstraBenchView } from './AstraBenchView';

vi.setConfig({ testTimeout: 120_000 });

const renderView = (): void => {
  render(
    <TooltipProvider>
      <AstraBenchView />
    </TooltipProvider>,
  );
};

describe('the AstraBench workspace', () => {
  it('offers the bundled suites and nothing invented', () => {
    renderView();
    const selector = screen.getByRole('combobox', { name: 'Benchmark suite' });
    const offered = [...selector.querySelectorAll('option')].map((option) => option.value);
    expect(offered).toEqual(BENCHMARK_SUITES.map((suite) => suite.suiteId));
  });

  it('states how many runs the selected suite will execute, before running it', () => {
    renderView();
    const quick = BENCHMARK_SUITES[0]!;
    expect(screen.getByText('Total runs')).toBeInTheDocument();
    expect(screen.getByText(String(totalRuns(quick)))).toBeInTheDocument();
    // And the arithmetic is shown rather than asserted.
    expect(screen.getByText('cases × seeds × arms')).toBeInTheDocument();
  });

  it('recalculates the run count when the suite changes', async () => {
    const user = userEvent.setup();
    renderView();
    const engineering = BENCHMARK_SUITES.find(
      (suite) => suite.suiteId === 'engineering-comparison',
    )!;

    await user.selectOptions(
      screen.getByRole('combobox', { name: 'Benchmark suite' }),
      'engineering-comparison',
    );
    expect(screen.getByText(String(totalRuns(engineering)))).toBeInTheDocument();
    expect(totalRuns(engineering)).toBeGreaterThan(totalRuns(BENCHMARK_SUITES[0]!));
  });

  it('shows the declared seeds rather than a count', () => {
    // Which seeds were used is part of a result. A benchmark that showed "5
    // seeds" without saying which could not be repeated.
    renderView();
    expect(screen.getByText('Declared in source, before any result')).toBeInTheDocument();
  });

  it('shows no results and no progress before anything has run', () => {
    renderView();
    expect(screen.queryByLabelText('Benchmark progress')).not.toBeInTheDocument();
    expect(screen.getByText(/No results yet/i)).toBeInTheDocument();
    // And says where results will come from, which is not from this component.
    expect(screen.getByText(/aggregate\.json/)).toBeInTheDocument();
  });

  it('cannot be cancelled when nothing is running', () => {
    renderView();
    expect(screen.getByRole('button', { name: /Cancel/i })).toBeDisabled();
  });

  it('says plainly that a browser tab cannot store run artifacts', () => {
    // The same honesty the experiment controls apply: refuse and explain,
    // rather than appear to work and lose the evidence.
    renderView();
    expect(screen.getByText(/need the desktop application/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Start benchmark/i })).toBeDisabled();
  });

  it('states the fairness rule on the screen, not only in the docs', () => {
    renderView();
    expect(screen.getByText(/identical physics/i)).toBeInTheDocument();
    expect(screen.getByText(/no overall score/i)).toBeInTheDocument();
  });
});
