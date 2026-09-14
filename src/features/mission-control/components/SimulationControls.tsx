/**
 * Transport controls, wired to the real engine.
 *
 * Every button calls the simulation. Nothing here fabricates a value: the tick
 * and time shown are read back from the engine after it has advanced, not
 * predicted before.
 */

import { Pause, Play, RotateCcw, SkipForward, Square } from 'lucide-react';

import { PLAYBACK_SPEEDS, type PlaybackSpeed } from '@/core/simulation/clock';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { SCENARIO_IDS, type ScenarioId, listScenarios } from '@/scenarios';
import { useSimulationStore } from '@/stores/simulation-store';

export function SimulationControls(): React.JSX.Element {
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

  const isRunning = status === 'running';

  return (
    <div className="flex flex-wrap items-center gap-2 border-b px-4 py-2">
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            size="sm"
            variant={isRunning ? 'secondary' : 'default'}
            onClick={() => {
              if (isRunning) pause();
              else if (status === 'paused') resume();
              else start();
            }}
            aria-label={isRunning ? 'Pause' : status === 'paused' ? 'Resume' : 'Start'}
          >
            {isRunning ? <Pause /> : <Play />}
            {isRunning ? 'Pause' : status === 'paused' ? 'Resume' : 'Start'}
          </Button>
        </TooltipTrigger>
        <TooltipContent>Run or hold the fixed-step clock</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="outline" onClick={stepOnce} aria-label="Step one tick">
            <SkipForward />
            Step
          </Button>
        </TooltipTrigger>
        <TooltipContent>Advance exactly one simulation tick</TooltipContent>
      </Tooltip>

      <Tooltip>
        <TooltipTrigger asChild>
          <Button size="sm" variant="outline" onClick={reset} aria-label="Reset to tick zero">
            <RotateCcw />
            Reset
          </Button>
        </TooltipTrigger>
        <TooltipContent>Return to tick 0 and replay the same run</TooltipContent>
      </Tooltip>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden />

      <div className="flex items-center gap-1" role="group" aria-label="Playback speed">
        {PLAYBACK_SPEEDS.map((option: PlaybackSpeed) => (
          <Button
            key={option}
            size="sm"
            variant="ghost"
            aria-pressed={speed === option}
            onClick={() => {
              setSpeed(option);
            }}
            className={cn(
              'tabular h-7 px-2 text-xs',
              speed === option && 'bg-accent text-foreground',
            )}
          >
            {option}x
          </Button>
        ))}
      </div>

      <div className="mx-1 h-5 w-px bg-border" aria-hidden />

      <label className="flex items-center gap-2 text-xs text-muted-foreground">
        Scenario
        <select
          className="h-7 rounded-md border bg-background px-2 text-xs text-foreground"
          value={scenarioId ?? ''}
          aria-label="Scenario"
          onChange={(event) => {
            const value = event.target.value;
            if ((SCENARIO_IDS as readonly string[]).includes(value)) {
              loadScenarioById(value as ScenarioId);
            }
          }}
        >
          {scenarioId === null && <option value="">Imported scenario</option>}
          {listScenarios().map((scenario) => (
            <option key={scenario.id} value={scenario.id}>
              {scenario.name}
            </option>
          ))}
        </select>
      </label>

      <span className="ml-auto flex items-center gap-1.5 text-xs text-muted-foreground">
        <Square
          aria-hidden
          className={cn(
            'size-2 fill-current',
            isRunning ? 'text-emerald-400' : 'text-muted-foreground',
          )}
        />
        {status}
      </span>
    </div>
  );
}
