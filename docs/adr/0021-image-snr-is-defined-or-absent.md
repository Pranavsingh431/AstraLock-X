# ADR-0021: Image SNR is stated with its formula, or not stated at all

## Status

Accepted (Phase 7).

## Context

Phase 0 declared a `TargetObservation.snr` field and reported 0 dB for it. Phase
5 removed that, because nothing in the simulator modelled signal or noise and a
plausible-looking number for an unmodelled quantity is worse than an absent one.
It became `not-modelled`.

Phase 7 models both signal and noise, so a real figure is now available. The risk
is repeating the original mistake in a subtler form: "SNR" is not one quantity.
Its value depends on the aperture summed over, on whether the background counts
as signal, and on whether the ratio is of powers or of amplitudes. Two numbers
computed under different choices are not comparable, and neither is meaningful
without its definition.

## Decision

Image SNR is **evaluation-only**, and is defined:

```
  signal(p) = clean target contribution at p, above background, before noise
  noise(p)  = delivered(p) - noiseless(p)
  SNR_power = sum signal(p)^2 / sum noise(p)^2   over the aperture
  SNR_dB    = 10 log10(SNR_power)
```

- The **aperture** is a square box of a half-width carried in the _metrics
  definition_, not a constant in the evaluator, so two reports quoting SNR agree
  on what was summed.
- The noiseless image is rendered from the **same deterministic realization**
  with only the stochastic effects removed, so the difference is the noise field
  and nothing else — not a second draw, and not an estimate of noise from the
  noisy image.
- The background is computed analytically rather than rendered, because it is a
  pedestal plus a ramp. Counting it as signal would let a brighter sky improve
  the SNR.
- It is sampled at 4 Hz rather than every frame. Measuring it costs an extra
  render, and it is reported as a distribution.

**When it is undefined, it is absent.** With no stochastic noise the denominator
is zero; with no signal in the aperture the ratio is zero and its decibel value
is unbounded below. Both are reported as not measured — never as infinity, never
as a clamped floor, and never as 0 dB.

The algorithm never receives it.

## Consequences

**Good.**

- A number in a report can be checked against its definition.
- The Phase 5 correction is not quietly undone: a clean run still shows no SNR,
  because it still has none.
- The aperture is versioned with the metric definition, so rescoring an old run
  under a new definition is an explicit, separately fingerprinted act.

**Costs and risks.**

- One extra render per sampled frame, about 7 % of sensor cost at 4 Hz.
- The figure is in relative intensity counts, not calibrated radiometry. It is
  comparable between runs of this simulator and means nothing outside it.
- Sampling at 4 Hz means brief excursions can fall between samples. The
  distribution is over 4 Hz samples and is labelled as such.

## Alternatives rejected

- **Estimating noise from the delivered frame alone** (say, the variance of a
  dark corner). It would be an estimator with its own bias, and the simulator can
  simply render the answer.
- **Reporting infinity for a noiseless run.** It implies a measurement was taken
  and came back unbounded. Nothing was measured.
