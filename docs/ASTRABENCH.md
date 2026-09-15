# AstraBench

A deterministic, reproducible way to compare tracking algorithms against
identical physics, and to be able to show afterwards that the comparison was
fair.

Everything below is enforced by code or by test. Where something is a limitation
it is stated as one.

## What a benchmark is

```
BenchmarkSuite
  └─ BenchmarkCase        physical scenario + declared seeds + success rule
       └─ BenchmarkArm    algorithm id + that algorithm's configuration

one run = case × seed × arm
```

The nesting is the fairness rule made structural. Physics belongs to the
**case**, so every arm of a case necessarily gets the same world; an arm may
choose only its algorithm and that algorithm's settings. There is deliberately
no field on an arm through which a scenario, a seed or a disturbance could be
varied, so making two arms physically different requires putting them in
different cases — where the difference is visible in the suite document.

A benchmark **run is an ordinary experiment**. The same recorder, the same raw
artifacts, the same summary, recomputable the same way. AstraBench adds a layer
above Phase 5 and nothing inside it, which is what keeps a benchmark result
auditable all the way down to the telemetry.

## Fairness, checked rather than asserted

A benchmark's whole claim is "same world, different algorithm". That claim is
easy to break quietly: a scenario edited between arms, a seed that differed, a
threshold changed halfway. None of those makes a run fail. So every run carries
two fingerprints and a comparison that finds them disagreeing is reported as
invalid instead of being reduced to a winner.

**Physical fingerprint** — everything that decides what light reached the
camera: the scenario's identity and seed, the targets and their beacons and
codes, the camera, the gimbal, the platform, the disturbance configuration
including frame loss, the duration and the tick rate. Computed over the whole
validated `SimulationConfig` minus `name`, which is a display label; everything
else is included, so a field added to the schema later is covered by default
rather than silently omitted. The algorithm is not in it, and that is the point
— if it were, the arms of a case could never agree.

**Metric fingerprint** — the metric definitions a run was scored under. Two arms
scored against different thresholds are not two measurements of the same thing.

A case whose completed runs disagree on either is marked
`INVALID_PHYSICAL_MISMATCH` or `INVALID_METRIC_MISMATCH` and no comparison is
drawn for it. Comparing zero runs is `INVALID_NO_RUNS` rather than a vacuous
pass.

## Seeds, and why they are paired

Seeds are **explicit, ordered and stored in the suite document** before anything
runs. There is no generator: a benchmark that invented its seeds at execution
time could not be repeated and could not be audited.

Every arm of a case flies the same seed list. A disturbance realization is a
pure function of the scenario seed and the frame index (ADR-0020), so the arms
meet the same vibration, the same scintillation, the same wander, the same
dropped frames and the same decoy motion. An algorithm draws from its own seeded
stream (ADR-0004) and cannot advance the simulator's, so which tracker is flying
does not perturb the weather.

What the arms **do** diverge in is their pixels, because they point the camera
differently — and that is the thing being measured, not a fairness problem.
Conflating "same exogenous processes" with "same images" is the mistake the test
for this is written to avoid: it compares disturbance realizations directly,
frame by frame, rather than comparing two closed-loop runs.

That pairing is what makes per-seed differences the honest comparison. Both arms
met the same weather on seed 9103, so a difference on seed 9103 is attributable
to the algorithm in a way that a difference of two averages over unrelated runs
never is.

## Aggregation: nothing is dropped

The temptation in a benchmark aggregator is to average whatever succeeded. That
produces a report in which every algorithm acquires 100% of the time, because a
run that never acquired contributed no acquisition time to average. So:

- **Counts come first.** Attempted, completed, failed, cancelled, acquired,
  succeeded. A rate is meaningless without its denominator beside it.
- **Distributions are kept.** `aggregate.json` stores every per-run value that
  fed a median, so a reader can see that a median came from three samples, or
  that one seed is carrying the result.
- **Absence is a value.** A completed run with no acquisition has no pointing
  error, and that is a `missing` sample rather than a zero. A run that failed or
  was cancelled is not a missing measurement at all — it is counted under
  `failed` or `cancelled`, where it stays visible.
- **Success is declared in advance.** Each case names its criterion in the suite
  — `acquired`, `retention-at-least`, `handoff-ready`, or
  `retention-without-false-lock` — so a success rate chosen after seeing the
  results is not possible.

### No composite score

There is no overall score and no winner badge. A composite of acquisition time,
pointing error and retention requires exchange rates between seconds,
microradians and a fraction, and there are none; a weight would invent them and
hide the invention inside a constant. What the reports show is metric-specific
results, the per-seed differences behind them, and a count of the seeds each arm
was better on — "better on 4 of 5 seeds for retention" is a statement the data
supports.

No statistical significance is claimed, because no test is implemented and five
seeds would not support most of them anyway.

## Storage

```
<app data>/runs/<run id>/            every benchmark run, as an ordinary experiment
<app data>/benchmarks/<benchmark id>/
    manifest.json    what ran, what happened to each run, and the fingerprints
    suite.json       the suite document, exactly as executed
    aggregate.json   every displayed number, computed from the artifacts
    report.html      the offline report
```

Two stores rather than one. A benchmark's documents are not an experiment, and
giving them experiment-shaped identifiers in `runs/` would make the Reports view
list directories it cannot parse. On the desktop the split is enforced by the
Rust host, whose `store` parameter is an allowlist of exactly two names and
cannot become a path.

The manifest names the run ids it produced, so a benchmark directory is
self-contained by reference rather than by copying twelve identical scenario
documents. The suite is stored once, in full; each run additionally stores its
own scenario and algorithm configuration, as every experiment does.

The manifest is rewritten **after every run**, not once at the end, so a process
that dies mid-suite leaves a directory that says exactly how far it got.

## Recomputation

`recomputeBenchmark` reads the manifest, reads each run's summary, rebuilds the
aggregate from scratch and compares it with the stored document. Zero
differences is the passing condition and it is checked by test.

Nothing reruns a simulation. If a number could not be recovered from the
artifacts then the artifacts are missing something, and that is a defect in what
gets recorded.

Tampering is caught twice: editing a run's `summary.json` changes the recomputed
aggregate and shows up here; editing the raw telemetry beneath it is caught by
the experiment's own `recomputeSummary`.

## Execution

Sequential, one run at a time. Correctness came first and no measurement yet
justifies the complexity of workers; the throughput below is adequate for the
suites that exist.

**Cancellation** stops at the next run boundary — checked once per simulated
second rather than per tick, so a cancel waits milliseconds rather than costing
a check every microsecond. Completed runs stay valid, the in-flight run is
aborted and recorded as cancelled, unstarted runs are recorded as cancelled
rather than omitted, and the benchmark status becomes `cancelled`. Every planned
run is accounted for.

**Failure** of one run does not stop the suite. An unknown algorithm, a
configuration the algorithm refuses, or a crash mid-run is recorded with its
error and the remaining runs proceed.

**Progress** is real: total, completed, failed, cancelled, remaining, and what is
executing right now. The estimated time remaining is derived from runs that have
actually finished and is absent until at least one has, because before that
there is nothing to extrapolate from.

## Measured

On an Apple-silicon laptop, headless, Node 24:

| Measurement                                      | Value                                                                                              |
| ------------------------------------------------ | -------------------------------------------------------------------------------------------------- |
| Quick Validation: 12 runs, 520 simulated seconds | 27.5 s wall clock                                                                                  |
| Simulation throughput                            | **18.9× real time**                                                                                |
| 50 short runs                                    | 9.6 s wall, 193 ms per run, 20.8× real time                                                        |
| Heap across 50 runs                              | 36.8 MB → 90.4 MB, with all fifty runs' artifacts held in memory by the test's storage             |
| Orchestration overhead                           | **1.12×** over driving the same runs directly, _including_ recording every frame and evaluating it |
| Recomputation of a finished benchmark            | 0 differences                                                                                      |

Throughput is **simulation throughput** — simulated seconds per wall-clock
second — and is not a camera frame rate. No simulation timestamp is altered to
achieve it: the engine advances at its configured tick rate and simply is not
asked to wait.

The Engineering Comparison suite is 90 runs of 45 simulated seconds, roughly
four minutes of wall clock. It is not run in CI.

## What the first suite found

The first real Quick Validation run surfaced a defect that had been in the
metrics engine since Phase 7, which is the most useful thing a new benchmark can
do.

`TRACKING_MODES` maps a metrics-definition version to the PAT modes that count
as the algorithm claiming a track. Phase 6 added `handoff` for v2, with the
reasoning written down: handoff-ready is tracking with stricter conditions met,
so time spent there must not count against the tracker. Phase 7 then bumped the
definition version to 3 to carry the image-SNR aperture, and did not extend the
table. `trackingModesFor` fell back to `['track']`.

Nothing failed. A fallback to a valid mode list produces valid-looking numbers.
What it did was understate lock retention for any algorithm that reaches
HANDOFF, which is AstraLock-X and not the baseline — so it also understated it
asymmetrically, in the direction that makes a comparison wrong.

AstraBench found it on a stationary beacon that AstraLock-X was holding to
109 µrad of true pointing error while being scored at **0.049** retention.
After the fix the same run scores **1.000**.

The correction, and what it does not change:

- `TRACKING_MODES` now has an entry for v3, and a test requires an entry for
  every version up to `METRICS_DEFINITION_VERSION`.
- `trackingModesFor` **throws** for a version the table does not cover instead
  of falling back. A metrics definition nobody has written down is not a metrics
  definition.
- Handoff validity was keyed on `definitionVersion === 2` and had stopped being
  computed under v3 for the same reason; it is now keyed on "not v1".
- **No published Phase 7 or Phase 8 number changes.** Only runs that reach
  HANDOFF were affected, and none of the scenarios in those phases' reported
  tables do. Phase 6's handoff results were measured under v2, before the gap
  existed.

## The bundled suites

| Suite                  | Cases | Seeds | Runs | For                                                       |
| ---------------------- | ----: | ----: | ---: | --------------------------------------------------------- |
| Quick Validation       |     6 |     1 |   12 | A functional check or a demonstration. Not a measurement. |
| Engineering Comparison |     9 |     5 |   90 | The numbers worth quoting.                                |
| Full Coverage          |    14 |     1 |   28 | Breadth across every capability built through Phase 8.    |

Quick Validation is explicitly **not comprehensive**: one seed of a stochastic
scenario is one realization, and nothing from it should be quoted as a result.

Engineering Comparison uses five seeds — 9101 to 9105 — declared in source
before any of them was run. Not chosen, not filtered, not reordered.

Every suite pairs the same trackers against identical physics, and the reference
arm is always first, which is what the paired comparison measures against. The
`example-scan` reference plugin is registered but is in no suite: comparing a
tracker against something that does not track produces a number that flatters
the tracker and measures nothing.

## Limitations

- **Sequential only.** No worker parallelism. A 90-run suite takes minutes.
- **Five seeds is a small sample.** Enough to see whether a conclusion survives
  the spread; not enough for a statistical test, and none is claimed.
- **No significance testing.** Descriptive comparison and per-seed counts only.
- **The reference arm is first by convention**, not by analysis. A suite states
  its reference by ordering its arms.
- **Registration is a source change.** No plugin is loaded from a URL, a bundle
  or a string. That is a deliberate security limit, not an unfinished feature.
- **Benchmarks need the desktop application**, because they write run artifacts
  and a browser tab has nowhere durable to put them. The interface says so
  rather than appearing to work.
- **Host timings are not engineering quantities.** They differ per machine and
  are excluded from every determinism comparison.
