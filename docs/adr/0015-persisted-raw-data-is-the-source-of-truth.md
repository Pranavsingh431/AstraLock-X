# ADR-0015: A run's summary is computed from its persisted raw files

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 5

## Context

An experiment report is only as credible as the path from what happened to the
numbers printed. The obvious implementation — accumulate statistics in memory
while the run executes, write the totals at the end — asks a reader to trust an
accumulator they cannot inspect. If it double-counted a frame, skipped one, or
used a threshold nobody wrote down, the files on disk would not reveal it.

The first implementation of this phase did exactly that, and then offered a
"recompute" that was partly circular: it took the metrics configuration, the
sensor frame count and even the number of targets (inferred from a flag in the
summary) _from the stored summary it was supposed to verify_, and excluded host
timings and command application times from the comparison because they had never
been written to a raw file. It also held every sample in memory for the length of
the run.

Two further facts mattered. Recording must keep memory bounded on long runs, and
a metric definition may change — a tighter lock threshold, a different dwell —
without making every earlier recording wrong.

## Decision

**The raw files are the record; the summary is a function of them.**

1. During a run the recorder writes only raw data — `events.jsonl`,
   `telemetry.csv`, `evaluation.csv` — plus provenance and configuration
   snapshots. It keeps no per-sample state.
2. There is exactly one code path that produces a summary:
   `summariseStoredRun`. It reads the manifest, verifies the configuration
   snapshots against their fingerprints, and streams the three raw files through
   the pure `SummaryBuilder`. The recorder calls it at finalisation to write
   `summary.json`. The report is rendered by streaming the same files.
3. Every summary field must be derivable from those files. Anything a metric
   needs that is not a sample — the end instant, the generated frame count, the
   metrics configuration, the end-state hash — is written to the manifest as raw
   provenance before the summary is computed. Host timings are telemetry columns.
   Command application instants are events.
4. `recomputeSummary` runs `summariseStoredRun` again from a cold start and
   compares **every** field with the stored summary. Nothing is exempt.
5. **No metric threshold is baked into a raw file.** Evaluation rows hold
   physical facts — pointing error, range, within-travel, projection. Lock,
   dwell, grace, association radius and trackable range are applied by the
   builder. A run can be rescored under a different definition; the result
   carries that definition's fingerprint and never overwrites the stored one.
6. A summary exists only for a completed run, and the manifest's status becomes
   `completed` only after the summary and report are on disk.

## Consequences

**Good.**

- A reader holding the directory can reproduce every published number, and the
  application does it on request. Editing `summary.json`, altering one evaluation
  row, changing a configuration snapshot or reordering the event log is detected
  (all four are tested).
- The recorder's memory is bounded by its write batches, independent of run
  length.
- Metric definitions can evolve without invalidating recordings.
- Because stored and recomputed summaries come from the same function over the
  same files, the equality check is exact in practice. Its value is that no
  hidden input exists, not that two implementations agree; the tests therefore
  also compare the pipeline against pointing error computed independently, with
  different code, from the raw engine state.

**Costs and risks.**

- Finalisation reads the files back. For a two-minute run that is about 9 MB and
  a few hundred milliseconds; it grows with run length.
- Percentiles need every value, so finalisation holds each statistic's samples
  as 8-byte doubles (roughly 120 bytes per frame across all series). Bounded by
  run length, not constant. An approximate quantile sketch would bound it, at the
  price of exactness; not warranted at present run lengths.
- The raw files are larger than totals would be: about 1.25 KB per frame, of
  which the per-command events are a large share.
- A defect in the builder affects stored and recomputed summaries identically.
  The hand-worked unit tests and the independent pointing-error check exist for
  that reason.

**Rejected alternatives.**

_Live accumulator plus an independent offline recompute._ Two implementations of
every metric that must agree, with the live one unverifiable in the field. The
second implementation would be the trustworthy one, so it may as well be the only
one.

_Store the summary alone._ Nothing to check it against.

_Store the lock flag in `evaluation.csv`._ It is what the first version did. It
freezes one metric definition into the raw data and makes rescoring impossible.
