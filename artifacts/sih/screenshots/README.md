# Screenshot index

Provenance for every image here. All five were captured from the **browser
development frontend** (`pnpm dev`, `http://localhost:1420`) driven by
Playwright, at a 1920×1080 viewport with `deviceScaleFactor: 2`, so each PNG is
3840×2160 and stays sharp when scaled into a slide.

**Not** captured from the native Tauri shell. The React frontend is byte-for-byte
the same in both; the native shell could not be launched on the capture machine
because Rust cannot link there — see the blocker note at the end.

Every image is real application state. The capture script drove the same
controls a person would — the scenario select, the algorithm select, the
identity checkbox, Enable autonomy, Start — and then waited for the tracker's
own PAT state to appear in the title bar before taking the picture. No state was
written into the store, no telemetry was injected, and no PAT state, MATCH
verdict or verification result was forced.

---

## 01-mission-control-hero.png

|                 |                                                                                              |
| --------------- | -------------------------------------------------------------------------------------------- |
| Scenario        | `astralock-handoff` — "AstraLock: handoff-eligible target"                                   |
| Algorithm       | AstraLock-X Reference PAT                                                                    |
| Beacon identity | off                                                                                          |
| PAT state       | **HANDOFF READY** (2.1 s dwell)                                                              |
| Simulation time | 15.84 s, clock paused                                                                        |
| Truth overlays  | evaluation overlay **off**; the 3D twin is shown and is labelled as the engineering observer |
| View mode       | Engineering                                                                                  |

**Demonstrates:** the whole workstation in its strongest state — white chrome
around a dark sensor feed and a dark 3D engineering viewport, the real detector
output, live IMM model probabilities (CV 0.93 / CA 0.07), commanded-vs-measured
mount angles, and a PAT timeline built from the state machine's own transitions.

## 02-recovery.png

|                 |                                                             |
| --------------- | ----------------------------------------------------------- |
| Scenario        | `astralock-short-loss` — "AstraLock: brief loss and return" |
| Algorithm       | AstraLock-X Reference PAT                                   |
| PAT state       | **RECOVER**, recovery age 0.95 s                            |
| Simulation time | 45.95 s, clock paused                                       |
| Truth overlays  | evaluation overlay off                                      |
| View mode       | Engineering                                                 |

**Demonstrates:** the tracker coasting through a real loss of the beacon. The
detector reports no detection and 57 consecutive misses; the estimator's angular
uncertainty has grown to 0.2659° and the sensor feed shows the prediction with
its uncertainty ring; the timeline shows the amber RECOVER segment appearing at
the end of a TRACK run. The tracker entered RECOVER on its own — the capture
waited for it.

## 03-disturbance.png

|                 |                                                        |
| --------------- | ------------------------------------------------------ |
| Scenario        | `dist-combined` — "Disturbance: combined stress"       |
| Algorithm       | AstraLock-X Reference PAT                              |
| PAT state       | **TRACK**                                              |
| Simulation time | 24.77 s, clock paused                                  |
| Truth overlays  | evaluation overlay off; disturbance realization hidden |
| View mode       | Engineering                                            |

**Demonstrates:** vibration, attenuation, sensor noise and frame dropout acting
together. The sensor image is visibly noisy and dimmed, and the timeline shows
the tracker losing lock into RECOVER and returning to TRACK under that load. The
Channel / Platform panel is scrolled into view and lists only the effects that
are actually active.

## 04-coded-identity.png

|                 |                                                            |
| --------------- | ---------------------------------------------------------- |
| Scenario        | `code-decoy-hard` — "Identity: hard decoy, both coded"     |
| Algorithm       | AstraLock-X Reference PAT                                  |
| Beacon identity | **on**, expected profile **Code A · 15 symbols · 66.7 ms** |
| PAT state       | **TRACK**                                                  |
| Simulation time | 19.57 s, clock paused                                      |
| Truth overlays  | evaluation overlay off                                     |
| View mode       | Engineering                                                |

**Demonstrates:** the headline differentiator. Two optical candidates are in the
frame, both modulating. The overlay marks one **MISMATCH** in red and the other
**SELECTED · MATCH** in green; the detector reports 2 candidates with 1 rejected
by the gate; the telemetry dock plots the real code-correlation series against
its thresholds. No simulator target identifier appears anywhere in the
algorithm-side panels, because the tracker is not given one.

## 05-astrabench.png

|                                   |                                                  |
| --------------------------------- | ------------------------------------------------ |
| Workspace                         | AstraBench                                       |
| Suite                             | AstraBench Quick Validation (`quick-validation`) |
| Cases / seeds / algorithms / runs | 6 / 9101 / 2 / 12                                |
| State                             | preflight — the plan, before execution           |

**Demonstrates:** that the comparison is decided before it is run. Each of the
six cases shows its scenario, its two arms, its declared seed, its run count and
what counts as success for it. The banner is honest: a browser tab has nowhere
durable to write run artifacts, so the suite is executed on the desktop build or
headlessly.

The completed results for this exact suite were generated headlessly and are
stored at `artifacts/sih/evidence/quick-validation.json` — 12/12 runs completed,
suite fingerprint `suite:sha256:a87ed252…`, tabulated in
[`docs/PPT_EVIDENCE.md`](../../../docs/PPT_EVIDENCE.md).

---

## 06-reports-verified.png — NOT CAPTURED

**Intended:** a completed experiment in the Reports workspace showing scenario,
algorithm, acquisition time, tracking error, retention and processing time, with
**VERIFIED · 0 DIFFERENCES** after pressing _Recompute & verify_.

**Blocker.** The Reports workspace reads recorded runs from durable storage,
which exists only in the Tauri desktop build; in a browser tab the storage is
`UnavailableStorage` and the workspace correctly says so. The desktop build
could not be launched on the capture machine: `cargo check` fails at the link
step with _"You have not agreed to the Xcode license agreements"_, so the Rust
side cannot compile locally. The fix needs the machine owner's password
(`sudo xcodebuild -license`), so it was not attempted.

**The verification itself is not blocked, only the screenshot of it.** Both
headline experiments were recorded and then recomputed from their own raw event,
telemetry and evaluation files, and matched the stored summary in every field —
**0 differences**, recorded in `artifacts/sih/evidence/experiments.json`.

**To capture it manually**, on a machine where Rust links:

1. `sudo xcodebuild -license` and accept, then `pnpm tauri:dev`.
2. Mission Control → Scenario **Identity: hard decoy, both coded**
   (`code-decoy-hard`), Algorithm **AstraLock-X Reference PAT**.
3. Tracking → tick **Recognise the beacon by its code**; leave Expected code on
   **Code A · 15 symbols · 66.7 ms**.
4. Open the **Experiment** group in the control rail and press **Start
   experiment**.
5. Press **Enable autonomy**, then **Start**, and let it run to about t = 40 s.
6. Press **Stop experiment** (or let the scenario duration finalise it).
7. Go to **Reports**, select the run that just appeared, and press
   **Recompute & verify**.
8. Capture at 1920×1080 once the notice reads that recomputation reproduces
   every field of the stored summary.
