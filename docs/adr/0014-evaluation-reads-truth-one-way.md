# ADR-0014: Evaluation reads ground truth; nothing reads evaluation back

- **Status:** Accepted
- **Date:** 2026-09-14
- **Phase:** Phase 5

## Context

Scoring a tracker requires ground truth. There is no way to compute a pointing
error without knowing where the target actually was, and an evaluator that could
not see the truth could not evaluate anything.

That creates a module which legitimately holds exactly what ADR-0003 spent four
phases keeping away from the tracking side — and which, unlike the simulator,
produces numbers a tracking algorithm would _love_ to have. The angular pointing
error is the quantity the controller is trying to minimise. An algorithm that
could call the evaluator would not need pixels at all: it could close the loop on
its own score and post a perfect result while learning nothing.

The danger is worse than with the simulator itself, because the leak would look
like success rather than like a crash.

## Decision

Evaluation is **one-way**, and the one-wayness is enforced the same four ways
ground truth already is.

**Structurally.** The evaluator in `src/core/experiments/` is called by the
recorder, which the runtime notifies as a `LoopObserver` _after_ the algorithm
has produced its output and the command has been submitted. There is no point in
the frame's lifecycle at which an evaluation result exists and the algorithm has
not yet decided. Attaching or detaching the observer does not rebuild the
runtime or the algorithm.

**By lint barrier.** `@/core/experiments` joins `@/core/contracts/ground-truth`,
`@/core/simulation`, `@/core/metrics`, `@/core/sensors`, `@/core/gimbal`,
`@/core/runtime` and `@/scenarios` on the list of modules unreachable from
`src/core/algorithms/**` — by alias, by relative path and by type-only import.
Probe files placed in a tracking-side directory are linted with the project's
real ESLint configuration to confirm each route is closed.

**By the contract.** `TrackingInput` cannot carry an evaluation result, and that
is proved at compile time by assertions inside the contract itself.

**By file separation.** Safe telemetry and privileged evaluation go to different
files. Every truth-derived column of `evaluation.csv` is prefixed `truth_`, the
manifest classifies the file as `privileged-evaluation`, it is never loaded as
control input, and it records _derived_ truth quantities — line of sight, optical
axis, pointing error, range, visibility — rather than the world state, so the
artifact is purpose-limited even as an offline file. Event payloads are flat
scalars and a test checks none carries a truth quantity.

The evaluator's coarse-lock condition is likewise evaluation-only. It exists to
score the tracker and is never fed back to it; the baseline does not know it
exists and does not change behaviour when it is satisfied.

The interface may display live evaluation figures — a demonstration is more
convincing when the truth is on screen next to the estimate — but they are
labelled EVALUATION — ground truth, and can be hidden entirely, in which case
they are not computed. The autonomous system must be demonstrable with no
privileged number visible at all, and a test shows it acquiring and holding with
the panel hidden.

## Consequences

**Good.**

- A tracker cannot optimise against its own score, by construction rather than
  by review.
- The report can contain derived truth-based metrics without that implying the
  controller had access to them during the run.
- The separation is visible in the artifacts, not only in the code: a reader can
  see which file is safe and which is not.
- Live KPIs are available for a demonstration without weakening the guarantee,
  because they are read by React and by nothing else.

**Costs and risks.**

- A ninth entry on the barrier list, and a directory that reads truth sitting
  inside `core/` alongside directories that must not. The naming and the ADR
  carry that distinction; the lint rule enforces it.
- Evaluation and the algorithm necessarily compute similar-looking things — a
  bearing, a projection — from different inputs, so there are two projections in
  the codebase. That duplication is deliberate: the algorithm's uses the
  _believed_ calibration and the _measured_ pose, the evaluator's uses the true
  optics and the true pose, and unifying them would destroy the distinction
  being measured.
- The interface holds an `Evaluator` for the live panel. It is a privileged
  reference living in a store the algorithm also cannot reach, which is
  acceptable only because the barrier makes the import impossible in the first
  place.
- The evaluator's coarse-lock condition is applied when a summary is computed,
  not stored in the raw file, so it can be changed without rerunning a
  recording ([ADR-0015](0015-persisted-raw-data-is-the-source-of-truth.md)).

**Rejected alternatives.**

_Compute metrics entirely offline, after the run._ Attractive, and partly what
happens — the summary is recomputable from files. But live KPIs during a
demonstration are genuinely useful, and the offline-only rule would not have
removed the barrier requirement anyway, since the offline tool reads the same
truth.

_Let the evaluator run inside the algorithm's process boundary with a
capability token._ More machinery, the same guarantee, and one more thing to get
wrong.
