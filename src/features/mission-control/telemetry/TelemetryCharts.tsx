/**
 * The telemetry plots under Mission Control.
 *
 * Every series is a real bounded history the store recorded as the simulation
 * advanced. Nothing here is generated, interpolated or smoothed: a servo that
 * overshoots shows its overshoot, a track that drops shows the drop, and a
 * quantity that does not exist for a sample is a gap in the line rather than a
 * zero.
 *
 * ## Redraw rate
 *
 * The histories are appended once per displayed frame, around 60 Hz. Redrawing
 * six SVG charts at 60 Hz would spend most of a frame budget on plots nobody
 * can read that fast, so the charts subscribe to a coarser clock and redraw at
 * about 8 Hz. That is a refresh rate for a display, not a decimation of the
 * data — every sample is still in the series that gets drawn, and the numeric
 * readouts beside the charts still update at full rate.
 */

import { useMemo, useSyncExternalStore } from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { radiansToDegrees, radiansToMicroradians } from '@/core/contracts/units';
import {
  CHART_AXIS_COLOR,
  CHART_GRID_COLOR,
  ChartFrame,
  ChartTooltip,
  EmptyState,
  SERIES_COLORS,
  TRUTH_COLOR,
} from '@/components/astra';
import type { ResponseSample } from '@/stores/simulation-store';
import { useSimulationStore } from '@/stores/simulation-store';

/** Redraws per second. Fast enough to read as live, slow enough to be cheap. */
const REDRAW_HZ = 8;

/**
 * The history, delivered to React at the redraw rate rather than on every
 * append.
 *
 * `useSyncExternalStore` is the right primitive for this: the store is the
 * source of truth and is read directly, while the *subscription* is throttled,
 * so a sample appended at 60 Hz marks the charts dirty without waking React.
 * The trailing timer always fires, so the last sample of a run — or a single
 * sample produced by stepping while paused — still reaches the plot.
 */
function useTelemetry(): readonly ResponseSample[] {
  return useSyncExternalStore(subscribeAtRedrawRate, readHistory);
}

/**
 * The store's current history.
 *
 * Safe to call on every render: the store replaces the array wholesale, so the
 * reference is stable between appends and React's snapshot comparison behaves.
 */
function readHistory(): readonly ResponseSample[] {
  return useSimulationStore.getState().responseHistory;
}

function subscribeAtRedrawRate(onStoreChange: () => void): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let seen = readHistory();

  const unsubscribe = useSimulationStore.subscribe((state) => {
    if (state.responseHistory === seen) return;
    seen = state.responseHistory;
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      onStoreChange();
    }, 1000 / REDRAW_HZ);
  });

  return () => {
    if (timer !== null) clearTimeout(timer);
    unsubscribe();
  };
}

const axisProps = {
  stroke: CHART_AXIS_COLOR,
  tick: { fontSize: 9, fill: CHART_AXIS_COLOR },
  tickLine: { stroke: CHART_AXIS_COLOR },
  axisLine: { stroke: CHART_GRID_COLOR },
} as const;

const timeAxis = {
  dataKey: 'time',
  type: 'number' as const,
  domain: ['dataMin', 'dataMax'] as [string, string],
  tickFormatter: (value: number) => value.toFixed(0),
  ...axisProps,
};

/** Shared chart chrome: a grid, an x-axis in seconds, and our own tooltip. */
function TimeSeries({
  data,
  unit,
  children,
  yDomain,
  tickFormatter,
}: {
  data: readonly Record<string, unknown>[];
  unit: string;
  children: React.ReactNode;
  yDomain?: [number | string, number | string];
  tickFormatter?: (value: number) => string;
}): React.JSX.Element {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <LineChart data={[...data]} margin={{ top: 4, right: 8, bottom: 2, left: 2 }}>
        <CartesianGrid stroke={CHART_GRID_COLOR} strokeDasharray="2 3" vertical={false} />
        <XAxis {...timeAxis} />
        <YAxis
          width={44}
          domain={yDomain ?? (['auto', 'auto'] as [string, string])}
          tickFormatter={tickFormatter ?? ((value: number) => value.toPrecision(3))}
          {...axisProps}
        />
        <Tooltip
          isAnimationActive={false}
          cursor={{ stroke: CHART_AXIS_COLOR, strokeDasharray: '3 3' }}
          content={({ active, label, payload }) => (
            <ChartTooltip
              active={active}
              label={label as number}
              labelFormatter={(value) => `t = ${Number(value).toFixed(2)} s`}
              unit={unit}
              items={(payload ?? []).map((entry) => ({
                name: entry.name as string,
                value: entry.value as number | null,
                color: entry.color,
              }))}
            />
          )}
        />
        {children}
      </LineChart>
    </ResponsiveContainer>
  );
}

const line = (key: string, name: string, color: string, dashed = false) => (
  <Line
    key={key}
    type="linear"
    dataKey={key}
    name={name}
    stroke={color}
    strokeWidth={1.4}
    {...(dashed ? { strokeDasharray: '4 3' } : {})}
    dot={false}
    isAnimationActive={false}
    // A missing sample is a break in the line, not a straight segment across
    // the gap. `connectNulls` would invent the data in between.
    connectNulls={false}
  />
);

const NOT_RUNNING = (
  <EmptyState
    title="No telemetry yet."
    hint="Start the simulation to populate the trace. Every series is recorded as the run advances; nothing is precomputed."
  />
);

// --- Axis response ----------------------------------------------------------

export function AxisResponseChart({ axis }: { axis: 'pan' | 'tilt' }): React.JSX.Element {
  const history = useTelemetry();

  const data = useMemo(
    () =>
      history.map((sample) => ({
        time: sample.time,
        commanded: radiansToDegrees(
          (axis === 'pan' ? sample.commandedPan : sample.commandedTilt) as never,
        ),
        measured: radiansToDegrees(
          (axis === 'pan' ? sample.measuredPan : sample.measuredTilt) as never,
        ),
      })),
    [history, axis],
  );

  if (data.length < 2) {
    return (
      <div data-testid={`response-trace-${axis}-empty`} className="h-full">
        {NOT_RUNNING}
      </div>
    );
  }

  return (
    <ChartFrame
      data-testid={`response-trace-${axis}`}
      title={`${axis === 'pan' ? 'Pan' : 'Tilt'} — commanded vs measured`}
      unit="deg"
      series={[
        { label: 'Commanded', color: SERIES_COLORS[1] },
        { label: 'Measured', color: SERIES_COLORS[0] },
      ]}
      note="The measured trace lags the command by the mount's transport delay, then follows its own servo dynamics."
      className="h-full"
    >
      <TimeSeries data={data} unit="deg" tickFormatter={(value) => value.toFixed(2)}>
        {line('commanded', 'Commanded', SERIES_COLORS[1], true)}
        {line('measured', 'Measured', SERIES_COLORS[0])}
      </TimeSeries>
    </ChartFrame>
  );
}

// --- Estimator --------------------------------------------------------------

export function ModelProbabilityChart(): React.JSX.Element {
  const history = useTelemetry();

  const data = useMemo(
    () =>
      history
        .filter((s) => s.immCv !== null)
        .map((s) => ({ time: s.time, cv: s.immCv, ca: s.immCa })),
    [history],
  );

  if (data.length < 2) {
    return (
      <EmptyState
        title="No IMM to plot."
        hint="Model probabilities come from AstraLock-X. The baseline has a single motion model and reports none."
      />
    );
  }

  return (
    <ChartFrame
      title="IMM model probability"
      unit="1"
      series={[
        { label: 'Constant velocity', color: SERIES_COLORS[0] },
        { label: 'Constant acceleration', color: SERIES_COLORS[1] },
      ]}
      note="The estimator's own belief about which motion model explains the data. It separates when the target manoeuvres and relaxes toward the transition matrix when it does not."
      className="h-full"
    >
      <TimeSeries data={data} unit="" yDomain={[0, 1]} tickFormatter={(v) => v.toFixed(1)}>
        {line('cv', 'Constant velocity', SERIES_COLORS[0])}
        {line('ca', 'Constant acceleration', SERIES_COLORS[1])}
      </TimeSeries>
    </ChartFrame>
  );
}

// --- Identity ---------------------------------------------------------------

export function IdentityCorrelationChart({
  minCorrelation,
  mismatchCorrelation,
}: {
  minCorrelation: number;
  mismatchCorrelation: number;
}): React.JSX.Element {
  const history = useTelemetry();

  const data = useMemo(
    () =>
      history
        .filter((s) => s.codeCorrelation !== null)
        .map((s) => ({ time: s.time, correlation: s.codeCorrelation })),
    [history],
  );

  if (data.length < 2) {
    return (
      <EmptyState
        title="No identity evidence to plot."
        hint="Enable beacon identity on AstraLock-X against a coded beacon."
      />
    );
  }

  return (
    <ChartFrame
      title="Code correlation"
      unit="1"
      series={[{ label: 'Normalised correlation', color: SERIES_COLORS[3] }]}
      note="Pearson correlation against the exposure-integrated expected code, on [-1, 1]. Invariant to brightness, and not a probability."
      className="h-full"
    >
      <TimeSeries data={data} unit="" yDomain={[-1, 1]} tickFormatter={(v) => v.toFixed(1)}>
        <ReferenceLine
          y={minCorrelation}
          stroke="oklch(0.76 0.15 163)"
          strokeDasharray="3 3"
          strokeWidth={1}
          label={{ value: 'match', fontSize: 8, fill: 'oklch(0.76 0.15 163)', position: 'right' }}
        />
        <ReferenceLine
          y={mismatchCorrelation}
          stroke="oklch(0.68 0.19 25)"
          strokeDasharray="3 3"
          strokeWidth={1}
          label={{ value: 'reject', fontSize: 8, fill: 'oklch(0.68 0.19 25)', position: 'right' }}
        />
        {line('correlation', 'Correlation', SERIES_COLORS[3])}
      </TimeSeries>
    </ChartFrame>
  );
}

// --- Pointing error (privileged) --------------------------------------------

/**
 * True angular pointing error.
 *
 * **Evaluation only.** This is the simulator's own measurement of how far the
 * boresight is from the target, which no tracker can see. It is drawn in the
 * truth colour and framed as truth wherever it appears.
 */
export function PointingErrorChart(): React.JSX.Element {
  const history = useTelemetry();

  const data = useMemo(
    () =>
      history
        .filter((s) => s.pointingError !== null)
        .map((s) => ({
          time: s.time,
          error: radiansToMicroradians(s.pointingError as never),
        })),
    [history],
  );

  if (data.length < 2) {
    return (
      <EmptyState
        title="Evaluation hidden."
        hint="True pointing error is privileged: it comes from the simulator, not from the tracker. Show the evaluation readout to plot it."
      />
    );
  }

  return (
    <ChartFrame
      title="True angular pointing error"
      unit="µrad"
      series={[{ label: 'Ground truth', color: TRUTH_COLOR }]}
      note="Privileged: the angle between the true optical axis and the true line of sight. No algorithm receives this."
      className="h-full"
    >
      <TimeSeries data={data} unit="µrad" tickFormatter={(v) => v.toFixed(0)}>
        {line('error', 'True pointing error', TRUTH_COLOR)}
      </TimeSeries>
    </ChartFrame>
  );
}
