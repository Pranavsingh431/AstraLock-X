/**
 * Scenario Lab: the disturbance editor.
 *
 * The first genuinely functional subset of this screen, built for Phase 7 and
 * deliberately not the final design. It edits the **physical scenario**, never
 * an algorithm's configuration: a tracker does not get to choose the weather it
 * is tested in.
 *
 * Two rules the controls enforce rather than assume:
 *
 *  - **Editing is refused while a run is recording.** Changing the physics under
 *    an open experiment would splice two different worlds into one record. The
 *    controls disable and say why, rather than silently rebuilding the session.
 *  - **A preset populates the controls and is then irrelevant.** Every parameter
 *    is written into the scenario document; the preset name is kept only as
 *    provenance, so a run stays fully described even if the preset is later
 *    retuned or deleted.
 *
 * Units are engineering units throughout — degrees for angles a person has to
 * reason about, hertz, seconds, dB/km, intensity counts — with the conversion to
 * the stored radians done here rather than in the operator's head.
 */

import { useMemo, useState } from 'react';
import { Waves } from 'lucide-react';

import type { DisturbanceConfig } from '@/core/contracts/disturbance';
import { isCleanDisturbance } from '@/core/contracts/disturbance';
import { DISTURBANCE_PRESETS, PRESET_NAMES } from '@/core/disturbance';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Separator } from '@/components/ui/separator';
import { useSimulationStore } from '@/stores/simulation-store';

const DEG = Math.PI / 180;

/**
 * A disturbance configuration whose top-level branches can be replaced.
 *
 * The stored configuration is deeply readonly, which is right: a scenario is a
 * record, not a scratchpad. Edits here work on a structured clone and replace
 * whole branches rather than mutating in place, so this alias only has to lift
 * the outermost `readonly`.
 */
type Draft = { -readonly [K in keyof DisturbanceConfig]: DisturbanceConfig[K] };

/** A labelled numeric control in engineering units. */
function Field({
  label,
  hint,
  value,
  step,
  min,
  max,
  suffix,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  value: number;
  step: number;
  min: number;
  max: number;
  suffix: string;
  disabled: boolean;
  onChange: (value: number) => void;
}): React.JSX.Element {
  return (
    <label className="flex items-baseline justify-between gap-3 py-1" title={hint}>
      <span className="text-[11px] text-muted-foreground">{label}</span>
      <span className="flex items-baseline gap-1">
        <input
          type="number"
          aria-label={label}
          className="tabular h-6 w-24 rounded-sm border bg-background px-1.5 text-right text-[11px] disabled:opacity-40"
          value={Number.isFinite(value) ? value : 0}
          step={step}
          min={min}
          max={max}
          disabled={disabled}
          onChange={(event) => {
            const next = Number(event.target.value);
            if (Number.isFinite(next)) onChange(next);
          }}
        />
        <span className="w-16 text-[10px] text-muted-foreground">{suffix}</span>
      </span>
    </label>
  );
}

function Toggle({
  label,
  hint,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}): React.JSX.Element {
  return (
    <label className="flex items-center gap-2 py-1" title={hint}>
      <input
        type="checkbox"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <span className="text-[11px]">{label}</span>
    </label>
  );
}

function Group({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <section className="space-y-0.5 rounded-sm border p-3">
      <h3 className="text-[10px] font-semibold tracking-wider text-sky-400 uppercase">{title}</h3>
      {children}
    </section>
  );
}

export function ScenarioLabView(): React.JSX.Element {
  const config = useSimulationStore((state) => state.config);
  const setDisturbances = useSimulationStore((state) => state.setDisturbances);
  const recording = useSimulationStore((state) => state.recorderStatus?.state === 'running');
  const [error, setError] = useState<string | null>(null);

  const disturbances = config.disturbances;
  const clean = useMemo(() => isCleanDisturbance(disturbances), [disturbances]);

  /** Applies a change, unless a recording is open. */
  const edit = (next: DisturbanceConfig): void => {
    if (recording) {
      setError(
        'Stop the recording first. Changing the physics mid-run would splice two different experiments into one record.',
      );
      return;
    }
    setError(null);
    // A hand edit no longer matches whatever preset populated the form, and
    // saying it does would misdescribe the run. The parameters are the record.
    setDisturbances({ ...next, preset: null });
  };

  const patch = (mutate: (draft: Draft) => void): void => {
    const draft = structuredClone(disturbances) as Draft;
    mutate(draft);
    edit(draft);
  };

  const azimuthTone = disturbances.platform.tones.find((tone) => tone.axis === 'azimuth');

  return (
    <div className="h-full overflow-y-auto p-4">
      <header className="mb-3 flex items-center gap-2">
        <Waves aria-hidden className="size-4 text-sky-400" />
        <h2 className="text-sm font-semibold">Scenario Lab — disturbances</h2>
        <Badge variant="outline" className="text-[10px] uppercase">
          {clean ? 'clean' : 'disturbed'}
        </Badge>
        {disturbances.preset !== null && (
          <Badge
            variant="outline"
            className="text-[10px] uppercase"
            title="Provenance only. The parameters below are the record, not this name."
          >
            {disturbances.preset}
          </Badge>
        )}
      </header>

      <p className="mb-3 max-w-3xl text-[11px] leading-relaxed text-muted-foreground">
        These are properties of the <strong>physical scenario</strong>, not of a tracking algorithm.
        Neither algorithm can read any of them; both experience all of it as pixels. A preset fills
        the fields in and is then irrelevant — every value is written into the scenario and
        fingerprinted with it. See <code>docs/DISTURBANCE_MODEL.md</code> for the equations.
      </p>

      {recording && (
        <p className="mb-3 rounded-sm border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-[11px] text-amber-300">
          An experiment is recording. The controls are locked so the physics cannot change under an
          open record.
        </p>
      )}
      {error !== null && (
        <p className="mb-3 rounded-sm border border-destructive/40 bg-destructive/10 px-3 py-2 text-[11px]">
          {error}
        </p>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <span className="text-[11px] text-muted-foreground">Presets:</span>
        {PRESET_NAMES.map((name) => (
          <Button
            key={name}
            size="sm"
            variant="outline"
            className="h-7 text-[10px]"
            disabled={recording}
            onClick={() => {
              if (recording) {
                setError('Stop the recording first.');
                return;
              }
              setError(null);
              setDisturbances(structuredClone(DISTURBANCE_PRESETS[name]));
            }}
          >
            {name}
          </Button>
        ))}
      </div>

      <Separator className="mb-4" />

      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        <Group title="Platform motion">
          <Toggle
            label="Enabled"
            hint="Motion of the structure the gimbal is bolted to. The encoder cannot measure it, so it appears only as image motion."
            checked={disturbances.platform.enabled}
            disabled={recording}
            onChange={(checked) => {
              patch((draft) => {
                draft.platform = { ...draft.platform, enabled: checked };
              });
            }}
          />
          <Field
            label="Tone amplitude"
            hint="Peak angular amplitude of the azimuth vibration tone."
            value={Number((((azimuthTone?.amplitude ?? 0) as number) / DEG).toFixed(4))}
            step={0.005}
            min={0}
            max={5}
            suffix="deg peak"
            disabled={recording}
            onChange={(value) => {
              patch((draft) => {
                draft.platform = {
                  ...draft.platform,
                  tones: [
                    {
                      axis: 'azimuth',
                      amplitude: (value * DEG) as never,
                      frequency: (azimuthTone?.frequency ?? 5) as never,
                      phase: 0 as never,
                    },
                    ...draft.platform.tones.filter((tone) => tone.axis === 'elevation'),
                  ],
                };
              });
            }}
          />
          <Field
            label="Tone frequency"
            hint="Frequency of the azimuth vibration tone."
            value={Number(((azimuthTone?.frequency ?? 5) as number).toFixed(2))}
            step={0.5}
            min={0.1}
            max={60}
            suffix="Hz"
            disabled={recording}
            onChange={(value) => {
              patch((draft) => {
                draft.platform = {
                  ...draft.platform,
                  tones: [
                    {
                      axis: 'azimuth',
                      amplitude: (azimuthTone?.amplitude ?? 0.03 * DEG) as never,
                      frequency: Math.max(0.1, value) as never,
                      phase: 0 as never,
                    },
                    ...draft.platform.tones.filter((tone) => tone.axis === 'elevation'),
                  ],
                };
              });
            }}
          />
          <Field
            label="Jitter RMS"
            hint="Stationary RMS of the correlated random base motion, per axis."
            value={Number(((disturbances.platform.jitter.rms as number) / DEG).toFixed(4))}
            step={0.002}
            min={0}
            max={5}
            suffix="deg RMS"
            disabled={recording}
            onChange={(value) => {
              patch((draft) => {
                draft.platform = {
                  ...draft.platform,
                  jitter: {
                    ...draft.platform.jitter,
                    enabled: value > 0,
                    rms: (value * DEG) as never,
                  },
                };
              });
            }}
          />
        </Group>

        <Group title="Atmosphere">
          <Field
            label="Attenuation"
            hint="Path loss in decibels per kilometre. Intensity convention: 3.01 dB halves the intensity."
            value={disturbances.atmosphere.attenuation.dbPerKm}
            step={0.5}
            min={0}
            max={100}
            suffix="dB/km"
            disabled={recording}
            onChange={(value) => {
              patch((draft) => {
                draft.atmosphere = {
                  ...draft.atmosphere,
                  attenuation: { enabled: value > 0, dbPerKm: Math.max(0, value) },
                };
              });
            }}
          />
          <Field
            label="Scintillation σ"
            hint="Standard deviation of log-intensity. The mean gain stays one, so this changes variance and not brightness."
            value={disturbances.atmosphere.scintillation.logAmplitudeSigma}
            step={0.05}
            min={0}
            max={1}
            suffix="log-intensity"
            disabled={recording}
            onChange={(value) => {
              patch((draft) => {
                draft.atmosphere = {
                  ...draft.atmosphere,
                  scintillation: {
                    ...draft.atmosphere.scintillation,
                    enabled: value > 0,
                    logAmplitudeSigma: Math.max(0, Math.min(1, value)),
                  },
                };
              });
            }}
          />
          <Field
            label="Wander RMS"
            hint="Apparent angular displacement of the received beacon. Moves where its light lands, not the target."
            value={Number(((disturbances.atmosphere.wander.rms as number) * 1e6).toFixed(1))}
            step={5}
            min={0}
            max={5000}
            suffix="µrad RMS"
            disabled={recording}
            onChange={(value) => {
              patch((draft) => {
                draft.atmosphere = {
                  ...draft.atmosphere,
                  wander: {
                    ...draft.atmosphere.wander,
                    enabled: value > 0,
                    rms: (Math.max(0, value) * 1e-6) as never,
                  },
                };
              });
            }}
          />
          <Field
            label="Wander τ"
            hint="Correlation time of the wander process. Larger means slower drift."
            value={disturbances.atmosphere.wander.correlationTime}
            step={0.1}
            min={0.01}
            max={60}
            suffix="s"
            disabled={recording}
            onChange={(value) => {
              patch((draft) => {
                draft.atmosphere = {
                  ...draft.atmosphere,
                  wander: {
                    ...draft.atmosphere.wander,
                    correlationTime: Math.max(0.01, value) as never,
                  },
                };
              });
            }}
          />
        </Group>

        <Group title="Optics">
          <Field
            label="Exposure samples"
            hint="Optical states integrated across the exposure. One reproduces instantaneous capture exactly; more produces real motion blur."
            value={disturbances.optics.exposure.subSamples}
            step={1}
            min={1}
            max={64}
            suffix="per frame"
            disabled={recording}
            onChange={(value) => {
              patch((draft) => {
                const samples = Math.max(1, Math.min(64, Math.round(value)));
                draft.optics = {
                  ...draft.optics,
                  exposure: { enabled: samples > 1, subSamples: samples },
                };
              });
            }}
          />
          <Field
            label="Defocus"
            hint="Extra point-spread width, added in quadrature. Energy is preserved, so the peak falls as the spot widens."
            value={disturbances.optics.defocus.extraSigma}
            step={0.1}
            min={0}
            max={16}
            suffix="px σ"
            disabled={recording}
            onChange={(value) => {
              patch((draft) => {
                draft.optics = {
                  ...draft.optics,
                  defocus: { enabled: value > 0, extraSigma: Math.max(0, value) as never },
                };
              });
            }}
          />
          <Field
            label="Background"
            hint="Ambient sky level, added on top of the camera's own pedestal. Reduces contrast."
            value={disturbances.optics.background.level}
            step={0.01}
            min={0}
            max={1}
            suffix="of full scale"
            disabled={recording}
            onChange={(value) => {
              patch((draft) => {
                const level = Math.max(0, Math.min(1, value));
                draft.optics = {
                  ...draft.optics,
                  background: {
                    ...draft.optics.background,
                    enabled: level > 0,
                    level: level as never,
                  },
                };
              });
            }}
          />
        </Group>

        <Group title="Sensor noise">
          <Field
            label="Read noise σ"
            hint="Zero-mean, signal-independent. Intensity counts on the 0-255 scale, not electrons: this sensor has no calibrated conversion gain."
            value={disturbances.sensor.readNoise.sigma}
            step={0.5}
            min={0}
            max={64}
            suffix="counts"
            disabled={recording}
            onChange={(value) => {
              patch((draft) => {
                draft.sensor = {
                  ...draft.sensor,
                  readNoise: { enabled: value > 0, sigma: Math.max(0, value) },
                };
              });
            }}
          />
          <Field
            label="Shot noise scale"
            hint="Signal-dependent: sigma grows as the square root of signal plus background. A normal approximation, not exact Poisson statistics."
            value={disturbances.sensor.shotNoise.scale}
            step={0.1}
            min={0}
            max={8}
            suffix="counts^½"
            disabled={recording}
            onChange={(value) => {
              patch((draft) => {
                draft.sensor = {
                  ...draft.sensor,
                  shotNoise: { enabled: value > 0, scale: Math.max(0, value) },
                };
              });
            }}
          />
        </Group>

        <Group title="Frame delivery">
          <label className="flex items-baseline justify-between gap-3 py-1">
            <span className="text-[11px] text-muted-foreground">Mode</span>
            <select
              aria-label="Dropout mode"
              className="h-6 w-28 rounded-sm border bg-background px-1 text-[11px] disabled:opacity-40"
              value={disturbances.dropouts.mode}
              disabled={recording}
              onChange={(event) => {
                patch((draft) => {
                  draft.dropouts = {
                    ...draft.dropouts,
                    mode: event.target.value as DisturbanceConfig['dropouts']['mode'],
                  };
                });
              }}
            >
              <option value="none">none</option>
              <option value="independent">independent</option>
              <option value="burst">burst</option>
            </select>
          </label>
          <Field
            label="Drop probability"
            hint="Per-frame loss probability, for independent mode."
            value={disturbances.dropouts.probability}
            step={0.01}
            min={0}
            max={1}
            suffix="per frame"
            disabled={recording || disturbances.dropouts.mode !== 'independent'}
            onChange={(value) => {
              patch((draft) => {
                draft.dropouts = {
                  ...draft.dropouts,
                  probability: Math.max(0, Math.min(1, value)) as never,
                };
              });
            }}
          />
          <Field
            label="Mean good run"
            hint="Expected consecutive delivered frames, for burst mode."
            value={disturbances.dropouts.meanGoodFrames}
            step={10}
            min={1}
            max={10_000}
            suffix="frames"
            disabled={recording || disturbances.dropouts.mode !== 'burst'}
            onChange={(value) => {
              patch((draft) => {
                draft.dropouts = { ...draft.dropouts, meanGoodFrames: Math.max(1, value) };
              });
            }}
          />
          <Field
            label="Mean bad run"
            hint="Expected consecutive dropped frames, for burst mode. Runs test recovery; isolated losses do not."
            value={disturbances.dropouts.meanBadFrames}
            step={1}
            min={1}
            max={10_000}
            suffix="frames"
            disabled={recording || disturbances.dropouts.mode !== 'burst'}
            onChange={(value) => {
              patch((draft) => {
                draft.dropouts = { ...draft.dropouts, meanBadFrames: Math.max(1, value) };
              });
            }}
          />
        </Group>

        <Group title="False optical sources">
          <p className="py-1 text-[11px] leading-relaxed text-muted-foreground">
            Decoys are not a disturbance parameter. They are ordinary targets with ordinary
            trajectories and ordinary beacons, in the scenario&apos;s target list — because a decoy
            is not a special kind of object, and telling it apart is the tracker&apos;s job. This
            scenario carries{' '}
            <strong>
              {String(config.targets.length)} emitter{config.targets.length === 1 ? '' : 's'}
            </strong>
            {config.targets.length > 1
              ? '; only the designated one is scored, and no algorithm is told which.'
              : '.'}
          </p>
          <p className="py-1 text-[10px] leading-relaxed text-muted-foreground">
            Load <code>dist-decoy-easy</code> or <code>dist-decoy-hard</code> from Mission Control
            to exercise them.
          </p>
        </Group>
      </div>
    </div>
  );
}
