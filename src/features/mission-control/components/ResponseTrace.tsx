/**
 * Commanded angle against measured angle, over simulated time.
 *
 * The whole point of the phase is visible here: the measured trace lags the
 * command by the transport delay, then rises with the servo's own dynamics and
 * overshoots or creeps depending on the damping ratio. On the backlash profile,
 * a reversal shows as a flat section where the motor moves and the output does
 * not.
 *
 * Both series are real samples recorded by the store as the engine advances.
 * The history is bounded, so the window scrolls rather than growing.
 */

import { useMemo } from 'react';

import { radiansToDegrees } from '@/core/contracts/units';
import type { ResponseSample } from '@/stores/simulation-store';
import { useSimulationStore } from '@/stores/simulation-store';

const WIDTH = 320;
const HEIGHT = 88;
const PADDING = 3;

interface Plot {
  readonly commandPath: string;
  readonly measuredPath: string;
  readonly minDeg: number;
  readonly maxDeg: number;
  readonly spanSeconds: number;
}

/**
 * Builds both polylines in one pass over the history.
 *
 * The vertical range covers both series so the gap between them is read at face
 * value; a range fitted to the measured trace alone would flatter the servo.
 */
function buildPlot(samples: readonly ResponseSample[], axis: 'pan' | 'tilt'): Plot | null {
  if (samples.length < 2) return null;

  const commandOf = (s: ResponseSample): number =>
    axis === 'pan' ? s.commandedPan : s.commandedTilt;
  const measuredOf = (s: ResponseSample): number =>
    axis === 'pan' ? s.measuredPan : s.measuredTilt;

  let min = Infinity;
  let max = -Infinity;
  for (const sample of samples) {
    min = Math.min(min, commandOf(sample), measuredOf(sample));
    max = Math.max(max, commandOf(sample), measuredOf(sample));
  }

  const firstTime = samples[0]!.time;
  const lastTime = samples[samples.length - 1]!.time;
  const timeSpan = lastTime - firstTime;
  if (timeSpan <= 0) return null;

  // A dead-flat trace would divide by zero; give it a hair of range and let it
  // sit on the centre line.
  const valueSpan = max - min < 1e-9 ? 1e-9 : max - min;

  const x = (time: number): number =>
    PADDING + ((time - firstTime) / timeSpan) * (WIDTH - 2 * PADDING);
  const y = (value: number): number =>
    HEIGHT - PADDING - ((value - min) / valueSpan) * (HEIGHT - 2 * PADDING);

  const toPath = (pick: (s: ResponseSample) => number): string =>
    samples
      .map(
        (sample, index) =>
          `${index === 0 ? 'M' : 'L'}${x(sample.time).toFixed(2)} ${y(pick(sample)).toFixed(2)}`,
      )
      .join(' ');

  return {
    commandPath: toPath(commandOf),
    measuredPath: toPath(measuredOf),
    minDeg: radiansToDegrees(min as never),
    maxDeg: radiansToDegrees(max as never),
    spanSeconds: timeSpan,
  };
}

export function ResponseTrace({ axis }: { axis: 'pan' | 'tilt' }): React.JSX.Element {
  const samples = useSimulationStore((state) => state.responseHistory);
  const plot = useMemo(() => buildPlot(samples, axis), [samples, axis]);

  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between">
        <h3 className="text-[10px] font-semibold tracking-wider text-muted-foreground uppercase">
          {axis} response
        </h3>
        <span className="flex items-center gap-2 text-[9px] tracking-wider uppercase">
          <span className="text-sky-700">command</span>
          <span className="text-emerald-700">measured</span>
        </span>
      </div>

      {plot === null ? (
        <div
          className="flex items-center justify-center rounded-sm border border-dashed text-[10px] text-muted-foreground"
          style={{ height: HEIGHT }}
          data-testid={`response-trace-${axis}-empty`}
        >
          Run the simulation to record a response
        </div>
      ) : (
        <>
          <svg
            viewBox={`0 0 ${String(WIDTH)} ${String(HEIGHT)}`}
            className="w-full rounded-sm border bg-black/20"
            style={{ height: HEIGHT }}
            role="img"
            aria-label={`${axis} commanded versus measured angle`}
            data-testid={`response-trace-${axis}`}
          >
            <path
              d={plot.commandPath}
              fill="none"
              stroke="currentColor"
              className="text-sky-700"
              strokeWidth={1}
              strokeLinejoin="round"
            />
            <path
              d={plot.measuredPath}
              fill="none"
              stroke="currentColor"
              className="text-emerald-700"
              strokeWidth={1.25}
              strokeLinejoin="round"
            />
          </svg>
          <div className="tabular flex justify-between text-[9px] text-muted-foreground">
            <span>{`${plot.spanSeconds.toFixed(1)} s window`}</span>
            <span>{`${plot.minDeg.toFixed(2)}° … ${plot.maxDeg.toFixed(2)}°`}</span>
          </div>
        </>
      )}
    </div>
  );
}
