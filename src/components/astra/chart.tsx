/**
 * The frame every chart in the workstation sits in, and the palette they share.
 *
 * The frame exists so that a chart is never a bare rectangle: it always carries
 * a title, its units, and a legend naming its series. A plot whose y-axis could
 * be microradians or degrees is not an engineering plot.
 *
 * ## What charts here are not allowed to do
 *
 * No smoothing. A servo that overshoots, a track that drops, an identity
 * verdict that flickers — those are the findings, and a spline through them
 * would be a picture of the spline. Series are drawn as the samples they came
 * from, with steps where the data steps.
 *
 * No invented points. A gap in the data is a gap in the line.
 *
 * With few samples the individual points are drawn, because five seeds are five
 * seeds and a continuous curve through them would imply a population that was
 * never measured.
 */

import type * as React from 'react';

import { cn } from '@/lib/utils';

export interface ChartFrameProps extends React.ComponentProps<'figure'> {
  readonly title: string;
  /** The unit of the value axis. Shown beside the title, always. */
  readonly unit?: string | undefined;
  readonly series?: readonly { label: string; color: string }[] | undefined;
  /** A short note under the plot: a definition, a caveat, a sample count. */
  readonly note?: string | undefined;
}

export function ChartFrame({
  title,
  unit,
  series,
  note,
  className,
  children,
  ...props
}: ChartFrameProps): React.JSX.Element {
  return (
    <figure className={cn('flex min-h-0 min-w-0 flex-col gap-1', className)} {...props}>
      <figcaption className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[9px] font-semibold tracking-[0.07em] text-muted-foreground uppercase">
          {title}
        </span>
        {unit !== undefined && (
          <span className="tabular text-[9px] text-muted-foreground/70">[{unit}]</span>
        )}
        {series !== undefined && series.length > 0 && (
          <span className="ml-auto flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
            {series.map((entry) => (
              <span
                key={entry.label}
                className="flex items-center gap-1 text-[9px] text-muted-foreground"
              >
                <span
                  aria-hidden
                  className="size-1.5 rounded-[1px]"
                  style={{ backgroundColor: entry.color }}
                />
                {entry.label}
              </span>
            ))}
          </span>
        )}
      </figcaption>
      <div className="min-h-0 flex-1">{children}</div>
      {note !== undefined && (
        <figcaption className="text-[9px] leading-snug text-muted-foreground/70">{note}</figcaption>
      )}
    </figure>
  );
}

/**
 * The tooltip every chart uses.
 *
 * Values are monospaced and carry their units, and the row that is being
 * hovered is named. Recharts' default tooltip is a white card with no units,
 * which is exactly the ambiguity the rest of this file exists to avoid.
 */
export function ChartTooltip({
  active,
  label,
  items,
  unit,
  labelFormatter,
}: {
  active?: boolean;
  label?: string | number;
  items?: readonly {
    name?: string | undefined;
    value?: number | null | undefined;
    color?: string | undefined;
  }[];
  unit?: string;
  labelFormatter?: (value: string | number) => string;
}): React.JSX.Element | null {
  if (active !== true || items === undefined || items.length === 0) return null;

  return (
    <div className="rounded-sm border border-panel-border bg-popover/95 px-2 py-1.5 shadow-lg backdrop-blur">
      {label !== undefined && (
        <div className="tabular mb-0.5 text-[10px] text-muted-foreground">
          {labelFormatter === undefined ? label : labelFormatter(label)}
        </div>
      )}
      {items.map((item, index) => (
        <div key={item.name ?? index} className="flex items-baseline gap-2 text-[10px]">
          <span
            aria-hidden
            className="size-1.5 shrink-0 rounded-[1px]"
            style={{ backgroundColor: item.color }}
          />
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{item.name}</span>
          <span className="tabular text-foreground/90">
            {item.value === null || item.value === undefined ? '—' : item.value.toPrecision(5)}
          </span>
          {unit !== undefined && <span className="text-[9px] text-muted-foreground">{unit}</span>}
        </div>
      ))}
    </div>
  );
}
