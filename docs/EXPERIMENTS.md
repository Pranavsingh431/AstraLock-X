# Experiments

How a closed-loop run becomes a record that outlives the session it ran in.

Implementation: `src/core/experiments/`. Every metric formula is in
[METRICS.md](METRICS.md); the generated report and the Reports screen are in
[REPORTING.md](REPORTING.md). Decisions: [ADR-0014](adr/0014-evaluation-reads-truth-one-way.md)
(evaluation is one-way), [ADR-0015](adr/0015-persisted-raw-data-is-the-source-of-truth.md)
(summaries come from the files), [ADR-0016](adr/0016-host-time-is-not-simulated-time.md)
(host timing is not simulated latency).

## The recorder is an observer

```
   simulation + mount + camera + algorithm
                  │
                  ├──────────▶ the closed loop, unchanged
                  │
                  ├──── LoopObserver ────▶ ExperimentRecorder
                  │                          ├─▶ events.jsonl      (engineering events)
                  │                          ├─▶ telemetry.csv     (safe)
                  │                          └─▶ evaluation.csv    (privileged: Evaluator)
                  │
                  └── after finalisation, from the files ──▶ summary.json ──▶ report.html
```

`ClosedLoopRuntime` accepts one optional `LoopObserver`. It calls it **after**
each frame's work is done — the algorithm has produced its output and the
command has been submitted — and after each advance for any command the mount
applied. Nothing an observer does can reach the algorithm's input, the command
or its timing. The observer can be attached and detached mid-run with
`runtime.observe(recorder | null)` without rebuilding anything: the algorithm
instance, its filter and its state machine carry on untouched.

That is asserted, not assumed:

- `recorder.test.ts` runs `pat-stationary-outside-fov` (25 s) and `pat-loss`
  (15 s) with the recorder off and on and requires identical PAT transitions
  (with their instants), every command (id, issue time, azimuth, elevation, to
  17 significant digits), final measured mount pose, frame count and world state
  hash.
- The same comparison holds when the storage is so slow that backpressure
  repeatedly stops the simulation, and when the writer fails mid-run.
- `observer.test.ts` attaches an observer at 5 s and detaches it at 13 s, through
  acquisition, and requires the run to equal an unobserved one.
- In the application, starting and finalising a recording while the tracker is
  in TRACK leaves it in TRACK (`experiment-controls.test.tsx`). Before this
  phase's rework the store rebuilt the runtime to attach a recorder, which
  constructed a fresh algorithm and reset the tracker it was recording.

## Lifecycle

```
 created ──begin()──▶ running ──complete()──▶ completed
    │                   │ │
    │                   │ └──abort()─────────▶ aborted
    │                   └────fail() / writer──▶ failed
    └── process dies ── manifest still reads `created` or `running` ──▶ INCOMPLETE
```

| Operation                 | What it does                                                                                                                                                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `prepare()`               | Creates the run directory; writes `scenario.json`, `algorithm.json`, a `created` manifest and the CSV headers. Asynchronous.                                                                                                                                        |
| `begin({autonomyActive})` | Synchronous. Sets the start instant to the engine's current time, marks `running`, queues the `running` manifest ahead of any sample, and records `experiment-started` (and `autonomy-enabled` if a tracker is already flying).                                     |
| observe                   | Rows and events are serialised into bounded batches and queued for writing.                                                                                                                                                                                         |
| `complete(reason)`        | Records `experiment-completed`, flushes and drains, writes the manifest with end time, end-state hash and frame count, **computes the summary from the files**, writes `summary.json` and `report.html`, then — last, atomically — writes the `completed` manifest. |
| `abort(reason)`           | Records `experiment-aborted`, flushes, writes the `aborted` manifest. No summary and no report are written: a `summary.json` in an aborted run's folder would read as a finding to anyone who opened the folder.                                                    |
| `fail(message)`           | Records `experiment-failed`, flushes what it can, writes a `failed` manifest if storage still allows.                                                                                                                                                               |

`prepare` and `begin` are separate on purpose. Storage is asynchronous and the
simulation may keep advancing meanwhile; the run's start instant must be the
instant the observer is attached. The store calls `begin` and `runtime.observe`
in one synchronous block, so no frame can fall between them.

### What ends a recording, and how

| Situation                    | Outcome                                                    | Termination reason          | Asked first? |
| ---------------------------- | ---------------------------------------------------------- | --------------------------- | ------------ |
| Operator: Stop & finalise    | `completed`                                                | `operator-finalised`        | —            |
| Operator: Abort              | `aborted`                                                  | `operator-aborted`          | yes          |
| Autonomy switched off        | `completed` — the measurement window ends here             | `autonomy-disabled`         | yes          |
| Emergency stop               | `completed`, as above                                      | `autonomy-disabled`         | **never**    |
| Scenario duration reached    | `simulation-completed` event, then `completed`             | `scenario-duration-reached` | —            |
| Reset                        | `aborted` — a reset would splice two runs into one log     | `simulation-reset`          | yes          |
| Scenario changed or imported | `aborted`                                                  | `scenario-changed`          | yes          |
| Closed-loop runtime throws   | loop paused, error shown, recording `failed`               | `runtime-error`             | —            |
| A write fails                | recording `failed` at once; loop continues untouched       | `writer-error`              | —            |
| Application closed or killed | manifest remains `created`/`running`: listed as INCOMPLETE | none                        | —            |

Recording is intended to start **before** autonomy is enabled, so that search
and acquisition are part of the record. The panel says so. If recording starts
while a tracker is already flying, the recorder notes `autonomy-enabled` at the
start instant and records the state it finds; it does not invent a
`search-started` or `track-entered` for a transition it did not see, so
acquisition time is then `not-measured` with outcome `no-search-recorded`.

Pausing and resuming are recorded as `simulation-paused` and
`simulation-started` events. Manual override during autonomy is recorded as
`operator-override`, because an operator flying the mount changes what the run
measures.

A recorder that fails surfaces immediately through `onFailure`, not on the next
simulation step, because the run may be paused. The closed loop is never
touched: a test requires the engineering result of a run whose writer failed
after 1 s to equal a run with no recorder at all.

## Artifacts

```
<app data>/runs/<run-id>/
  manifest.json     provenance, status, fingerprints, metrics definition   (provenance)
  scenario.json     the exact SimulationConfig snapshot                     (configuration)
  algorithm.json    the exact algorithm configuration snapshot              (configuration)
  events.jsonl      ordered engineering events                              (event-log)
  telemetry.csv     one safe row per processed frame                        (safe-telemetry)
  evaluation.csv    one ground-truth row per processed frame                (privileged-evaluation)
  summary.json      metrics derived from the three files above             (derived-summary)   completed runs only
  report.html       offline human-readable report                          (derived-report)    completed runs only
```

The classification in parentheses is written into `manifest.artifacts`, so it
travels with the data. No camera frames are stored. A test requires a completed
directory to contain exactly these eight files and no leftover `.tmp`.

### Manifest

`experimentManifestSchema` in `schema.ts`. Everything needed to know what was
run and to run it again:

| Field                                                               | Meaning                                                                                 |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `schemaVersion`, `metricsDefinitionVersion`                         | File-format version (1) and metric-definition version (1)                               |
| `runId`, `status`, `terminationReason`                              | Identity of the recording, where it got to, why it stopped                              |
| `scenarioId`, `scenarioName`, `scenarioSeed`                        | Which scenario                                                                          |
| `algorithmId`, `algorithmVersion`                                   | Which tracker implementation                                                            |
| `scenarioFingerprint`, `algorithmFingerprint`, `metricsFingerprint` | Identity of the experiment (below)                                                      |
| `metricsConfig`                                                     | The full metric definition the run is scored under                                      |
| `designatedTargetIndex`, `designatedTargetLabel`, `targetCount`     | Which target is scored                                                                  |
| `simulationTimestepSeconds`, `tickRate`                             | Physics step                                                                            |
| `camera`                                                            | Resolution, frame rate, horizontal FOV, principal point                                 |
| `gimbal`                                                            | Command latency, travel limits, rate limits                                             |
| `startSimulationTime`, `endSimulationTime`                          | The recorded window, simulated seconds                                                  |
| `endStateHash`                                                      | The engine's state hash at the end instant, for reproduction checks                     |
| `sensorFramesGenerated`                                             | Raw counter: frames generated with capture time in [start, end)                         |
| `host.createdAt`, `host.endedAt`                                    | Wall clock. `createdAt` is set once and never rewritten                                 |
| `host.platform`, `host.applicationVersion`                          | Where and with what build                                                               |
| `host.sourceCommit`, `host.sourceTreeModified`                      | Git commit of the build, or `null`; whether the tree had uncommitted changes, or `null` |

`sourceCommit` is `null` when git could not tell — never "main" or "latest". A
build from a modified working tree records `sourceTreeModified: true`, and the
report and Reports screen say "uncommitted changes": such a build is not the
commit it names.

### Run identity and fingerprints

A **run id** identifies a recording: `run-<UTC timestamp>-<counter>`, sortable
and collision-free within a process. It is not deterministic and does not need
to be.

The **experiment** is identified by three fingerprints: SHA-256 over canonical
JSON of the scenario snapshot, the algorithm configuration and the metrics
configuration. Canonical means object keys sorted at every depth, `undefined`
omitted, numbers written as `toExponential(17)` and `-0` written as `0`. SHA-256
is implemented in `fingerprint.ts` so it is synchronous and identical in Node,
the browser and Tauri; it is tested against the FIPS 180-2 vectors and against
Node's `crypto`. Wall-clock and host values never enter a fingerprint. Two
recordings of the same experiment have identical fingerprints and different run
ids.

`recomputeSummary` re-fingerprints `scenario.json`, `algorithm.json` and the
manifest's metrics configuration and refuses to proceed if any differ, so a
snapshot edited after the fact is caught.

### Event log

`events.jsonl`, one JSON object per line: `sequence`, `simulationTime`, `tick`,
`type`, `detail`.

- **Order.** Written in sequence order; `sequence` starts at 0 and increases by
  one; `simulationTime` is non-decreasing. Events legitimately share a timestamp
  (a frame can produce a detection, a state change and a command at one
  instant), so `sequence` is the tie-break. The recorder refuses an
  out-of-order timestamp, and `summariseStoredRun` rejects a log that is out of
  order.
- **Time.** `simulationTime` is the engineering instant the event describes: a
  frame's processing (issue) time for frame-derived events, `issuedAt` for
  `command-issued`, the mount's actual `appliedAt` for `command-applied`. `tick`
  is the engine tick at which the recorder learned of it.
- **Changes, not samples.** `candidate-detected` fires when a candidate appears
  after a frame without one; `detection-missed` when a miss streak begins in
  TRACK; `mechanical-limit` when an axis reaches its travel stop. On a 30 s loss
  run the log holds fewer than 40 state events against 1,800 frames. The two
  per-command events are genuinely one per command and are what the simulated
  control-latency figures are computed from.
- **No privileged payloads.** `detail` is a flat record of scalars; a test checks
  that no key in any event mentions truth, target, range, line of sight or
  pointing error.
- `lock-lost` is the **algorithm's** declaration (TRACK → LOST). The evaluator's
  view of lock is not an event; it is derived from `evaluation.csv` so it can be
  rescored under a different definition.

Vocabulary: `experiment-started`, `simulation-started`, `simulation-paused`,
`autonomy-enabled`, `operator-override`, `search-started`,
`candidate-detected`, `track-entered`, `detection-missed`, `lock-lost`,
`lost-entered`, `search-reentered`, `command-issued`, `command-applied`,
`mechanical-limit`, `autonomy-disabled`, `simulation-completed`,
`experiment-completed`, `experiment-aborted`, `experiment-failed`.

### Safe telemetry

`telemetry.csv`, one row per processed frame. Everything is derivable from
pixels, the believed calibration, the measured mount state, the algorithm's own
output and the host clock.

| Columns                                                                                    | Meaning                                                                          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- |
| `frame_id`, `frame_capture_time_s`, `command_issue_time_s`, `tick`                         | Which frame, when it was captured, when it was processed and its command stamped |
| `pat_state`, `candidate_count`, `components_found`, `consecutive_misses`                   | Algorithm state and detector bookkeeping                                         |
| `centroid_x_px`, `centroid_y_px`, `candidate_score`                                        | Selected detection, continuous image coordinates                                 |
| `filtered_azimuth_rad`, `filtered_elevation_rad`, `filtered_*_rate_rad_s`                  | The algorithm's estimate (from `TrackingOutput.estimates`)                       |
| `pid_pan_correction_rad`, `pid_tilt_correction_rad`                                        | Controller output; empty outside TRACK                                           |
| `command_id`, `commanded_pan_rad`, `commanded_tilt_rad`                                    | The command the runtime issued for this frame, or empty for a hold               |
| `measured_pan_rad`, `measured_tilt_rad`, `measured_*_rate_rad_s`, `*_saturation`           | The encoder state the algorithm was given                                        |
| `search_waypoint_index`                                                                    | Scan position while searching                                                    |
| `host_world_step_ms`, `host_sensor_frame_ms`, `host_algorithm_ms`, `host_orchestration_ms` | Host wall-clock time per frame (ADR-0016)                                        |
| `host_detector_ms`, `host_bearing_transform_ms`, `host_estimator_ms`, `host_controller_ms` | Per-stage host time; **empty** when the stage did not run on that frame          |

### Privileged evaluation

`evaluation.csv`, one row per processed frame, evaluated at the frame's capture
instant using the **true** optical pose. Every truth-derived column is prefixed
`truth_`, so the file declares itself in any tool; a test enforces the prefix.
It records derived truth — optical axis, line of sight, pointing error, range,
projection, visibility — not the world state.

| Columns                                                             | Meaning                                                      |
| ------------------------------------------------------------------- | ------------------------------------------------------------ |
| `frame_id`, `capture_time_s`, `pat_state`, `detection_present`      | Safe, copied so the file reads alone                         |
| `truth_optical_axis_{east,north,up}`                                | True optical axis, world ENU unit vector                     |
| `truth_target_los_{east,north,up}`                                  | True line of sight to the designated target, unit vector     |
| `truth_angular_pointing_error_rad`                                  | Angle between the two                                        |
| `truth_target_range_m`, `truth_target_within_travel`                | Range, and whether the bearing lies inside both axes' travel |
| `truth_target_in_image`, `truth_image_{x,y}_px`                     | Whether and where the target projects                        |
| `truth_image_pointing_error_px`                                     | True projected centre to principal point                     |
| `truth_detector_centroid_error_px`                                  | Detected centroid to true projected centre                   |
| `truth_detection_on_other_emitter`, `truth_other_emitters_in_image` | False-lock evidence                                          |

**No metric threshold appears in a raw file.** The lock threshold, dwell, grace,
association radius and trackable range are applied when the summary is
computed. A run can therefore be rescored under a different, explicitly
identified definition (`summariseStoredRun(storage, runId, { metricsConfig })`)
without rerunning it and without touching what was recorded; the result carries
the other definition's fingerprint.

### Precision and units

Non-integers are written as `toExponential(16)` — 17 significant digits, the
shortest form that round-trips every IEEE double. Integers are written plainly;
`-0` as `-0`. A test round-trips 2,000+ values including subnormals and the
extremes, bit for bit. Non-finite values are refused rather than written. Text
cells that would need CSV quoting are refused rather than escaped. Units are in
column names (`_s`, `_m`, `_px`, `_rad`, `_rad_s`, `_ms`); the JSON artifacts use
`Measurement` objects that carry a `unit`. Each column's kind is read from the
zod schema, and a file whose header does not exactly match is rejected rather
than read positionally.

## Memory and backpressure

The recorder retains no per-sample collection. Rows are serialised as they
arrive into batches of `BATCH_ROWS` (120) and queued onto a serial write chain.
What it keeps is scalar change-detection state and a streaming `LockAnalyser`
for the live readout. The long-run test inspects the recorder after two minutes
(7,201 frames) and requires every array it holds to be at most one batch long.

Writes are asynchronous, so a slow disk could let the queue grow. When queued,
unwritten bytes exceed `BACKPRESSURE_BYTES` (2 MiB) the recorder reports
`backpressured`; the application driver then **does not advance the simulation
that animation frame and does not bank the wall-clock time**. The run slows in
wall-clock terms and is otherwise identical; no mandatory sample is dropped. The
queue is therefore bounded by the mark plus one batch. Headless harnesses use
`driveRespectingBackpressure` in `rig.node.ts`, which does the same.

Finalisation streams the files back, so its memory is not bounded by a constant:
percentiles need every value, and the KPI engine keeps each statistic's samples
as 8-byte doubles in a typed array — about 15 series, roughly 120 bytes per
processed frame, or ~26 MB for an hour at 60 fps. No row objects are held.
Report plots are reduced to 500 min/max buckets per series while streaming.

Measured, headless, on the development machine (Apple Silicon), moving-target
scenario:

| Quantity                                          | Result                                         |
| ------------------------------------------------- | ---------------------------------------------- |
| Raw record                                        | 1,250 bytes per frame; 9.0 MB for 120 s        |
| Peak write queue, 120 s run                       | 2.22 MB (mark + one batch)                     |
| Storage growth, second minute ÷ first             | within 0.8–1.25 (asserted)                     |
| Closed loop, recorder off / on (median of 3)      | 1,822 ms / 1,878 ms for 30 simulated s: +3.1 % |
| Writer alone, recorder-sized batch appends        | ~240 MB/s                                      |
| Finalisation: summary + report streamed from disk | 117–133 ms for 30 s                            |

These are wall-clock measurements of one machine and are printed by
`experiments/performance.test.ts`, which runs in the separate performance pass.

## Storage

The experiment core does not know what a file is. It uses `ExperimentStorage`:
`createRun`, `writeAtomic`, `append`, `readFile`, `readLines` (streaming),
`fileSize`, `listRuns`, `deleteRun`, `runPath`.

| Implementation       | Where                  | Used by                                                    |
| -------------------- | ---------------------- | ---------------------------------------------------------- |
| `MemoryStorage`      | `storage.ts`           | Unit and UI tests                                          |
| `NodeFileStorage`    | `node-storage.node.ts` | Headless runs and filesystem tests; never bundled          |
| `TauriStorage`       | `tauri-storage.ts`     | The desktop application                                    |
| `UnavailableStorage` | `tauri-storage.ts`     | A plain browser tab: recording is refused, and it says why |

**Location.** Tauri's `app_data_dir()` for the identifier `dev.astralock.x`,
plus `runs/`:

| Platform | Directory                                                         |
| -------- | ----------------------------------------------------------------- |
| Windows  | `%APPDATA%\dev.astralock.x\runs\`                                 |
| macOS    | `~/Library/Application Support/dev.astralock.x/runs/`             |
| Linux    | `$XDG_DATA_HOME/dev.astralock.x/runs/` (usually `~/.local/share`) |

No administrator permission is needed and nothing is hardcoded. The Reports
screen shows the directory, and each run's folder.

**The host surface is narrow.** `src-tauri/src/experiments.rs` exposes a handful
of commands instead of enabling a filesystem plugin. A run id must be
`[A-Za-z0-9_-]{1,128}`; a file name must be one of the eight artifact names; the
resolved directory must sit inside the run root. There is no export-to-arbitrary-
path feature, so there is no user path to sanitise. "Open folder" and "Open
report" hand a validated path to the platform's default handler (`open`,
`explorer`, `xdg-open`). Large files are streamed with `experiment_read_chunk`,
which returns raw bytes so a chunk boundary inside a multi-byte character is
harmless.

**Atomic writes.** `manifest.json`, `summary.json`, `report.html` and the two
snapshots are written to `<name>.tmp`, flushed to disk (`sync_all` / `fsync`) and
renamed over the target. `rename` replaces atomically on all three platforms.

## Interrupted runs

A run's manifest reaches `completed` only as the last step of finalisation, after
the summary and report are on disk. Until then it reads `created` or `running`.
On the next start the Reports screen lists such a run as **INCOMPLETE**, explains
that it is not a valid result, offers inspection and deletion, and offers no
report and no verification. `listRuns` never reads a summary for a run that is
not `completed`, and `completedResults` — the only way to get runs that count as
results — excludes it.

Tested two ways: a run whose process simply stops mid-recording, and a run that
dies after writing `summary.json` but before the final manifest. The second
still lists as incomplete with no summary, even though a summary file exists.

## Recomputation

See [ADR-0015](adr/0015-persisted-raw-data-is-the-source-of-truth.md). There is
one code path that produces a summary, `summariseStoredRun`: it reads the
manifest, verifies the snapshots' fingerprints, and streams `events.jsonl`,
`telemetry.csv` and `evaluation.csv` through `SummaryBuilder`. The recorder uses
it to write `summary.json`. `recomputeSummary` uses it again from a cold start
and compares every field with what was stored — no field is exempt, host timings
included, because they too are in `telemetry.csv`. The comparison tolerance is
relative 10⁻¹²; in practice it is exact.

What the tests establish:

- a 30 s run written by `NodeFileStorage`, reopened with a fresh storage handle,
  recomputes with zero differences;
- the whole pipeline agrees with pointing error computed independently in the
  test, from the raw engine state with the textbook `acos` formula (mean within
  10⁻⁹ relative, max within 10⁻⁹ rad);
- editing `summary.json`, altering one evaluation row, changing the scenario seed
  in `scenario.json`, or swapping two event lines is detected;
- the Reports screen's "Recompute & verify" reports a match, or names the
  mismatched fields.

## Reproducibility

Deterministic engineering outputs are reproducible from a completed run's
directory alone. `reproducibility.test.ts` records a 30 s run, drops every
in-memory object, parses `scenario.json` and `algorithm.json` with the real
parsers, reruns headlessly for the recorded duration, and checks the rerun
against the **recorded files**: every `command-issued` event (id, issue time,
azimuth, elevation to 17 digits), every PAT transition in `telemetry.csv` with
its instant, the encoder reading at the last recorded frame, and the manifest's
`endStateHash`.

Not reproducible, by design: host timings, run ids and wall-clock metadata.
The guarantee is the project's usual one — identical results for the same build
on the same platform. Floating-point results across different CPUs or
JavaScript engines are expected to match but are not separately guaranteed.

## Limits

- Frame counts, retention and statistics describe the autonomous window only;
  manual flying during a recording is not scored.
- One designated target per run (index 0 from the application).
- Finalisation memory grows with run length, as described above.
- A process killed mid-write can leave a truncated last line in a sample file of
  an INCOMPLETE run; such a run is never summarised.
- Closing the application does not attempt a last-moment abort: asynchronous
  work at window close is not reliable, and the incomplete-run rule already
  covers it honestly.

## Phase 7 disturbance provenance

A Phase 7 run persists the exact validated disturbance configuration in its
`scenario.json` snapshot and includes it in the scenario fingerprint. The raw
evaluation stream records evaluator-only physical realization values needed for
the versioned disturbance KPIs; no tracker receives them. Schema and metrics
definition v3 remain backward-compatible with earlier run directories: missing
v3 fields parse as absent data rather than invented zeroes. A disturbed recorded
run is recomputed cold from raw artifacts with zero differences in the test
suite, exactly as a clean historical run is.
