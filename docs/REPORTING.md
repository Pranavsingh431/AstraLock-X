# Reporting

What a completed run's `report.html` contains, how it is produced, and what the
Reports screen shows. Metric definitions are in [METRICS.md](METRICS.md); the
artifacts it reads are in [EXPERIMENTS.md](EXPERIMENTS.md).

## Generated from the artifacts, not the interface

`renderStoredReport(storage, runId, summary)` (`src/core/experiments/report.ts`)
reads the run directory: `manifest.json`, `scenario.json`, `algorithm.json`, and
streams `events.jsonl`, `telemetry.csv` and `evaluation.csv`. The summary it is
given is the one just computed from those same files. Nothing comes from React
state or the live engine, so the same directory produces the same report on a
machine that never ran the simulation.

It is written during finalisation, before the manifest's final atomic flip to
`completed` — so it is rendered with the status it is being finalised as. (A
first version read the manifest at that moment and printed "INCOMPLETE" on every
report; the smoke run caught it.) Aborted, failed and incomplete runs get no
report.

## Offline by construction

One HTML file with an inline stylesheet and inline SVG. No script, no `<link>`,
no web font, no image, no URL of any kind; `compliance.test.ts` checks for
`http://`, `https://`, `<script`, `<link`, `@import`, `url(`, `<img` and `src=`.
It opens from disk in any browser with the network off. System fonts only. About
80–100 KB for a 30–40 s run and under 400 KB for two minutes (asserted), because
plots are reduced while streaming.

Units are never case-transformed: an uppercased µ is a Greek capital Mu, and
"µrad" rendered as "ΜRAD" reads as milliradians. An early chart caption did
exactly that.

## Contents

| Section                    | What it shows                                                                                                                                                                                                              |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Header                     | Run id, status, termination reason, and a note that this is a validation record in a noiseless simulation, not a benchmark claim                                                                                           |
| Performance log            | The seven categories the brief names, each with its value, one-sentence definition and summary field path                                                                                                                  |
| Provenance                 | Application version, commit (or "unavailable"), uncommitted-changes flag, wall-clock times, host platform, scenario and seed, designated target, algorithm and version, all three fingerprints, metric and schema versions |
| Physical configuration     | Tick rate, camera resolution/FOV/fps/principal point, gimbal travel, rate limits and latency, targets and trajectory kinds, platform disturbance, and "Not modelled" for sensor noise and atmosphere                       |
| Algorithm configuration    | Every key of `algorithm.json`, flattened                                                                                                                                                                                   |
| Outcome and acquisition    | Termination, outcome, T_SEARCH_START, T_FIRST_DETECTION, T_TRACK_ENTRY, T_COARSE_LOCK, and the derived intervals                                                                                                           |
| Tracking accuracy          | Angular and image-space error over whole run / post-acquisition / TRACK state, and the detector diagnostic, each with n, mean, RMS, median, P95, max; a callout explaining the windows                                     |
| Plots                      | See below                                                                                                                                                                                                                  |
| Lock retention             | Rate and status, numerator, denominator, TRACK claimed without lock                                                                                                                                                        |
| Loss and reacquisition     | Counts, a table of every episode with unrecovered ones marked censored, reacquisition-time statistics                                                                                                                      |
| False lock                 | Whether the challenge was exercised — in words when it was not — episodes, duration, rate                                                                                                                                  |
| Frame statistics           | Configured, effective and processed FPS with their counts and window; display FPS "Not measured"; commands issued, applied and in flight                                                                                   |
| Host processing time       | Per-stage statistics under a callout that these are host wall-clock diagnostics and **not** simulated latency                                                                                                              |
| Simulation control latency | Capture → issue, issue → application, capture → application, scheduled → actual, with the zero-compute-time note                                                                                                           |
| Unavailable values         | Every summary measurement without a value, by field path and status                                                                                                                                                        |
| Event log                  | The first 150 non-command events with detail; the rest, and every command event, are in `events.jsonl`                                                                                                                     |
| Footer                     | The metric definitions used, with this run's thresholds substituted                                                                                                                                                        |

Numbers are formatted for people — radians as µrad with the raw value beside
them, fractions as percentages — while `summary.json` keeps full precision.

## Plots

All drawn as inline SVG paths from the recorded samples. Every series is reduced
to the minimum and maximum of each of 500 equal time buckets across the recorded
window, in time order, so a one-frame spike survives at any run length; plain
every-nth decimation would silently drop it.

| Plot                                            | Source           | Notes                                                            |
| ----------------------------------------------- | ---------------- | ---------------------------------------------------------------- |
| Angular pointing error vs simulation time       | `evaluation.csv` | Log scale, µrad, dashed line at the lock threshold               |
| Image-space pointing error vs simulation time   | `evaluation.csv` | Only while the target is in the image                            |
| PAT state and evaluator lock                    | both             | Banded timelines: SCAN / TRACK / LOST, and LOCKED / NOT LOCKED   |
| Pan: commanded vs measured                      | `telemetry.csv`  | Degrees; measured is the encoder reading the algorithm was given |
| Tilt: commanded vs measured                     | `telemetry.csv`  | As above                                                         |
| Detected centroid distance from principal point | `telemetry.csv`  | What the tracker itself could see of its error                   |
| Detector centroid error vs truth                | `evaluation.csv` | Detector diagnostic, not pointing accuracy                       |

Each caption says whether the data is safe telemetry or ground truth. A plot with
fewer than two points says "No samples to plot" rather than drawing an empty
frame.

## The Reports screen

`src/features/reports/ReportsView.tsx`. Every number on it is read from files
through `listRuns` and `readStoredSummary`.

**List.** Every run directory, newest first, with the runs root shown above it.
Each row: run id, status badge, scenario, algorithm, created time, simulated
duration, and — for completed runs only — acquisition time (or the outcome),
lock retention, and post-acquisition mean / P95 angular error. Anything else
shows "no result". A directory whose manifest does not parse is listed as
**Unreadable** with the error, not skipped.

**Statuses.** `COMPLETED`, `ABORTED`, `FAILED`, and `INCOMPLETE` for a manifest
still reading `running` or `created`. Non-completed runs carry a note saying why
they are not results.

**Details.** Provenance (including folder path, fingerprints, metric definition,
build and uncommitted-changes flag, simulated window, termination) and, for a
completed run: performance log, milestones, accuracy tables, lock, loss and
false-lock figures, host processing and control latency.

**Actions.**

| Action             | Behaviour                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------ |
| Open report        | Opens `report.html` from disk in the default browser (desktop only; completed runs only)               |
| Open folder        | Opens the run directory in the platform file manager (desktop only)                                    |
| Recompute & verify | `recomputeSummary`: rebuilds from raw files, compares every field, reports a match or names mismatches |
| Delete             | Asks for confirmation, then removes the directory; works for incomplete runs too                       |
| Refresh            | Re-reads the archive                                                                                   |

**Nothing is editable.** There is no field to type an acquisition time, error,
retention or processing time, and no way to alter a stored summary. A test checks
for the absence of text and number inputs. A different metric definition produces
a new, separately fingerprinted result through `summariseStoredRun`; it never
rewrites `summary.json`.

In a plain browser tab (`pnpm dev` without Tauri) the screen says recording needs
the desktop application and lists nothing, rather than pretending to store runs
in `localStorage`.

## Mission Control

`src/features/mission-control/components/ExperimentControls.tsx`.

- **Record**, **Stop & finalise**, **Abort** (asks first).
- Status badge: recording / finalising / completed / aborted / failed.
- Run id, recorded simulated time, events recorded, frames recorded, bytes the
  storage confirmed written, writer state with bytes queued (and backpressure
  when it applies), and the run's folder. Every counter is read from the
  recorder; none is estimated.
- Errors are shown, and say the experiment was not saved as a result.
- Reset, changing or importing a scenario, and switching autonomy off all ask
  before ending a recording. The emergency stop never asks.

**Evaluation — ground truth.** A separately bordered panel, labelled as ground
truth, showing pointing error, image error, the instantaneous lock condition,
confirmed coarse lock, retention so far and frames. While recording, it comes
from the recorder's own evaluation samples with the dwell and grace applied;
otherwise it is instantaneous, and confirmed lock, retention and frames read
"N/A". **Hide** removes it and stops computing it; the tracker is unaffected, and
a test shows it acquiring and holding with the panel hidden.

The autonomy panel shows the current detection's SNR as **Not modelled**.
