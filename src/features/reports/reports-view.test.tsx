/**
 * The Reports screen, against runs recorded by the real recorder.
 *
 * The property under test throughout: a run that did not finish must never be
 * presented as a result. Everything else on the screen is a convenience; that
 * one is the difference between an archive and a pile of files.
 */

import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemoryStorage, RUN_FILES, performanceLog, readStoredSummary } from '@/core/experiments';
import { buildRig, drive } from '@/core/experiments/rig.node';
import { formatMeasurement } from '@/core/contracts/measurement';

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const storage = new MemoryStorage();

vi.mock('@/core/experiments/tauri-storage', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, createStorage: () => storage };
});

const { ReportsView } = await import('./ReportsView');

/** Snapshot of a recorded archive, restored before each test. */
let archive: Map<string, Map<string, string>>;
const runsOf = (s: MemoryStorage) =>
  (s as unknown as { runs: Map<string, Map<string, string>> }).runs;

beforeAll(async () => {
  const completed = buildRig({
    scenario: 'pat-stationary-outside-fov',
    storage,
    runId: 'run-20260101T000003Z-completed',
  });
  await completed.recorder!.start({ autonomyActive: true });
  drive(completed, 20);
  await completed.recorder!.complete();

  const aborted = buildRig({
    scenario: 'pat-moving-target',
    storage,
    runId: 'run-20260101T000002Z-aborted',
  });
  await aborted.recorder!.start({ autonomyActive: true });
  drive(aborted, 2);
  await aborted.recorder!.abort();

  const interrupted = buildRig({
    scenario: 'pat-loss',
    storage,
    runId: 'run-20260101T000001Z-interrupted',
  });
  await interrupted.recorder!.start({ autonomyActive: true });
  drive(interrupted, 2);
  await interrupted.recorder!.drain();

  const failed = buildRig({ scenario: 'pat-loss', storage, runId: 'run-20260101T000000Z-failed' });
  await failed.recorder!.start({ autonomyActive: true });
  drive(failed, 1);
  await failed.recorder!.fail('detector exploded');

  archive = new Map([...runsOf(storage)].map(([id, files]) => [id, new Map(files)]));
});

beforeEach(() => {
  vi.restoreAllMocks();
  const runs = runsOf(storage);
  runs.clear();
  for (const [id, files] of archive) runs.set(id, new Map(files));
});

const renderView = async () => {
  render(<ReportsView />);
  await screen.findByRole('button', { name: /Open run run-20260101T000003Z-completed/ });
};

const row = (runId: string) => screen.getByRole('button', { name: `Open run ${runId}` });

describe('listing runs', () => {
  it('says so when nothing is recorded', async () => {
    runsOf(storage).clear();
    render(<ReportsView />);
    expect(await screen.findByText(/No runs recorded yet/i)).toBeInTheDocument();
  });

  it('shows a completed run with its scenario, algorithm, time, status, duration and headline results', async () => {
    await renderView();
    const completed = row('run-20260101T000003Z-completed');
    const summary = await readStoredSummary(storage, 'run-20260101T000003Z-completed');

    expect(within(completed).getByText('completed')).toBeInTheDocument();
    expect(within(completed).getByText('pat-stationary-outside-fov')).toBeInTheDocument();
    expect(within(completed).getByText('baseline-kf-pid')).toBeInTheDocument();
    expect(within(completed).getByText('2026-01-01 00:00:00')).toBeInTheDocument();
    expect(within(completed).getByText('duration 20.0 s')).toBeInTheDocument();
    expect(completed).toHaveTextContent(
      `acq ${formatMeasurement(summary.coarseAcquisitionTime, 2)}`,
    );
    expect(completed).toHaveTextContent(
      `retention ${(summary.lockRetentionRate.value! * 100).toFixed(1)} %`,
    );
    expect(completed).toHaveTextContent(
      `err ${(summary.angularPointingError.postAcquisition.mean.value! * 1e6).toFixed(0)} µrad / P95`,
    );
  });

  it('shows an interrupted run as INCOMPLETE, with no result', async () => {
    await renderView();
    const interrupted = row('run-20260101T000001Z-interrupted');
    expect(within(interrupted).getByText('incomplete')).toBeInTheDocument();
    expect(within(interrupted).queryByText('completed')).not.toBeInTheDocument();
    expect(interrupted).toHaveTextContent('no result');
  });

  it('shows aborted and failed runs as such, with no result', async () => {
    await renderView();
    expect(within(row('run-20260101T000002Z-aborted')).getByText('aborted')).toBeInTheDocument();
    expect(row('run-20260101T000002Z-aborted')).toHaveTextContent('no result');
    expect(within(row('run-20260101T000000Z-failed')).getByText('failed')).toBeInTheDocument();
  });

  it('lists a run whose files cannot be read as unreadable, rather than skipping it', async () => {
    await storage.createRun('run-broken');
    await storage.writeAtomic('run-broken', RUN_FILES.manifest, '{ not json');
    await renderView();
    expect(row('run-broken')).toHaveTextContent(/Unreadable/);
  });
});

describe('inspecting a run', () => {
  it('shows provenance and the performance log of a completed run, from its files', async () => {
    const user = userEvent.setup();
    await renderView();
    await user.click(row('run-20260101T000003Z-completed'));

    const summary = await readStoredSummary(storage, 'run-20260101T000003Z-completed');
    expect(screen.getByText('Performance log')).toBeInTheDocument();
    for (const entry of performanceLog(summary)) {
      expect(screen.getAllByText(entry.label).length).toBeGreaterThan(0);
    }
    expect(screen.getByText(/commit unavailable/i)).toBeInTheDocument();
    expect(
      screen.getByText('Not exercised — no competing emitter was ever in view'),
    ).toBeInTheDocument();
    expect(screen.getByText(/wall clock, not simulated/i)).toBeInTheDocument();
  });

  it('explains why an incomplete run has no results, and offers no report or verification', async () => {
    const user = userEvent.setup();
    await renderView();
    await user.click(row('run-20260101T000001Z-interrupted'));

    expect(screen.getByRole('note')).toHaveTextContent(/INCOMPLETE.*not a valid result/);
    expect(screen.queryByText('Performance log')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open report' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Recompute and verify summary' })).toBeDisabled();
  });

  it('cannot open files from a browser tab, and says why', async () => {
    const user = userEvent.setup();
    await renderView();
    await user.click(row('run-20260101T000003Z-completed'));
    const open = screen.getByRole('button', { name: 'Open report' });
    expect(open).toBeDisabled();
    expect(open).toHaveAttribute('title', expect.stringMatching(/desktop application/));
  });
});

describe('verifying a summary', () => {
  it('recomputes from the raw files and reports a match', async () => {
    const user = userEvent.setup();
    await renderView();
    await user.click(row('run-20260101T000003Z-completed'));
    await user.click(screen.getByRole('button', { name: 'Recompute and verify summary' }));
    expect(await screen.findByRole('status')).toHaveTextContent(/^Verified: recomputing from/);
  });

  it('reports a mismatch when the stored summary has been edited', async () => {
    const summary = JSON.parse(
      await storage.readFile('run-20260101T000003Z-completed', RUN_FILES.summary),
    );
    summary.lockRetentionRate.value = 0.123;
    await storage.writeAtomic(
      'run-20260101T000003Z-completed',
      RUN_FILES.summary,
      JSON.stringify(summary),
    );

    const user = userEvent.setup();
    await renderView();
    await user.click(row('run-20260101T000003Z-completed'));
    await user.click(screen.getByRole('button', { name: 'Recompute and verify summary' }));
    expect(await screen.findByRole('status')).toHaveTextContent(
      /Mismatch in 1 field\(s\): lockRetentionRate.value \(stored 0.123/,
    );
  });
});

describe('what the operator can and cannot do', () => {
  it('offers no way to edit a measured value', async () => {
    const user = userEvent.setup();
    await renderView();
    await user.click(row('run-20260101T000003Z-completed'));
    expect(screen.queryAllByRole('textbox')).toEqual([]);
    expect(screen.queryAllByRole('spinbutton')).toEqual([]);
  });

  it('asks before deleting, and keeps the run if told no', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    const user = userEvent.setup();
    await renderView();
    await user.click(row('run-20260101T000002Z-aborted'));
    await user.click(screen.getByRole('button', { name: 'Delete run' }));

    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('run-20260101T000002Z-aborted'));
    expect(await storage.listRuns()).toContain('run-20260101T000002Z-aborted');
  });

  it('deletes when confirmed, including an incomplete run', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    const user = userEvent.setup();
    await renderView();
    await user.click(row('run-20260101T000001Z-interrupted'));
    await user.click(screen.getByRole('button', { name: 'Delete run' }));

    await waitFor(() => {
      expect(
        screen.queryByRole('button', { name: 'Open run run-20260101T000001Z-interrupted' }),
      ).not.toBeInTheDocument();
    });
    expect(await storage.listRuns()).not.toContain('run-20260101T000001Z-interrupted');
  });
});
