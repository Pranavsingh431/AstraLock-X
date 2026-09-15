# ADR-0025: Identity is evidence, and is ranked after physics

## Status

Accepted (Phase 8).

## Context

Once a tracker has a code correlation for each candidate, it has to decide what
to do with it. The tempting design is a weighted score — some multiple of the
correlation plus some multiple of the innovation — and pick the best.

That design is wrong in a way that is hard to see until it fails. A correlation
and a chi-square innovation are not commensurable: there is no exchange rate
between "matched the pattern 0.1 better" and "is 3 sigma further from where it
can physically be". A weight invents one, hides the invention inside a constant,
and produces a tracker that will, at some weight and some geometry, follow a
source that cannot possibly be the target because it correlated slightly better.

There is a second trap in the other direction. If brightness or correlation can
outrank the motion gate, a bright decoy wins whenever the true target dims —
which is exactly the Phase 7 failure with extra steps.

## Decision

Acceptance is **staged**, and the stages are ordered by what they can prove.

1. **Physics decides what is admissible, and is never overridden.** A candidate
   outside the chi-square gate or the hard angular radius is not where the target
   can be. Identity does not rescue it: a decoy that somehow carried the right
   pattern still cannot have teleported.
2. **A positively rejected identity removes a candidate**, even if it is the only
   one admitted. Following it means holding a source the evidence says is the
   wrong one; declining leaves the estimator coasting, which is what RECOVER
   exists for and is the better failure.
3. **Among what remains, a match outranks a non-match**, and within one identity
   class the smallest innovation wins — exactly the Phase 6 rule.

No arithmetic combines the two quantities at any point.

**Starting a track needs more than continuing one.** ACQUIRE requires a positive
recognition within a bounded wait; TRACK requires only that identity has not
positively refused. The asymmetry is deliberate and it is where most of the
behaviour lives:

- A beacon that stops signalling is reported as unconfirmable and keeps its
  track. Evidence that has expired is not evidence against.
- A source that has been watched long enough to produce a verdict and has not
  varied at all cannot be _started_ on, because a terminal cannot confirm a
  partner that is not signalling. It is still never called a mismatch: its
  correlation is undefined or decided by noise, and calling that a wrong code
  would be manufacturing a finding.
- SEARCH carries that refusal, not only ACQUIRE. Without it the machine
  oscillates: SEARCH ranks by brightness and hands the brightest source to
  ACQUIRE, ACQUIRE gives up on it after the bounded wait, SEARCH offers the same
  source again, and a dimmer real beacon never gets a turn. This was found by
  building the scenario the specification asked for — an obvious, bright,
  uncoded decoy — and watching the tracker fail to acquire at all.

Verdicts are named for the **evidence**, never for the world:
`insufficient-evidence`, `unconfirmed`, `match`, `mismatch`, `ambiguous`. There
is no `TRUE_TARGET` or `FALSE_TARGET`, because the tracker cannot know either
and a name implying otherwise would be a lie in the type system.

The evidence test comes before any verdict and is not negotiable: without enough
samples over enough time there is no verdict, however high a correlation a short
history happens to produce. Three samples straddling one symbol boundary
correlate at exactly 1.0 and mean nothing.

Two candidates that both reach `match` are both reported `ambiguous`. Identity
has not separated them, and picking one would be inventing a distinction the
evidence does not contain.

## Consequences

**Good.**

- Every acceptance decision can be explained in one sentence, and the sentence
  does not contain a tuning constant.
- ACQUIRE requires motion consistency **and** identity, with neither substituting
  for the other, so a bright motion-consistent source sending the wrong pattern
  is refused once there is evidence to refuse it on.
- The `ambiguous` outcome makes the rotated-code control reportable instead of
  quietly resolved.

**Costs and risks.**

- A staged rule has sharp edges. A candidate one sample short of the evidence
  requirement is treated exactly like one with no evidence at all, where a
  graded score would have degraded smoothly. The sharpness is the price of
  having no invented exchange rate, and the thresholds are stated rather than
  tuned per scenario.
- Rejecting the only admitted candidate on a mismatch will, on a scenario where
  the correlator is wrong, drop a track that a weighted design might have kept.
  A mismatch needs enough evidence to be reached, which bounds how often that can
  happen, but it is a real failure mode and not a hypothetical one.
- `ambiguous` is deliberately unhelpful: it tells the operator that identity did
  not decide, and offers nothing further. That is correct and it is also, in the
  moment, useless — which is what an honest answer sometimes is.

## Alternatives rejected

- **A weighted score.** The incommensurability above.
- **Letting a low correlation on a flat series count as a mismatch.** Pearson's
  `r` divides by the observed standard deviation, so a source that has stopped
  signalling correlates at random and looks like positive evidence of a wrong
  code about half the time. A verdict either way now requires the observations
  to have carried some modulation. Measured: without that floor,
  `code-insufficient` fell from full retention to 0.26, because noise on a flat
  series was periodically scored as a mismatch and the track thrown away.
- **Identity as a veto only, with no ranking.** It would decline decoys but never
  prefer the correct source when two are admitted, which is most of the hard
  decoy case.
- **Treating `unconfirmed` as `mismatch`.** It would refuse every target during
  the first half second of observation, and refuse for ever any target the camera
  cannot resolve well enough — turning "I do not know yet" into "no".
