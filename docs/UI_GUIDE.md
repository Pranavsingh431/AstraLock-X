# The AstraLock-X interface

This describes how the workstation is put together and — more usefully — the
rules it follows, so that a panel added later looks and behaves like the ones
already there.

It is a design guide, not a tour. For what the application _does_, start at
[ARCHITECTURE.md](ARCHITECTURE.md).

---

## 1. What this interface is for

AstraLock-X is an engineering workbench for coarse pointing, acquisition and
tracking. Its users are people deciding whether a tracker works, why it failed,
and whether a measurement can be quoted. Everything below follows from that.

Three consequences worth stating outright:

- **Density beats comfort.** A control row is 28–36 px, a panel header 10 px
  upper-case, a readout 11–13 px. A screen that shows twelve real quantities is
  more useful than one that shows four beautifully.
- **Nothing is on screen that is not measured.** No system-health percentage, no
  progress bar that is not tracking a real count, no plausible resting value in
  a field the software has not computed. If a number does not exist, the panel
  shows an em dash and says why.
- **Privileged data is unmistakable.** The simulator knows the answer; the
  tracker does not. Anything drawn from the simulator's own knowledge is
  violet-edged, labelled, and can be switched off entirely.

---

## 2. Colour

Colours are named by meaning, never by hue, and defined once in
`src/styles/globals.css` as OKLCH tokens.

| Token               | Used for                                                         |
| ------------------- | ---------------------------------------------------------------- |
| `--status-active`   | cyan: the primary accent, a live or selected state               |
| `--status-nominal`  | emerald: a good state the system has actually confirmed          |
| `--status-degraded` | amber: a real degraded condition, and RECOVER                    |
| `--status-fault`    | red: a real failure, and recording                               |
| `--status-idle`     | grey: off, unknown, not applicable                               |
| `--truth`           | violet: **privileged** — ground truth, simulator interior, debug |
| `--panel`           | panel body                                                       |
| `--panel-header`    | panel header, one step lighter                                   |
| `--panel-border`    | every 1 px division in the application                           |

Two rules about them:

**Colour never carries meaning alone.** Every status chip spells its own name.
A screenshot has to survive being printed in grayscale, projected through a
blue-cast projector, and read by someone with deuteranopia, and in all three
cases the words still work.

**Violet means privileged, everywhere, and nothing else is violet.** It is the
one colour with a hard reservation. `PanelTone = 'truth'` gives a panel a violet
border, a violet header and a violet wash; a reader can therefore answer "is
this the tracker's belief or the answer key?" from across the room.

The light theme (`.theme-light`) redefines the same tokens and nothing else.

---

## 3. The design system

`src/components/astra/` is a small set of primitives, not a component library.
Its entire purpose is that four workspaces built at different times still look
like one instrument.

| Primitive                                  | What it settles                                           |
| ------------------------------------------ | --------------------------------------------------------- |
| `Panel` / `PanelHeader` / `PanelBody`      | the one container; tone declares provenance               |
| `Section`                                  | a labelled group inside a panel                           |
| `MetricReadout`                            | a labelled value that always carries its unit             |
| `DiagnosticRow`                            | the same, stacked rather than gridded                     |
| `StatusBadge`                              | the closed set of statuses, with a word and a colour      |
| `ProportionBar`                            | a fraction on [0, 1] that the software actually reports   |
| `EmptyState` / `WarningBanner`             | absence and trouble, said plainly                         |
| `EngineeringTable` and friends             | real `<table>` markup, numerics tabular and right-aligned |
| `ChartFrame` / `ChartTooltip`              | a plot's title, unit, legend and caveat                   |
| `PAT_STATE`                                | how each PAT state is named and coloured — once           |
| `ResizeHandle`, `SplitGroup`, `SplitPanel` | the resizable layout                                      |

Rules the primitives enforce rather than document:

- **Every value carries a unit.** `MetricReadout` takes `unit` beside `value`,
  in separate elements so the number is tabular and the unit is not.
- **`null` renders as an em dash in muted italic. Never `0.000`.** A zero is a
  measurement; absence is not.
- **`Status` is a closed union** — `nominal | active | degraded | recovering |
limited | fault | idle`. There is deliberately no aggregate "system health":
  the application has no basis for one, and a single percentage over seconds,
  microradians and a retention fraction would be invented.
- **A long hint becomes a tooltip.** Hints under ~24 characters stay on the face
  of the readout; longer ones move to `title`, because "Aperture photomet…"
  helps nobody.

### Typography

One family for prose, one monospace for numbers. Every numeric uses
`font-variant-numeric: tabular-nums` (the `.tabular` utility), so a column of
figures lines up and a changing value does not jitter. Panel headers and status
chips are 9–10 px upper-case with `0.08em` tracking — an instrument label rather
than a heading in a document.

### Motion

Interface feel only, 120–250 ms: a panel body rising into place (`astra-rise`,
160 ms), a chip fading between states. Two exceptions earn a pulse — RECOVER and
a live recording — because they are states an operator must not miss.

**Telemetry never animates.** Chart lines are `type="linear"`,
`isAnimationActive={false}`, `dot={false}`, `connectNulls={false}`: a servo that
overshoots shows its overshoot, a gap stays a gap, and no curve is invented
between two samples.

Everything is disabled under `prefers-reduced-motion: reduce`, globally, in
`globals.css`.

---

## 4. The shell

```
┌────┬──────────────────────────────────────────────┐
│    │ title bar — product, workspace, run, state   │
│rail├──────────────────────────────────────────────┤
│    │ the active workspace                         │
│    ├──────────────────────────────────────────────┤
│    │ status bar — build, clock, seed, view mode   │
└────┴──────────────────────────────────────────────┘
```

**The workspace rail** names all six workspaces rather than relying on icons,
marks the current one three ways (a cyan leading bar, a lighter ground, and
`aria-current="page"`), and dims the ones that are not implemented without
hiding them — each of those opens and says what it will do and what has to exist
first.

**The title bar** is the one thing visible in every workspace. It answers "what
is this a screenshot of?" without being told: scenario, tracker, simulated time,
clock state, PAT state, and whether anything privileged is on screen. The PAT
state is repeated here and on the sensor feed deliberately — it is the single
most consequential fact in the application.

**The status bar** is build and run facts only: version, Vite mode, host, `t`,
tick, frame count, dropped frames, root seed, and the view mode. The seed is the
whole reproducibility claim in one field.

---

## 5. Mission Control

Four resizable regions, each with a minimum size, each scrolling internally:

```
┌────────┬──────────────────────┬─────────────┐
│        │  sensor feed         │ detector    │
│controls├──────────────────────┤ estimator   │
│        │  3D digital twin     │ controller  │
│        ├──────────────────────┤ identity    │
│        │  telemetry           │ channel     │
└────────┴──────────────────────┴─────────────┘
```

**The sensor feed is the hero, and it is the only honest one.** It is the
largest panel by default because it is the only thing on screen that a tracking
algorithm actually receives. Three overlay layers, RAW and ALGORITHM on by
default, EVALUATION off:

| Layer      | What it draws                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------ |
| RAW        | the frame, as `mono8` pixels                                                                                       |
| RETICLE    | the boresight: a broken crosshair, two reference circles, corner marks                                             |
| ALGORITHM  | what the tracker found — every candidate, the selected one, the filter's prediction, and its one-sigma uncertainty |
| EVALUATION | **privileged.** The true projected centre. Off by default, violet, and labelled `debug only` whenever it is on     |

Overlay semantics are consistent wherever they appear. An unselected candidate
is a small hollow circle; the selected one gets a box and a filled centroid mark.
MATCH is emerald, MISMATCH red, AMBIGUOUS amber. The prediction is a cyan circle
drawn even on a frame with no detection — that is the coast, and seeing it is how
an operator tells "lost it" from "still believes it is there". Around it, a
dashed ring is the estimator's own one-sigma angular uncertainty projected to
pixels through the believed calibration, so it grows while the tracker coasts
and shrinks on a detection. None of these marks ever says TARGET, because nothing
on the tracking side knows which source is the target.

**The 3D twin is labelled `GROUND TRUTH / ENGINEERING OBSERVER`**, is
violet-toned, carries a TRUTH chip, and says in its subtitle that it is not the
sensor feed. It shows where everything really is; no algorithm sees it.

**The diagnostics column reads top to bottom as the signal chain**: detector →
estimator → controller → identity → channel. When a run goes wrong, that is the
order in which to look.

**The telemetry dock** is tabbed rather than stacked, because six live plots
cost six times as much and nobody reads six at once. The PAT timeline is built
from the state machine's own recorded transitions, not from the current mode —
segment widths are real durations, so a two-frame excursion into RECOVER is two
frames wide.

### Layout presets

Three, and they change **layout only**: operations, analysis, presentation. A
preset moves dividers. It does not touch the simulation, the tracker, the
telemetry, or what is hidden — and the presentation layout keeps the diagnostics
visible, because a presentation that dropped them would be presenting a
different product from the one that exists.

---

## 6. Engineering view and flight-representative view

One control, in the title bar, applying everywhere.

**Engineering view** (the default, because this is an engineering workbench)
allows privileged panels: the ground truth overlay, the 3D twin, the actuator
interior, the disturbance realization, the true pointing error, the ground truth
inspector.

**Flight-representative view** removes all of them at once. What is left is only
what the terminal's own software could compute from pixels, the believed
calibration and the measured mount state.

Two properties make the pair worth having:

1. **It gates drawing only.** Nothing is computed differently, recorded
   differently, or fed to any algorithm differently. The same run produces the
   same numbers either way — `workstation.test.tsx` asserts this against a live
   run rather than trusting it.
2. **It is reversible without loss.** The individual panel toggles are untouched;
   the mode is a gate above them. Switching back restores exactly what was there.

Privileged panels are _absent_ rather than disabled in flight view: a greyed-out
control still tells the reader that an answer key exists behind it.

---

## 7. States and empties

The PAT states, as the whole application names them (`PAT_STATE`, one table):

| Internal    | Shown         | Status     |
| ----------- | ------------- | ---------- |
| `idle`      | IDLE          | idle       |
| `scan`      | SEARCH        | active     |
| `acquire`   | ACQUIRE       | active     |
| `track`     | TRACK         | nominal    |
| `handoff`   | HANDOFF READY | nominal    |
| `reacquire` | RECOVER       | recovering |
| `lost`      | LOST          | fault      |
| `fault`     | FAULT         | fault      |

Three of the words differ from the internal name on purpose. `scan` reads as a
sensor mode rather than a phase. `reacquire` is longer than what it is doing.
And `handoff` is a claim about _readiness_, not about fine pointing — no
fine-pointing actuator exists, and the interface must not imply one.

**Empty states say why, not just that.** "No IMM to plot. Model probabilities
come from AstraLock-X; the baseline runs a single constant-velocity model and
reports none." is a fact about the system. "No data" is a shrug.

---

## 8. Performance

The engine appends telemetry at about 60 Hz. Two rules keep that from turning
into sixty dashboard renders a second:

- **Charts subscribe through a throttled `useSyncExternalStore`.** The store is
  read directly; the _subscription_ wakes React at about 8 Hz. That is a refresh
  rate for a display, not a decimation of the data — every sample is in the
  series that gets drawn. The trailing timer always fires, so the last sample of
  a run, or one produced by stepping while paused, still reaches the plot.
- **State that has not changed keeps its identity.** `appendPatInterval` returns
  the same array when the mode is unchanged, so a 60 Hz append does not
  invalidate a selector that only cares about transitions.

Numeric readouts do update at full rate. They are cheap, and a laggy number on
an instrument is worse than a busy one.

---

## 9. Accessibility

- Every control has an accessible name that stands alone. A chip may read
  "Evaluation"; its `aria-label` reads "Ground truth sensor overlay".
- Toggles carry `aria-pressed`, tabs are real Radix tabs with roving focus, the
  rail is a `nav` with `aria-current`, and the status bar is `contentinfo`.
- Headings nest: the workspace name is the `h1` in the title bar, panels are
  `h2`. A screen reader can move through the workstation by structure.
- `:focus-visible` draws a 2 px cyan outline everywhere, and it is never removed.
- Tables are `<table>` markup with `<th>` row headers, not grids of `<div>`.
- The PAT timeline carries a full `aria` description of its segments, because
  a proportional bar is meaningless to a screen reader otherwise.

---

## 10. Adding a panel

1. Wrap it in `Panel` + `PanelHeader`. Set `tone="truth"` if it draws on
   privileged state, and gate it with `usePrivilegedVisible`.
2. Use `MetricReadout` / `DiagnosticRow`. Pass `null`, not `0`, when the value
   does not exist. Always pass the unit.
3. Pick a status from the closed union. If none of the seven fits, the panel is
   probably claiming something the system cannot support.
4. Give it an `EmptyState` that explains the absence.
5. If it plots, use `ChartFrame`, read telemetry through `useTelemetry`, and
   leave `connectNulls` false.
