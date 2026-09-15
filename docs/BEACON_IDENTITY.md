# Coded beacon identity

How AstraLock-X tells one optical source from another by watching it, what that
costs, and — just as important — what it cannot do.

## Why intensity and geometry are not enough

Through Phase 7 the tracker decides what to follow from two things: how bright a
blob is, and whether its bearing is where the estimator predicted. Both are
good discriminators and both have the same blind spot. They describe a blob's
_appearance and motion_, and two sources can share both.

Phase 7 demonstrated this rather than asserting it. In `dist-decoy-hard` a
second emitter of comparable brightness crosses close to the designated
target's predicted bearing. It passes the chi-square innovation gate, because it
genuinely is where the target was expected to be; it passes the score floor,
because it genuinely is bright. AstraLock-X followed it, and the evaluator
recorded two false-lock episodes totalling nearly forty seconds.

No amount of tuning fixes that. The information needed to separate the two
sources is not present in a single frame.

## What is present is time

A beacon that varies its brightness to a known pattern can be recognised by
watching it across many frames. A source that does not carry the pattern cannot
imitate it without knowing it, and the receiver needs to be told only the
_pattern_ — never which object in the world is emitting.

That distinction is the whole architecture:

| The terminal is configured with        | The terminal never receives              |
| -------------------------------------- | ---------------------------------------- |
| the signalling pattern it expects      | which simulator entity is the target     |
| the symbol duration                    | the true code any emitter is sending     |
| its own thresholds and search settings | the true modulation phase                |
|                                        | any emitter, target or entity identifier |

Being configured with an expected pattern is not ground truth, in the same sense
that a radio configured with a frequency has not been told which transmitter is
which. Working out _which blob_ is sending the pattern remains the tracker's
problem, and it can still get it wrong — `identity.ts` documents where.

## WHY WE DO NOT DIRECTLY SAMPLE A 10 kHz BEACON WITH A 60 FPS CAMERA

This deserves its own section because the naive design is very tempting and
completely wrong.

It is natural to write down "the beacon blinks at 10 kHz, the camera runs at
60 fps, read one bit per frame". That is not a fast link; it is not a link at
all. Three separate things are wrong with it.

**A camera integrates; it does not sample.** A frame is not a measurement of the
scene at an instant. Every pixel accumulates optical power for the whole
exposure and reports one number for the total. A source that switches on and off
many times during a single exposure contributes its _average_ to that number.
With a 10 kHz carrier and even a 1 ms exposure, ten full cycles land inside one
frame and the camera reports their mean — which is the same mean whatever the
bit pattern was. The modulation has not been slowed down or aliased; it has been
integrated away.

**Sampling theory sets a hard ceiling.** Even for a source the exposure could
resolve, a sampler running at 60 Hz can represent no frequency above 30 Hz.
Everything above that aliases: a 10 kHz square wave observed at 60 fps produces
a sequence that looks like noise or like a slow beat, and no correlator
afterwards recovers the original. The information is not hidden, it is gone.

**"One bit per frame" quietly redefines the beacon.** If the receiver takes one
symbol from each frame, then the symbol rate _is_ the frame rate, and calling
the beacon 10 kHz is a description of hardware nobody is simulating. A system
that genuinely reads a high-rate optical carrier does it with a photodiode and a
fast receiver chain, or with an event camera, or with a sensor whose readout is
synchronised to the modulation. Those are different instruments, with different
data, and this project does not model any of them.

So Phase 8 does the honest thing and designs the code for the camera it has.

## Symbol timing, derived

The constraint is that the camera must be able to resolve the pattern:

```
  frame period   = 1 / frameRate      = 16.667 ms at 60 fps
  symbol duration >= 2 x frame period                      (Nyquist floor)
```

The floor is enforced in `validatedSimulationConfigSchema`: a scenario whose
beacon symbols are shorter than two frame periods is **rejected at load**, not
quietly rendered into an unrecoverable image.

The bundled default sits comfortably above the floor:

```
  symbolDuration = 4 x frame period = 66.667 ms   ->  15 symbols per second
  sequence       = 15 symbols                     ->  1.000 s per code period
  exposure       = 2 ms                           ->  3 % of a symbol
```

Four frames per symbol, not two, because the floor leaves no margin: dropped
frames, noise and a target that dims below the detector threshold all remove
samples, and a design sitting exactly at Nyquist fails the first time it loses
one.

At this timing a full code period takes one second and the default evidence
requirement — 24 samples spanning at least 6 symbols — is met after roughly half
a second of continuous observation.

### Modulation depth, and why "off" is not off

The obvious choice is on-off keying: full brightness for a 1, dark for a 0. It is
the wrong choice here, and the detector's own thresholds say why.

A beacon that switches fully off vanishes from the image for the whole of every
zero symbol — four consecutive frames at the default timing. The tracker cannot
follow something that is absent a third of the time: the detector reports no
candidate, the estimator coasts, and after three such frames AstraLock-X enters
RECOVER. The beacon would be identifiable and untrackable at the same time.

So the default modulates between two levels that are both comfortably
detectable. Working the detector's thresholds backwards for the bundled beacon
(`intensity` 0.9, `psfSigma` 2.4 px, threshold 40, `minPeak` 70,
`minIntegratedIntensity` 150):

| Level | Peak counts | Area px | Integrated | Candidate score | Detected |
| ----- | ----------- | ------- | ---------- | --------------- | -------- |
| 1.00  | 230         | 63      | 4329       | 0.318           | yes      |
| 0.55  | 126         | 42      | 1457       | 0.163           | yes      |
| 0.45  | 103         | 34      | 917        | 0.124           | marginal |
| 0.30  | 69          | 20      | 258        | 0.061           | **no**   |

`minCandidateScore` is 0.10, so an off level of 0.30 does not merely dim the
beacon — it removes it. 0.45 clears the floor by a quarter, which anything that
dims the source further (range, attenuation, a noisy frame) would eat. **0.55 is
the default**: score 0.163, a comfortable margin, and still a 3.0x contrast in
integrated intensity between a one and a zero.

Full on-off keying remains expressible: the schema requires only
`offIntensity < onIntensity`, so zero is allowed. No bundled scenario uses it,
because every bundled scenario needs its beacon to stay trackable while it
signals. The consequences above are the scenario author's to accept, and they
are stated here rather than prevented.

## The code

Maximum-length sequences, generated from primitive polynomials by
`maximumLengthSequence`. An m-sequence of length `2^n - 1` has periodic
autocorrelation `N` at zero shift and exactly `-1` at every other shift, which
is the flattest off-peak a binary sequence of that length can have. That matters
because the receiver does not know the transmitter's clock and must search over
phase: a code with a strong secondary peak would let the search lock onto the
wrong alignment.

Measured, in `code-library.test.ts`:

| Property                                 | CODE_A | CODE_B |
| ---------------------------------------- | ------ | ------ |
| length                                   | 15     | 15     |
| ones / zeros                             | 8 / 7  | 8 / 7  |
| autocorrelation peak                     | 15     | 15     |
| largest off-peak autocorrelation         | 1      | 1      |
| largest cross-correlation with the other | 7      | 7      |

**The 7 is the number that matters most, and it is a limitation.** Degree 4 has
exactly two primitive polynomials, so there are exactly two m-sequences of
length 15 and they are not orthogonal: at its worst alignment a `CODE_B` source
reaches `7/15 = 0.47` against an expected `CODE_A`. Any usable match threshold
has to clear that with margin, which is why the default is 0.65 and not
something closer to 0.5. A system needing many mutually distinguishable codes
needs longer ones, and longer codes need either more observation time or a
faster camera.

### The ambiguous control

`AMBIGUOUS_CODE_A_SHIFTED` is `CODE_A` rotated by four symbols. A receiver that
searches over phase — which it must — sees a rotation of a code as that same
code at a different phase and **cannot distinguish them at all**: the measured
cross-correlation over all shifts is 15 out of 15.

It is in the library on purpose. It makes the limitation demonstrable instead of
merely admitted, and it is the scenario used for the ambiguity negative control.

## Exposure integration

The emitted level is a square wave. What reaches a frame is its integral over
the exposure:

```
  level(a, b) = (1 / (b - a)) * INTEGRAL from a to b of level(t) dt
```

`integratedLevel` computes this exactly, by walking the symbols the window
overlaps and weighting each by how much of the window it covers. It never
evaluates `level(captureTime)`: at the default timing an exposure is short
relative to a symbol, but a scenario is free to configure one that straddles
boundaries, and a midpoint sample would then report a level the sensor never
collected.

The walk steps an **integer symbol index** rather than re-deriving the index from
a running cursor. That is not fussiness. Deriving the index from a cursor which
is itself the result of earlier floating-point arithmetic lets a boundary land a
fraction of an ulp on the wrong side of itself; the symbol is split in two and
the sliver charged to the previous symbol's level. Measured over a 40-second
window of 1 ms symbols, that bug produced a systematic bias of exactly one
symbol's worth of extra "on" time.

Inside the renderer each sub-exposure sample carries its own exact integral over
its own sub-interval, so:

- with one sub-sample, the integral is over the whole exposure and is exact;
- with several, the code is correctly weighted against the motion blur that
  sub-sampling exists to produce.

## The receiver

### Candidate histories

For every blob the detector reports, the tracker keeps a bounded history of
**safe observables only**: timestamp, exposure, image position, integrated
intensity. No identifier of any kind is stored, because none is available.

Bounded twice over — by a time window and by a sample cap — so neither a long
run nor a high frame rate can grow memory.

Histories are joined across frames by nearest-neighbour **in bearing**, greedily
by angular distance, within `associationAngle` (a quarter of a degree by
default, about thirteen pixels on the reference camera).

Bearing rather than pixels, and the difference is not cosmetic. The image moves
under the gimbal: at half a degree per second of slew a stationary source
travels about twenty-six pixels between frames, so a pixel join loses _every_
history at once, precisely when the tracker is manoeuvring and most needs to
know what it has been watching. This was not a theoretical concern — it was
measured. With a pixel join, `code-decoy-hard` showed the tracker repeatedly
grabbing the decoy, refusing it, losing the histories in the ensuing slew, and
grabbing it again: sixteen short false-lock episodes where identity-off had
three long ones. In bearing the histories survive the slew and the same run has
none at all.

**Crossings can still transplant evidence.** When two sources pass closer than
the association angle the join can follow the wrong one, and the identity
evidence then follows the wrong blob until new samples wash it out. That is a
real property of tracking by position alone. A tracker that got crossings right
every time would only be doing so by consulting something it is not allowed to
see, and every result here would be a fiction.

### The score

Pearson correlation between the observed brightness history and the
exposure-integrated _shape_ of the expected code at a candidate phase:

```
  x_i = integrated shape of the expected code over sample i's exposure
  y_i = observed integrated intensity of sample i

  r = SUM (x_i - xbar)(y_i - ybar)
      / sqrt( SUM (x_i - xbar)^2 * SUM (y_i - ybar)^2 )
```

Bounded on `[-1, 1]`. It is **not** a probability and is not named as one; the
fields are `codeCorrelation` and `identityState`.

Normalisation is the point. `r` is invariant under any affine change of `y`, so a
candidate twice as bright, or sitting on a brighter background, scores exactly
the same. Without that the score would quietly become a brightness contest —
which is the failure being fixed.

`r` is **undefined**, and reported as such, when either series has no variance:
a history spanning less than one symbol has a constant predicted shape, and a
source of constant brightness carries no temporal information. Both are answers,
not edge cases.

### Why a flat series is not evidence of a wrong code

Normalisation has a dangerous edge. Pearson's `r` divides by the observed
standard deviation, so a series that is _almost_ flat has its noise stretched to
fill the whole range: a source which has stopped signalling correlates somewhere
in `[-1, 1]` essentially at random, and roughly half the time that number is low
enough to look like positive evidence of a **wrong** code.

It is not. It is no evidence at all, and the two have to be told apart. So the
receiver also measures how much the brightness actually varied — standard
deviation over mean, a property of the observations with no code in it — and a
candidate below `minModulation` receives no verdict either way.

The separation is wide. A square-wave beacon at the bundled contrast measures
about 0.48; a steady source sits near the sensor's noise. The floor is 0.12,
which is clear of both and is not a threshold either case has to be tuned
against.

This was found by measurement rather than by reasoning. `code-insufficient`, the
scenario where the beacon stops signalling twenty seconds in, dropped from full
retention to 0.26 with identity enabled: once the code stopped, noise on the
flat series was periodically scored as a mismatch and the track was thrown away.
With the floor, the same run holds the track at 0.96 retention and reports
`insufficient-evidence`, which is the truthful description of its situation.

### Phase search

The transmitter's symbol clock is unknown, so phase is recovered rather than
assumed: a uniform sweep over one full code period, which is sufficient because
every alignment recurs within a period.

Once a phase has been accepted the sweep narrows to a window around it, because
the transmitter's clock does not move and re-searching the whole period every
frame is work with a known answer.

Narrowing has a consequence worth stating, because two true statements in this
document otherwise look contradictory. A rotation of an m-sequence is
indistinguishable from the original **to a receiver searching the whole period**
— the periodic correlation is identical, 15 out of 15, and `code-library.test.ts`
measures it. A receiver that has already locked the phase is not searching the
whole period: it knows where a symbol boundary falls, and a copy rotated by four
symbols puts its boundaries a quarter of a second away from there. In absolute
time the two are different signals.

So the ambiguity is real at acquisition and absent during track, which is what
`code-ambiguous` shows in the closed loop. The case that does not go away is an
intruder sending the identical code at the identical phase — the same signal
from a different object — and that is what `code-identical` exists for.

One presentational consequence is worth knowing about before it confuses
somebody. `code-insufficient` expresses "signal for twenty seconds, then stop"
as a non-repeating sequence of twenty passes of the code spliced end to end, and
the terminal is configured with exactly what its partner transmits — so the
identity panel reads "expecting 300 symbols" on that scenario rather than 15.
The receiver still works, because the transmitted signal is periodic at one
second throughout the signalling window, but the number in the panel is the
concatenation, not the repeating unit.

Resolution is a configured step count rather than anything adaptive. A sweep
finer than the camera's own sampling buys nothing — observations cannot
distinguish phases closer together than an exposure — and cost is linear in
steps, so the setting is a direct and visible trade.

### Verdicts

| State                   | Meaning                                                                      |
| ----------------------- | ---------------------------------------------------------------------------- |
| `insufficient-evidence` | too few samples, too short a span, or no variance to correlate               |
| `unconfirmed`           | enough evidence, but the score sits between the thresholds                   |
| `match`                 | correlates with the expected code at or above `minCorrelation`               |
| `mismatch`              | correlates at or below `mismatchCorrelation`                                 |
| `ambiguous`             | this candidate matches, but so does another: identity does not separate them |

Every name describes the **evidence**, never the world. There is no
`TRUE_TARGET` or `FALSE_TARGET`, because the tracker cannot know either and a
name implying otherwise would be a lie in the type system.

The evidence test comes first and is not negotiable. Three samples straddling a
single symbol boundary correlate at exactly 1.0 and mean nothing — two points
either side of one edge fit any monotone pattern — and only the sample and span
requirements stop that becoming a MATCH. There is a test named after exactly
that trap.

## How identity enters the state machine

Identity is evaluated once per frame for every candidate, in every state. The
evidence has to accumulate while the tracker is still searching, or a source
would have to be watched all over again after acquisition.

What the machine then does with a verdict differs by state, and the rule behind
the difference is one sentence: **starting a track needs more than continuing
one.**

### SEARCH

The strongest candidate above the score floor wins, as it has since Phase 6 —
with one addition. A source identity has settled against is skipped: a
`mismatch`, an `ambiguous`, or one that has been watched long enough to produce
a verdict and has not varied at all.

The last of those is not fussiness. An unmodulated source that happens to be the
brightest thing in the sky would otherwise be handed to ACQUIRE for ever:
ACQUIRE gives up on it after its bounded wait, SEARCH immediately offers the
same source again, and the real beacon — dimmer, and never ranked first — never
gets a turn. `code-decoy-easy` is that case, and it is why SEARCH has a memory.

A source identity has _not yet_ judged is still eligible. Refusing to start on an
unjudged source would mean never starting at all, because the evidence only
exists once something has been watched.

### ACQUIRE

Motion evidence and identity evidence are both required, and neither substitutes
for the other. Phase 6's persistence and innovation checks still have to pass;
with identity enabled the candidate must also have been positively recognised,
which takes about half a second of watching at the bundled timing.

The wait is bounded by `maxAcquireSeconds`. A candidate that never produces a
verdict is abandoned rather than waited on for ever, and the machine returns to
SEARCH — which, by the rule above, will now look past it.

### TRACK

The staged rule: the motion gate decides what is admissible and is never
overridden; a candidate the correlator has positively refused is not taken, even
when it is the only one admitted; among what remains a `match` outranks a
non-match, and within one identity class the smallest innovation wins.

Only `mismatch` removes a candidate. `unconfirmed`, `insufficient-evidence` and
`ambiguous` do not, because none of them is evidence _against_ a source — a
beacon that has gone quiet is not a beacon that is lying, and ending a track on
that basis would be worse than keeping it and saying so. `code-insufficient` is
the scenario that holds this to the line: the beacon stops signalling twenty
seconds in and the track survives at 0.96 retention with the verdict reported
honestly as unconfirmable.

Refusing the only admitted candidate does mean coasting, and coasting is the
intended failure. It is what happens at the centre of a decoy crossing, where
the two sources merge into one blob carrying two superimposed codes: the
correlation collapses, the merged detection is declined, and the estimator
coasts through rather than accepting a measurement it cannot attribute.

### RECOVER

Identity survives a short RECOVER by construction rather than by special case.
Histories are bounded by time, not cleared on a state change, so a gap shorter
than the window leaves the evidence intact and reacquisition is checked against
the same code the tracker was following. A longer gap expires it, and the
verdict has to be earned again.

The same association rule applies as in TRACK, with RECOVER's wider gates. A
decoy sitting in a wide recovery gate is refused on identity frame after frame
while the real beacon is looked for — visible in the telemetry as a rising
`identity_rejected` count with no measurement accepted.

## Measured results

Nine scenarios, 45 seconds each, identity switched on and off with nothing else
changed. Both arms are scored by the same evaluator from the same recorded
files. The harness is `identity-ablation.test.ts`, which asserts the conclusions
below rather than the exact numbers — a test that pinned 2 435 µrad would fail
on the next legitimate improvement, and a conclusion that only holds at one
value was never a conclusion.

| scenario             | arm    | RMS error (µrad) | retention | false-lock episodes | false-lock (s) | wrong recognitions |
| -------------------- | ------ | ---------------: | --------: | ------------------: | -------------: | -----------------: |
| `code-clean`         | off    |              315 |     1.000 |                   0 |              0 |                  — |
| `code-clean`         | **on** |              315 |     1.000 |                   0 |              0 |                  0 |
| `code-decoy-uncoded` | off    |              370 |     1.000 |                   1 |            0.1 |                  — |
| `code-decoy-uncoded` | **on** |            2 683 |     0.921 |               **0** |          **0** |                  0 |
| `code-decoy-easy`    | off    |              315 |     1.000 |                   0 |              0 |                  — |
| `code-decoy-easy`    | **on** |              315 |     1.000 |                   0 |              0 |                  0 |
| `code-decoy-wrong`   | off    |              498 |     0.975 |                   1 |            0.1 |                  — |
| `code-decoy-wrong`   | **on** |            2 905 |     0.919 |               **0** |          **0** |                  0 |
| `code-decoy-hard`    | off    |          361 636 |     0.235 |                   3 |           24.4 |                  — |
| `code-decoy-hard`    | **on** |        **2 435** | **0.922** |               **0** |          **0** |                  0 |
| `code-ambiguous`     | off    |          361 636 |     0.235 |                   2 |           24.4 |                  — |
| `code-ambiguous`     | **on** |           15 574 |     0.831 |                   2 |            0.4 |                 20 |
| `code-identical`     | off    |          361 635 |     0.235 |                   2 |           24.4 |                  — |
| `code-identical`     | **on** |          361 635 |     0.235 |                   2 |           24.4 |              1 271 |
| `code-insufficient`  | off    |              315 |     1.000 |                   0 |              0 |                  — |
| `code-insufficient`  | **on** |              453 |     0.963 |                   0 |              0 |                  0 |
| `code-frame-loss`    | off    |            5 066 |     0.726 |                   0 |              0 |                  — |
| `code-frame-loss`    | **on** |            5 066 |     0.726 |                   0 |              0 |                  0 |

Read across the whole table rather than at the headline row, because three
different things are happening in it.

**Where gating already worked, nothing changes.** `code-decoy-easy` puts a
brighter, uncoded decoy three and a half degrees off the beacon's bearing — far
outside the track gate. Phase 6's gating already rejected it, the two arms are
identical to the digit, and a phase that claimed credit for this case would be
overstating what a code buys.

**Where it works, it works decisively.** On `code-decoy-hard` — the Phase 7
geometry that defeated motion gating — identity turns a run that loses the
target for good into one that keeps it: retention 0.235 → 0.922, RMS error
361 636 → 2 435 µrad, and false lock eliminated rather than reduced. The
improvement holds on all five declared seeds, not just on the median.

**Where there is nothing to gain, it costs a little.** On `code-decoy-uncoded`
and `code-decoy-wrong` the control arm was already mostly fine — one brief false
lock each — and identity removes it at the price of a worse RMS error, 370 →
2 683 µrad. That cost is not the correlator being slow or wrong. It is the
merged blob: for about a second and a half around closest approach the two
emitters are inside one detection, the correlation collapses because the blob is
carrying two codes, and the tracker declines to accept a measurement it cannot
attribute. Coasting through a merge is the right behaviour and it is visibly not
free.

**Where it cannot help, it does not pretend to.** `code-identical` is the strict
negative control: the intruder sends the expected code at the expected phase, so
the two sources are the same signal from different objects. Identity ON and
identity OFF produce the same numbers to five significant figures. The 1 271
"wrong recognitions" are not a malfunction — the tracker claimed the source it
was holding is sending the expected pattern, and that claim was _true_ of the
decoy. There is no information in the light that separates them, and the design
does not invent any.

### Timing the receiver was not tuned for

Nothing in the receiver counts frames; it works in timestamps, exposures and
seconds. Retiming `code-clean` to 30, 60 and 90 frames per second, with symbols
scaled to four frames each, reaches MATCH at 0.932, 0.931 and 0.931
respectively. A design that had assumed the bundled 60 fps would have failed two
of the three and looked perfectly correct on the one it was written against.

Exposure length is the other axis, and it is where "integrate, do not sample"
becomes measurable. At two frames per symbol — the Nyquist floor — a 2 ms
exposure lands squarely inside symbols and scores 1.000. Opening the shutter to
16 ms against a 33 ms symbol makes a large share of exposures span a transition,
and the score falls to 0.964. The verdict holds, and the _fall itself_ is the
evidence: a receiver that evaluated the code at the capture instant would have
shown no change at all.

### Cost

Identity costs between 0.02 and 0.16 ms per frame against a 16.67 ms budget,
measured per stage with its own profiler entry. Measured a second way, as the
difference in whole-loop wall clock on `code-decoy-hard`: 1.834 ms per frame
with identity off, 1.895 ms with it on. The cost does not grow with the length
of a run — median 1.867 ms over the first ten seconds of tracking and 1.865 ms
thirty seconds later — because the histories are bounded.

## Known limitations

- **A rotation of the expected code is indistinguishable to an unlocked
  receiver.** Measured, not estimated: 15/15. A receiver that has locked the
  phase can separate them, because it is no longer searching the whole period;
  one that is still acquiring cannot.
- **Two sources sending the same code at the same phase cannot be separated at
  all**, by this or by any receiver watching the light. Identity abstains, and
  what is left is motion gating — the Phase 7 behaviour, which is the correct
  floor rather than a regression.
- **Only two length-15 m-sequences exist**, and they cross-correlate at 7/15.
  More mutually distinguishable codes need longer sequences and therefore longer
  observation.
- **The observable is not linear in the emitted level**, though this matters
  less than it first appears. As a source dims, fewer of its pixels clear the
  detector threshold, so integrated intensity falls faster than emission does —
  measured, a 1.82x change in emitted level produces a 3.0x change in integrated
  intensity. But the code is _binary_: emission takes only two values, and any
  monotone map of two points is exactly affine, which normalised correlation is
  invariant to. The distortion therefore costs nothing except on the small
  fraction of exposures that straddle a symbol transition and so see an
  intermediate level. At the default timing that is about 3% of frames.
- **Identity needs time.** Roughly half a second of continuous observation at the
  default settings. A target that appears and disappears faster than that is
  never confirmed, and is reported as `insufficient-evidence` rather than
  guessed at.
- **Crossings can transplant evidence.** See candidate histories above.
- **Two sources inside one blob are one source.** At closest approach in the
  decoy scenarios the two emitters are about 1.3 pixels apart against a
  point-spread sigma of 2.4, and the detector reports a single component whose
  brightness is the sum of two codes. The correlation collapses, the merged blob
  is refused, and the tracker coasts through the merge rather than accepting a
  measurement it cannot attribute. That is the right behaviour and it is not
  free: on `code-decoy-uncoded` and `code-decoy-wrong` it costs roughly one and
  a half seconds of coast and raises post-acquisition RMS error from about 370
  to about 2700 microradians, in exchange for eliminating the false lock. No
  receiver design recovers identity from a merged blob; only a longer focal
  length or a different geometry does.
- **A decoy that knows the code can imitate it.** There is no authentication
  here, only recognition: the code is not secret and carries no signature. This
  resists confusion, not a deliberate adversary.
- **No link budget.** Emitted levels are apparent intensities on `[0, 1]`, not
  radiometric quantities.
