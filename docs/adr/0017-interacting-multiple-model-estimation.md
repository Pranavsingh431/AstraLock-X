# ADR-0017: Two motion models, interacting — not one model, and not a race

- **Status:** Accepted
- **Date:** 2026-09-15
- **Phase:** Phase 6

## Context

The Phase 4 baseline estimates bearing with a single constant-velocity Kalman
filter. That is the right first choice and it has a known failure: a target that
accelerates is tracked with a lag proportional to the acceleration, and the only
way to reduce that lag is to raise the process noise — which makes the filter
noisier on the benign targets that make up most of a run.

The tension is not resolvable inside one model. A filter tuned tight tracks a
steady target beautifully and lags a manoeuvre; a filter tuned loose does the
opposite. Choosing one tuning is choosing which case to be bad at.

Two shortcuts are available and both are worse than they look.

_Run two filters and use whichever currently has the smaller residual._ This is
not an estimator. It discards the loser's information entirely, switches
discontinuously, and has no principled way to express "probably steady, possibly
manoeuvring" — which is the actual state of knowledge most of the time.

_Use one model with adaptive process noise._ Better, but the adaptation law is
an invented heuristic with no likelihood behind it, and its covariance no longer
means what a covariance is supposed to mean.

## Decision

A genuine **interacting multiple model** estimator over a common six-element
state — azimuth, elevation, and their rates and accelerations — running a
nearly-constant-velocity and a nearly-constant-acceleration model together.

The full IMM cycle, not a subset:

1. mixing probabilities from the model transition matrix;
2. mixed initial conditions per model, **including** the between-model spread
   term;
3. model-conditioned prediction;
4. model-conditioned measurement update;
5. measurement likelihood per model;
6. model probability update from those likelihoods;
7. fused state as the probability-weighted mean;
8. fused covariance as the probability-weighted sum of each model's covariance
   **plus** its dispersion about the fused mean.

Steps 2 and 8 are the ones that make it an IMM rather than two filters in a
trench coat. Step 8 in particular is what makes the fused covariance honest:
when the models disagree the estimate is genuinely less certain, the gate
widens, and the controller's confidence falls — all of which is correct and none
of which a selection rule can express.

**Likelihoods are computed in the log domain** and shifted by the maximum before
exponentiating. A model that fits badly for a few seconds otherwise underflows
to exactly zero, its probability sticks at zero, and the estimator quietly
becomes single-model for the rest of the run.

**Transition probabilities are specified as per-reference-interval stay
probabilities and converted through a rate**, so the matrix is correct at any
`dt` rather than only at the rate it was tuned at.

**Model names are literal.** NCV's transition zeroes the acceleration row and
its position and rate rows carry no acceleration term; NCA's does not. Neither
name is decoration for a model that does something else.

## Consequences

**Good.**

- The estimator reports _that_ a manoeuvre is happening, as a probability with a
  likelihood behind it. Measured with the shipped tuning: NCA sits at 0.08 on a
  constant-velocity target and peaks at 0.79 during a 7.85×10⁻³ rad/s²
  manoeuvre.
- Post-acquisition RMS pointing error on the manoeuvring scenario improves from
  371 µrad to 297 µrad against the baseline on identical physics, measured over
  a window long enough for both arms to have settled.
- The fused covariance is usable for gating and for scaling the recovery search,
  because it accounts for model disagreement.
- Cost is negligible: 61 µs per predict-and-update cycle, against a detector
  that costs ten times that.

**Costs and risks.**

- **It costs accuracy on targets that never manoeuvre.** Measured: 209 µrad
  post-acquisition RMS against the baseline's 167 on the constant-velocity
  scenario, with roughly double the P95. A six-state filter estimating an
  acceleration that is not there has more freedom to be wrong than a
  constant-velocity filter does. This is the trade the decision makes, and on a
  link whose targets genuinely never accelerate it is a bad trade.
- Substantially more machinery than one Kalman filter, and more that can be
  subtly wrong. It is covered by thirteen behavioural tests against synthetic
  sequences with known answers, independent of the simulator.
- Tuning is genuinely harder: the two process-noise densities interact through
  the likelihood ratio, and a badly chosen pair gives an estimator that looks
  like it is working. Ours was measured by sweep, and the sweep is recorded in
  `docs/ASTRALOCK_PAT.md` rather than left as folklore — the first jerk density
  we tried made the NCA likelihood so broad the model could never win, and the
  probabilities sat at the transition matrix's stationary distribution whatever
  the target did.
- When both models explain the data equally well the probabilities relax to that
  stationary distribution. This is correct, and it means model probability is
  informative about manoeuvres rather than about truth. It has to be read that
  way and the documentation says so.
- Two models is not all models. A sustained coordinated turn is absorbed as
  acceleration rather than recognised, which is a real limitation and is
  recorded as one.

**Rejected alternatives.**

_Single model with adaptive noise._ No likelihood, no honest covariance, and the
adaptation law would be a heuristic nobody could defend.

_Residual-based model selection._ Discards information, switches
discontinuously, and cannot represent uncertainty between models.

_Adding a coordinated-turn model now._ Three models is more to tune and more to
test, and the two-model case had to be demonstrably right first. It remains
available.
