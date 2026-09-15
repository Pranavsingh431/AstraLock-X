/**
 * The left rail: everything an operator sets before or during a run.
 *
 * Grouped by what the control acts on rather than by which component happens to
 * own it — the run, the tracker, the mount, the experiment — because that is
 * how someone flying this thinks about it. Each group collapses, so an operator
 * who is watching acquisition can fold away the mount controls they are not
 * touching.
 *
 * Every control here drives something real. There is nothing for a capability
 * the application does not have.
 */

import {
  Bot,
  ChevronRight,
  CircleStop,
  Crosshair,
  Fingerprint,
  Move3d,
  Pause,
  Play,
  RotateCcw,
  SkipForward,
  Radio,
} from 'lucide-react';
import { useState } from 'react';

import { ALGORITHMS, TERMINAL_BEACON_PROFILES } from '@/core/algorithms';
import { PLAYBACK_SPEEDS, type PlaybackSpeed } from '@/core/simulation/clock';
import { Panel, PanelHeader, StatusBadge, WarningBanner } from '@/components/astra';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { listScenarios, type ScenarioId } from '@/scenarios';
import { useSimulationStore } from '@/stores/simulation-store';

import { confirmIfRecording } from '../recording-guard';
import { ExperimentControls } from '../components/ExperimentControls';
import { GimbalControls } from '../components/GimbalControls';
import { ScenarioIoBar } from '../components/ScenarioIoBar';
import { SCENARIO_GROUPS, SCENARIO_PURPOSE } from '../scenario-groups';

/** A collapsible group in the rail. */
function Group({
  title,
  icon: Icon,
  defaultOpen = true,
  children,
}: {
  title: string;
  icon: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
  defaultOpen?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  const [open, setOpen] = useState(defaultOpen);

  return (
    <div className="border-b border-panel-border/60 last:border-b-0">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open);
        }}
        className="flex w-full items-center gap-1.5 px-2.5 py-1.5 text-left hover:bg-accent/30"
      >
        <ChevronRight
          aria-hidden
          className={cn(
            'size-3 text-muted-foreground transition-transform duration-150',
            open && 'rotate-90',
          )}
        />
        <Icon aria-hidden className="size-3 text-muted-foreground" />
        <span className="text-[9px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          {title}
        </span>
      </button>
      {open && <div className="astra-rise px-2.5 pb-2.5">{children}</div>}
    </div>
  );
}

const labelClass = 'mb-1 block text-[9px] tracking-[0.07em] text-muted-foreground uppercase';
const selectClass =
  'w-full rounded-sm border border-panel-border bg-background px-1.5 py-1 text-[11px] text-foreground';

export function ControlRail(): React.JSX.Element {
  const status = useSimulationStore((state) => state.status);
  const speed = useSimulationStore((state) => state.speed);
  const scenarioId = useSimulationStore((state) => state.scenarioId);
  const start = useSimulationStore((state) => state.start);
  const pause = useSimulationStore((state) => state.pause);
  const resume = useSimulationStore((state) => state.resume);
  const reset = useSimulationStore((state) => state.reset);
  const stepOnce = useSimulationStore((state) => state.stepOnce);
  const setSpeed = useSimulationStore((state) => state.setSpeed);
  const loadScenarioById = useSimulationStore((state) => state.loadScenarioById);

  const algorithmId = useSimulationStore((state) => state.algorithmId);
  const setAlgorithm = useSimulationStore((state) => state.setAlgorithm);
  const autonomy = useSimulationStore((state) => state.autonomyEnabled);
  const setAutonomy = useSimulationStore((state) => state.setAutonomy);
  const override = useSimulationStore((state) => state.manualOverride);
  const setOverride = useSimulationStore((state) => state.setManualOverride);
  const identityEnabled = useSimulationStore((state) => state.identityEnabled);
  const setIdentityEnabled = useSimulationStore((state) => state.setIdentityEnabled);
  const profileId = useSimulationStore((state) => state.expectedBeaconProfileId);
  const setProfile = useSimulationStore((state) => state.setExpectedBeaconProfile);
  const recording = useSimulationStore((state) => state.recorderStatus?.state === 'running');
  const runtimeError = useSimulationStore((state) => state.runtimeError);

  const scenarios = listScenarios();
  const running = status === 'running';
  const isRobust = algorithmId === 'astralock-x';

  return (
    <Panel className="h-full">
      <PanelHeader icon={Crosshair} title="Controls" />

      <div className="min-h-0 flex-1 overflow-y-auto">
        {runtimeError !== null && (
          <div className="p-2.5">
            <WarningBanner tone="fault">{runtimeError}</WarningBanner>
          </div>
        )}

        <Group title="Run" icon={Play}>
          <label className={labelClass} htmlFor="mc-scenario">
            Scenario
          </label>
          <select
            id="mc-scenario"
            aria-label="Scenario"
            className={selectClass}
            value={scenarioId ?? ''}
            onChange={(event) => {
              if (!confirmIfRecording('Changing the scenario ends the recording.')) return;
              loadScenarioById(event.target.value as ScenarioId);
            }}
          >
            {SCENARIO_GROUPS.map((group) => (
              <optgroup key={group.label} label={group.label}>
                {group.ids.map((id) => (
                  <option key={id} value={id}>
                    {scenarios.find((entry) => entry.id === id)?.name ?? id}
                  </option>
                ))}
              </optgroup>
            ))}
          </select>

          {/* What the scenario is for, when it has a one-line answer. Reading
              the name alone does not tell an operator why they would load it. */}
          {scenarioId !== null && SCENARIO_PURPOSE[scenarioId] !== undefined && (
            <p className="mt-1 text-[9px] leading-snug text-muted-foreground">
              {SCENARIO_PURPOSE[scenarioId]}
            </p>
          )}

          <div className="mt-2 flex items-center gap-1">
            <Button
              size="sm"
              className="h-7 flex-1 px-2 text-[11px]"
              variant={running ? 'secondary' : 'default'}
              aria-label={running ? 'Pause' : status === 'paused' ? 'Resume' : 'Start'}
              onClick={() => {
                if (running) pause();
                else if (status === 'paused') resume();
                else start();
              }}
            >
              {running ? <Pause className="size-3" /> : <Play className="size-3" />}
              {running ? 'Pause' : status === 'paused' ? 'Resume' : 'Start'}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2"
              aria-label="Step one tick"
              onClick={stepOnce}
            >
              <SkipForward className="size-3" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7 px-2"
              aria-label="Reset to tick zero"
              onClick={() => {
                if (!confirmIfRecording('Resetting ends the recording.')) return;
                reset();
              }}
            >
              <RotateCcw className="size-3" />
            </Button>
          </div>

          <div className="mt-1.5 flex gap-px">
            {PLAYBACK_SPEEDS.map((value: PlaybackSpeed) => (
              <button
                key={value}
                type="button"
                aria-label={`${String(value)}x`}
                aria-pressed={speed === value}
                onClick={() => {
                  setSpeed(value);
                }}
                className={cn(
                  'tabular flex-1 border py-0.5 text-[10px] first:rounded-l-sm last:rounded-r-sm',
                  speed === value
                    ? 'border-status-active/50 bg-status-active/15 text-status-active'
                    : 'border-panel-border text-muted-foreground hover:text-foreground',
                )}
              >
                {value}×
              </button>
            ))}
          </div>

          {/* Scenario I/O lives here rather than in a toolbar: loading a file
              replaces the world, which is a run control, not a file menu. */}
          <div className="mt-1.5 border-t border-panel-border/60 pt-1.5">
            <ScenarioIoBar />
          </div>
        </Group>

        <Group title="Tracking" icon={Bot}>
          <label className={labelClass} htmlFor="mc-algorithm">
            Algorithm
          </label>
          <select
            id="mc-algorithm"
            aria-label="Algorithm"
            className={selectClass}
            value={algorithmId}
            disabled={recording}
            title={recording ? 'An algorithm cannot change mid-recording.' : undefined}
            onChange={(event) => {
              if (!confirmIfRecording('Changing the algorithm ends the recording.')) return;
              setAlgorithm(event.target.value);
            }}
          >
            {ALGORITHMS.map((plugin) => (
              <option key={plugin.manifest.id} value={plugin.manifest.id}>
                {plugin.manifest.name}
              </option>
            ))}
          </select>
          {recording && (
            <p className="mt-1 text-[9px] leading-snug text-muted-foreground">
              Locked while recording: a run may not span two trackers.
            </p>
          )}

          <div className="mt-2 flex items-center gap-1">
            {/* A bordered toggle rather than a filled slab. Handing the mount
                to the tracker is consequential, but two saturated blocks
                stacked in a control rail is a marketing page, not a console —
                the state is carried by the word, the border and the colour. */}
            <Button
              size="sm"
              variant="outline"
              className={cn(
                'h-7 flex-1 px-2 text-[11px] font-semibold',
                autonomy
                  ? 'border-status-nominal/50 bg-status-nominal/8 text-status-nominal hover:bg-status-nominal/14'
                  : 'border-status-active/50 bg-status-active/6 text-status-active hover:bg-status-active/12',
              )}
              aria-label={autonomy ? 'Disable autonomous PAT' : 'Enable autonomous PAT'}
              onClick={() => {
                setAutonomy(!autonomy);
              }}
            >
              <Bot className="size-3" />
              {autonomy ? 'Autonomy on' : 'Enable autonomy'}
            </Button>
            {autonomy && (
              <Button
                size="sm"
                variant="outline"
                className="h-7 px-2"
                aria-label="Emergency stop"
                title="Disable autonomy immediately"
                onClick={() => {
                  setAutonomy(false);
                }}
              >
                <CircleStop className="size-3 text-status-fault" />
              </Button>
            )}
          </div>

          <label className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <input
              type="checkbox"
              aria-label="Manual override"
              checked={override}
              onChange={(event) => {
                setOverride(event.target.checked);
              }}
              className="accent-status-degraded"
            />
            Manual override
          </label>
          {override && (
            <p className="mt-1 text-[9px] leading-snug text-status-degraded">
              Your commands and the tracker's both reach the mount.
            </p>
          )}
        </Group>

        {isRobust && (
          <Group title="Optical identity" icon={Fingerprint}>
            <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
              <input
                type="checkbox"
                aria-label="Beacon identity"
                checked={identityEnabled}
                onChange={(event) => {
                  if (!confirmIfRecording('Switching beacon identity ends the recording.')) return;
                  setIdentityEnabled(event.target.checked);
                }}
                className="accent-status-active"
              />
              Recognise the beacon by its code
            </label>

            {identityEnabled ? (
              <>
                <label className={cn(labelClass, 'mt-2')} htmlFor="mc-profile">
                  Expected code
                </label>
                <select
                  id="mc-profile"
                  aria-label="Expected beacon code"
                  className={selectClass}
                  value={profileId}
                  onChange={(event) => {
                    if (!confirmIfRecording('Changing the expected code ends the recording.')) {
                      return;
                    }
                    setProfile(event.target.value);
                  }}
                >
                  {TERMINAL_BEACON_PROFILES.map((profile) => (
                    <option key={profile.id} value={profile.id}>
                      {profile.label}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-[9px] leading-snug text-muted-foreground">
                  A receiver setting, not read from the scenario. A beacon that does not send this
                  pattern will not be acquired.
                </p>
              </>
            ) : (
              <p className="mt-1 text-[9px] leading-snug text-muted-foreground">
                Choosing on motion alone, as before coded beacons existed. This is the control arm.
              </p>
            )}
          </Group>
        )}

        <Group title="Mount" icon={Move3d} defaultOpen={false}>
          <GimbalControls />
        </Group>

        <Group title="Experiment" icon={Radio} defaultOpen={false}>
          <ExperimentControls />
        </Group>
      </div>

      <div className="flex shrink-0 items-center gap-1.5 border-t border-panel-border px-2.5 py-1.5">
        <StatusBadge
          status={running ? 'active' : 'idle'}
          label={running ? 'Running' : status === 'paused' ? 'Paused' : 'Stopped'}
        />
        {recording && <StatusBadge status="fault" label="Recording" pulse />}
      </div>
    </Panel>
  );
}
