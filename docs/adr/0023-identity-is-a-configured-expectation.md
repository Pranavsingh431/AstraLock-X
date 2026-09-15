# ADR-0023: The tracker is configured with a pattern, never told which source

## Status

Accepted (Phase 8).

## Context

Phase 7 measured the limit of tracking by appearance and motion. In
`dist-decoy-hard` a comparably bright intruder crosses close to the designated
target's predicted bearing; it passes the chi-square innovation gate because it
genuinely is where the target was expected, and it passes the score floor
because it genuinely is bright. AstraLock-X followed it for nearly forty
seconds of false lock.

That is not a tuning failure. A single frame does not contain the information
needed to separate two sources that look and move alike, so no threshold over
single-frame quantities can separate them.

Adding identity therefore means adding information. The question is **whose**
information, and this is where such a feature usually goes quietly wrong: it is
very easy to hand the tracker the answer and then measure how well it does.

## Decision

The terminal is configured with **the signalling pattern it expects the far end
to send**, and with nothing else.

| Configured on the tracker                      | Never reaches the tracker                |
| ---------------------------------------------- | ---------------------------------------- |
| the expected symbol sequence                   | which simulator entity is the target     |
| the symbol duration                            | the true code any emitter is sending     |
| its own thresholds, window and search settings | the true modulation phase                |
|                                                | any emitter, target or entity identifier |

Three consequences follow, and each is enforced rather than intended:

- **No levels.** The expected profile carries no `onIntensity` or
  `offIntensity`. A receiver has no business assuming how bright the far
  terminal is, and normalisation divides the amplitude out anyway.
- **No phase.** The transmitter's symbol clock is recovered by search. The
  simulator's phase is used only by tests, to check the recovered answer.
- **No identifiers anywhere in the observation path.** A candidate history holds
  a timestamp, an exposure, an image position and a brightness. There is no
  field that could carry a label, so none can be added by accident.

Being configured with an expected pattern is not ground truth in the same sense
that a radio configured with a frequency has not been told which transmitter is
which. Working out _which blob_ is sending the pattern remains the tracker's
problem, and it can still get it wrong.

## Consequences

**Good.**

- The comparison stays honest: identity ON and identity OFF differ only in the
  tracker's configuration, never in the physics or in what it is told.
- The failure modes are real and reachable. A rotation of the expected code is
  indistinguishable under a phase search (measured: 15/15), two sources that
  cross can have their histories transplanted, and a source that stops
  signalling stops being confirmable. All three are demonstrated rather than
  admitted.
- The anti-cheat test has something concrete to check: two worlds with different
  entity ids and the same pixel stream must produce identical behaviour.

**Costs and risks.**

- **This is recognition, not authentication.** The code is not secret and carries
  no signature. A decoy that knows the pattern can send it and will be accepted.
  Phase 8 resists confusion; it does not resist an adversary, and nothing here
  should be described as if it did.
- Identity costs time: roughly half a second of continuous observation before a
  verdict. A target seen more briefly is never confirmed.
- A terminal misconfigured with the wrong expected pattern will reject the
  correct source. That is the honest behaviour, and it is why identity is
  disabled by default.

## Alternatives rejected

- **Giving the tracker the emitter id, or the designated target index.** It
  would make every subsequent measurement meaningless.
- **Letting the tracker read the scenario's beacon configuration.** Same
  objection in a thinner disguise: the scenario says which source carries which
  code, and reading it is being told the answer.
- **Deriving the expected code from the brightest source at start-up.** It
  reduces to "follow the brightest thing", which is the baseline's rule and the
  behaviour being fixed.

## How the pattern actually reaches the tracker

Worth stating, because "configured with a pattern" can hide a channel.

In the application, the store reads the designated beacon's `identityCode` from
the scenario the operator loaded and puts the sequence and the symbol duration
into the algorithm's configuration when the runtime is built. In tests and the
ablation harness, the test does the same thing. Both are playing the part a
mission plan plays for a real terminal: you are told what your partner will
transmit before you attempt the link.

Two properties make that a configuration path rather than a channel. It happens
**once**, when the tracker is constructed, and never per frame — so nothing
about the running world can reach the algorithm through it. And what crosses is
two numbers that would be written on a mission card: a sequence of ones and
zeros, and a symbol duration. No position, no brightness, no phase, no
identifier, and nothing at all about any other source in the scene.

The anti-cheat suite holds the line where it matters: the same world with its
entities renamed produces a bit-identical run, and blank pixels produce no
verdict at all rather than a default one.
