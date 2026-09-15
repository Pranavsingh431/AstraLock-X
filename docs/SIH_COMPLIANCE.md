# SIH requirement matrix

What the problem statement asks for, and what this prototype actually does
today. Anything not complete is marked **PARTIAL** with the reason.

Figures come from runs executed against the current code and stored under
[`artifacts/sih/evidence/`](../artifacts/sih/evidence/) — see
[PPT_EVIDENCE.md](PPT_EVIDENCE.md) for the numbers and their provenance.

| #   | Requirement                                 | Status                | Where it lives                                                                                                                                                                                                                  |
| --- | ------------------------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Configurable virtual environment            | **Implemented**       | 35 bundled scenarios; every parameter is a validated `SimulationConfig` document that can be exported and re-imported. Scenario Lab edits the physical scenario.                                                                |
| 2   | Moving targets                              | **Implemented**       | Stationary, linear, circular, sinusoidal, waypoint and seeded-manoeuvre trajectories, in ENU with a declared frame (ADR-0006).                                                                                                  |
| 3   | Movable virtual camera / gimbal             | **Implemented**       | Two-axis pan/tilt with servo dynamics, transport latency, deadband, backlash, torque limits and encoder quantisation. Commanded and measured angles are separate everywhere.                                                    |
| 4   | Beacon detection                            | **Implemented**       | Real detector over the rendered `mono8` frame: thresholding, connected components, sub-pixel centroid, aperture-photometry SNR.                                                                                                 |
| 5   | Tracking                                    | **Implemented**       | Two algorithms — a baseline KF + PID control arm, and AstraLock-X with an IMM estimator, NIS gating, coasting and recovery.                                                                                                     |
| 6   | Control / repositioning                     | **Implemented**       | Closed loop at the sensor frame rate; prediction to the actuation instant over the configured command latency plus modelled servo lag (ADR-0013).                                                                               |
| 7   | Turbulence, vibration, camera motion, noise | **Implemented**       | Ten modelled effects: platform vibration tones and jitter, atmospheric attenuation, scintillation, angular wander, exposure, defocus, background, read noise, shot noise, frame dropouts. Frame-indexed realization (ADR-0020). |
| 8   | Real-time statistics                        | **Implemented**       | Mission Control shows detector, estimator, controller, identity and channel state live, plus telemetry plots and a PAT state timeline built from recorded transitions.                                                          |
| 9   | Simulation duration                         | **Recorded**          | `simulationDurationSeconds` in every run summary.                                                                                                                                                                               |
| 10  | FPS                                         | **Recorded**          | `configuredSensorFps`, `effectiveSensorFps`, `algorithmProcessedFps`.                                                                                                                                                           |
| 11  | Acquisition time                            | **Recorded**          | `timeToFirstDetection`, `timeToTrack`, `coarseAcquisitionTime`.                                                                                                                                                                 |
| 12  | Average / max tracking error                | **Recorded**          | `angularPointingError` over three windows (whole run, post-acquisition, track-state), each with mean, RMS, median, p95 and max.                                                                                                 |
| 13  | Lock retention                              | **Recorded**          | `lockRetentionRate` with an explicit status, plus loss episodes, unrecovered losses and reacquisition times.                                                                                                                    |
| 14  | Processing time                             | **Recorded**          | `hostProcessingTime` broken down by stage: world step, sensor frame generation, detector, bearing transform, estimator, controller, identity correlator, orchestration.                                                         |
| 15  | Source code                                 | **Provided**          | This repository, MIT-licensed, with ADRs and per-subsystem documentation.                                                                                                                                                       |
| 16  | Performance report                          | **Generated offline** | Markdown report written next to each run's artifacts; the Reports workspace recomputes every field from the raw event, telemetry and evaluation files and reports the differences.                                              |

## Beyond the requirement

Three things the problem statement does not ask for, included because they are
what make the measurements trustworthy:

- **Ground-truth isolation, enforced five ways.** A tracking algorithm receives
  pixels, its own believed calibration and the measured mount state — nothing
  else. Compile-time proofs, an admission function, an ESLint import barrier, a
  runtime guard and type-level tests each independently prevent a tracker
  reaching simulator truth (ADR-0003).
- **Deterministic benchmarking.** AstraBench flies every arm of a case against
  identical physics — same scenario, same seed, same disturbance realization —
  checked by fingerprint. A case whose arms disagree is reported invalid rather
  than reduced to a winner.
- **Recomputable results.** Every stored summary can be regenerated from the
  raw files. A number that cannot be reproduced from the record is not a result.

## Marked PARTIAL

| Item                     | Status              | Why                                                                                                                                                                                     |
| ------------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Hardware-in-the-loop     | **Not implemented** | Out of scope for this prototype. The algorithm plugin contract was designed so a real camera and gimbal can be substituted without touching tracking code, but no hardware path exists. |
| Replay workspace         | **Not implemented** | The event log that would drive it is recorded; the viewer is future work and the workspace says so.                                                                                     |
| Calibration workspace    | **Not implemented** | Intrinsics and camera-to-gimbal alignment are configured rather than estimated. The workspace says so.                                                                                  |
| Fine-pointing stage      | **Not modelled**    | AstraLock-X reports HANDOFF READY — a readiness claim only. No fine-pointing actuator is simulated and the interface never implies one.                                                 |
| Statistical significance | **Not claimed**     | The suite whose numbers are quotable uses five declared seeds. That is a small sample, and no significance test is offered.                                                             |
