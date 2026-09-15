/**
 * What the tracker's state machine actually did, as a bar of real durations.
 *
 * Built from the mode changes the store recorded as they happened, not from the
 * mode the tracker is in now. That distinction is the whole value of it: a
 * two-frame excursion into RECOVER is two frames wide here, and a timeline
 * synthesised from the current mode could not show it at all.
 *
 * The bar is proportional to simulated time, so a glance answers the question a
 * PAT engineer actually asks — how long did it search, did it hold, how often
 * did it drop — without reading a log.
 */

import { useMemo } from 'react';

import type { PATMode } from '@/core/contracts/pat';
import { EmptyState, PAT_STATE } from '@/components/astra';
import { useSimulationStore } from '@/stores/simulation-store';

/** Colour and name per mode. The name is always shown; colour never stands alone. */
/**
 * The fill for each state.
 *
 * Literal colours rather than CSS variables: these are SVG fills inside a
 * bar that has to keep its meaning in an exported image, and they follow the
 * same ordering as the status palette — cool for progress, emerald for a good
 * state, amber for recovery, red for failure.
 *
 * The *words* are not repeated here. They come from the one presentation table
 * the whole application shares, so the timeline can never disagree with the
 * chip above it about what a state is called.
 */
const MODE_FILL: Record<PATMode, string> = {
  idle: 'oklch(0.4 0.02 245)',
  scan: 'oklch(0.55 0.1 240)',
  acquire: 'oklch(0.66 0.13 250)',
  track: 'oklch(0.7 0.14 163)',
  reacquire: 'oklch(0.75 0.15 78)',
  handoff: 'oklch(0.78 0.14 195)',
  lost: 'oklch(0.63 0.19 25)',
  fault: 'oklch(0.55 0.21 20)',
};

const modeLabel = (mode: PATMode): string => PAT_STATE[mode].label.toUpperCase();

export function PatTimeline(): React.JSX.Element {
  const timeline = useSimulationStore((state) => state.patTimeline);
  const now = useSimulationStore((state) => state.time);

  const segments = useMemo(() => {
    if (timeline.length === 0) return [];
    const start = timeline[0]!.from;
    const end = Math.max(now, timeline[timeline.length - 1]!.from);
    const span = end - start;
    if (span <= 0) return [];

    return timeline.map((interval) => {
      const until = interval.until ?? end;
      return {
        mode: interval.mode,
        from: interval.from,
        until,
        // A percentage of the whole run, so widths are real durations.
        percent: ((until - interval.from) / span) * 100,
      };
    });
  }, [timeline, now]);

  if (segments.length === 0) {
    return (
      <EmptyState
        title="No PAT transitions yet."
        hint="Enable autonomy and run the scenario; the timeline is built from the state machine's own transitions."
      />
    );
  }

  const start = segments[0]!.from;
  const end = segments[segments.length - 1]!.until;

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div
        className="flex h-6 w-full overflow-hidden rounded-sm border border-panel-border"
        role="img"
        aria-label={`PAT state timeline: ${segments
          .map((s) => `${modeLabel(s.mode)} for ${(s.until - s.from).toFixed(1)} seconds`)
          .join(', ')}`}
      >
        {segments.map((segment, index) => {
          const label = modeLabel(segment.mode);
          return (
            <div
              key={`${String(index)}-${String(segment.from)}`}
              className="flex min-w-0 items-center justify-center overflow-hidden border-r border-background/40 last:border-r-0"
              style={{
                width: `${segment.percent.toFixed(3)}%`,
                backgroundColor: MODE_FILL[segment.mode],
              }}
              title={`${label} · ${segment.from.toFixed(2)}–${segment.until.toFixed(2)} s (${(segment.until - segment.from).toFixed(2)} s)`}
            >
              {/* The name only fits on a wide segment; the title and the aria
                  label carry it for the rest. */}
              {segment.percent > 9 && (
                <span className="truncate px-1 text-[9px] font-semibold tracking-wider text-background">
                  {label}
                </span>
              )}
            </div>
          );
        })}
      </div>

      <div className="tabular flex justify-between text-[9px] text-muted-foreground">
        <span>{start.toFixed(1)} s</span>
        <span>
          {segments.length} {segments.length === 1 ? 'interval' : 'intervals'}
        </span>
        <span>{end.toFixed(1)} s</span>
      </div>
    </div>
  );
}
