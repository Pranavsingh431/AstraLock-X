# ADR-0024: The code is designed for the camera, not the other way round

## Status

Accepted (Phase 8).

## Context

A coded optical beacon invites a specific and very common mistake: specify the
beacon at a rate that sounds like real hardware — 10 kHz, say — and then read
"one bit per camera frame" at 60 fps.

That design cannot work, for three independent reasons.

**A camera integrates; it does not sample.** A frame is not a measurement of the
scene at an instant. Each pixel accumulates optical power across the whole
exposure and reports the total. A source switching many times inside one
exposure contributes its _average_, and that average is the same whatever the
bit pattern was. The modulation is not aliased or slowed — it is integrated
away.

**Sampling theory sets a hard ceiling.** Even for modulation an exposure could
resolve, a 60 Hz sampler represents nothing above 30 Hz. A 10 kHz square wave
observed at 60 fps produces a series indistinguishable from noise, and no
correlator recovers what is no longer there.

**"One bit per frame" silently redefines the beacon.** If the receiver takes one
symbol per frame then the symbol rate _is_ the frame rate, and "10 kHz" is a
description of hardware nobody is simulating. Reading a high-rate optical
carrier needs a photodiode and a fast receiver chain, an event camera, or a
sensor whose readout is synchronised to the modulation. Those are different
instruments producing different data, and this project models none of them.

## Decision

The code is designed for the camera that exists, and the constraint is enforced
rather than documented.

```
  symbolDuration >= 2 / frameRate          (Nyquist floor, enforced at load)
```

`validatedSimulationConfigSchema` **rejects** a scenario whose beacon symbols
are shorter than two camera frame periods. A physically unobservable code
cannot be loaded, let alone rendered into an image and correlated against.

The bundled default sits at four frames per symbol rather than two:

```
  frameRate      = 60 fps    ->  frame period  = 16.667 ms
  symbolDuration = 66.667 ms ->  4 frames per symbol, 15 symbols/s
  sequence       = 15 symbols ->  1.000 s per code period
```

Two frames per symbol is the floor, not a working point: dropped frames, sensor
noise and a target dimming below the detector threshold all remove samples, and
a design sitting exactly at Nyquist fails the first time it loses one.

Everything downstream follows from the exposure, not from a frame index: the
emitted contribution to a frame is the **integral** of the code over the
exposure window, and the receiver predicts against the same integral. Timestamps
drive the correlation throughout, so an irregular or gappy series still aligns.

## Consequences

**Good.**

- The claim "the camera can read this code" is checkable arithmetic rather than
  an assertion, and the checker runs at scenario load.
- The correlator works unchanged at 30, 60 and 90 fps, because nothing in it
  assumes a frame rate — only timestamps and exposures.
- Dropped frames need no special handling. There are no fabricated zero samples
  standing in for missing observations; there are simply fewer observations.

**Costs and risks.**

- **The data rate is tiny.** Fifteen symbols a second, one code period a second.
  This is an identity beacon, not a communications link, and describing it as a
  link would be a serious overstatement.
- **Long codes cost time.** More mutually distinguishable codes need longer
  sequences, and at 15 symbols/s a 63-symbol code takes 4.2 s per period. A
  system needing many codes needs a faster sensor, not a longer test.
- Only two length-15 m-sequences exist and they cross-correlate at 7/15. That
  measured floor, not taste, is why the match threshold is 0.65.
- A scenario author who wants full on-off keying can have it, and the beacon
  will then be undetectable during zero symbols. The schema permits it; the
  documentation says plainly what happens.

## Alternatives rejected

- **A high-frequency carrier with per-frame bit reads.** The failure above.
- **Modelling a photodiode or event camera alongside the imager.** A second
  sensor with its own timing, noise and alignment is a phase of work on its own,
  and inventing one to justify a faster code would be modelling the answer.
- **Sub-frame "virtual sampling" of the modulation.** It would mean the renderer
  reporting something the camera never produced.
