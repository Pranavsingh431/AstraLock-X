# Capturing the submission screenshots

Exact settings for every image, so nobody has to hunt for the right state. Each
one is a real run reaching a real state — the wait is for the tracker, never a
forced value.

Five of the six are already captured and committed at
[`artifacts/sih/screenshots/`](../artifacts/sih/screenshots/), with provenance in
the index beside them. This guide is how to reproduce them, change one, or
capture the sixth.

## Before you start

- Run the app: `pnpm tauri:dev` for the desktop build, or `pnpm dev` and open
  `http://localhost:1420` for the frontend alone. The interface is identical;
  only durable storage differs, which matters for Reports and AstraBench results.
- Use **1920×1080** if you can. 1440×900 is the fallback.
- Leave **Engineering** view on unless a shot says otherwise, and leave the
  **Evaluation** overlay **off** — the tracker should be seen working without
  the answer key on screen.
- The **Operations** layout preset is the default and is right for all of these.
  **Presentation** enlarges the sensor feed and the twin if you want a cleaner
  hero; it changes layout only.
- Let the clock **pause** before capturing, so numbers are not mid-update.

Scenarios are grouped in the Scenario select; the group names below match.

---

## 1 — Hero · `01-mission-control-hero.png`

| Setting         | Value                                                                    |
| --------------- | ------------------------------------------------------------------------ |
| Workspace       | Mission Control                                                          |
| Scenario        | **AstraLock: handoff-eligible target** (PAT — motion, recovery, handoff) |
| Algorithm       | **AstraLock-X Reference PAT**                                            |
| Beacon identity | off                                                                      |
| Speed           | 4×                                                                       |
| Capture at      | t ≈ 15–20 s, once the chip reads **HANDOFF READY**                       |

Steps: select the scenario and algorithm → **Enable autonomy** → **Start** →
wait for HANDOFF READY → **Pause** → capture.

## 2 — Recovery · `02-recovery.png`

| Setting    | Value                                                                  |
| ---------- | ---------------------------------------------------------------------- |
| Scenario   | **AstraLock: brief loss and return** (PAT — motion, recovery, handoff) |
| Algorithm  | **AstraLock-X Reference PAT**                                          |
| Speed      | 2×                                                                     |
| Capture at | t ≈ 45–48 s, while the chip reads **RECOVER**                          |

The beacon disappears part-way through and returns near the prediction. RECOVER
lasts a couple of seconds, so pause as soon as the chip turns amber. The
estimator's angular uncertainty grows visibly while it coasts.

## 3 — Disturbance · `03-disturbance.png`

| Setting    | Value                                                                              |
| ---------- | ---------------------------------------------------------------------------------- |
| Scenario   | **Disturbance: combined stress** (Disturbance)                                     |
| Algorithm  | **AstraLock-X Reference PAT**                                                      |
| Speed      | 4×                                                                                 |
| Capture at | t ≈ 20–30 s, in **TRACK**, after the timeline shows at least one RECOVER excursion |

Scroll the right-hand diagnostics column to bring **Channel / Platform** into
view — it lists the effects actually acting. The sensor image should look
visibly noisy; that is the real frame, not a filter.

## 4 — Coded identity · `04-coded-identity.png`

| Setting         | Value                                                 |
| --------------- | ----------------------------------------------------- |
| Scenario        | **Identity: hard decoy, both coded** (Coded identity) |
| Algorithm       | **AstraLock-X Reference PAT**                         |
| Beacon identity | **on**                                                |
| Expected code   | **Code A · 15 symbols · 66.7 ms**                     |
| Speed           | 4×                                                    |
| Capture at      | t ≈ 18–22 s, in **TRACK**                             |

Steps: select the scenario and algorithm → tick **Recognise the beacon by its
code** → **Enable autonomy** → **Start** → wait for TRACK → **Pause** → switch
the telemetry dock to the **Identity** tab → scroll the diagnostics column to
**Beacon identity** → capture.

Look for **MISMATCH** in red on the decoy and **SELECTED · MATCH** in green on
the beacon. This is the strongest single frame in the submission.

To show the counter-case, untick the identity checkbox and re-run: the same
tracker on the same physics locks the decoy.

## 5 — AstraBench · `05-astrabench.png`

| Setting   | Value                           |
| --------- | ------------------------------- |
| Workspace | AstraBench                      |
| Suite     | **AstraBench Quick Validation** |

The preflight table — six cases, their scenarios, arms, declared seed, run count
and success rule — is the point: it shows the comparison was decided before it
was run.

For a **completed** suite you need the desktop build (a browser tab has nowhere
to write run artifacts). Press **Start benchmark** and wait about 45 s for the
12 runs, then capture the results table.

## 6 — Verified report · `06-reports-verified.png`

**Needs the desktop build.** See the blocker and the full step list at the end of
[`artifacts/sih/screenshots/README.md`](../artifacts/sih/screenshots/README.md).

In short: record an experiment on `code-decoy-hard` with identity on, stop it,
open **Reports**, select the run, and press **Recompute & verify**. The result
should say recomputation reproduces every field of the stored summary.

---

## What not to do

- Do not force a PAT state, a MATCH verdict or a verification result. Wait for
  the tracker.
- Do not capture with the **Evaluation** overlay on unless the point of the
  image is the truth boundary itself — it is the answer key, and it is labelled
  as such.
- Do not crop out the diagnostics to make an image tidier. The density is the
  product.
