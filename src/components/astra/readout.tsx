/**
 * Numeric readouts, status chips and the small pieces a dense engineering
 * panel is built from.
 *
 * Two rules run through all of it.
 *
 * **A number knows its unit.** Every readout takes one and shows it. An
 * unlabelled number in a control interface is an invitation to read radians as
 * degrees, and the core works in radians while a human reads degrees.
 *
 * **Absence is not zero.** `null` renders as an em dash in muted type, never as
 * `0.000`. A pointing error that does not exist because nothing has been
 * acquired is a different fact from a pointing error of zero, and the second
 * one would be a lie.
 */

import type * as React from 'react';

import { cn } from '@/lib/utils';

/** How much visual weight a readout carries. */
export type ReadoutSize = 'sm' | 'md' | 'lg';

const VALUE_SIZE: Record<ReadoutSize, string> = {
  sm: 'text-[11px]',
  md: 'text-[13px]',
  lg: 'text-[17px] font-medium',
};

export interface MetricReadoutProps extends Omit<React.ComponentProps<'div'>, 'children'> {
  readonly label: string;
  /** Already formatted, or `null` for a quantity that does not exist. */
  readonly value: string | number | null;
  readonly unit?: string | undefined;
  readonly size?: ReadoutSize | undefined;
  /** Small muted line under the value: a threshold, a denominator, a caveat. */
  readonly hint?: string | undefined;
  readonly tone?: 'default' | 'nominal' | 'degraded' | 'fault' | 'active' | 'truth' | undefined;
}

const VALUE_TONE: Record<NonNullable<MetricReadoutProps['tone']>, string> = {
  default: 'text-foreground/90',
  nominal: 'text-status-nominal',
  degraded: 'text-status-degraded',
  fault: 'text-status-fault',
  active: 'text-status-active',
  truth: 'text-truth',
};

export function MetricReadout({
  label,
  value,
  unit,
  size = 'sm',
  hint,
  tone = 'default',
  className,
  ...props
}: MetricReadoutProps): React.JSX.Element {
  const absent = value === null;
  // A long hint truncated to "Aperture photomet…" helps nobody. Short ones —
  // a count, a provenance note — stay on the face of the readout; longer ones
  // become the tooltip, which is where an explanation belongs.
  const inlineHint = hint !== undefined && hint.length <= 24;
  return (
    <div
      className={cn('flex min-w-0 flex-col', className)}
      {...(hint === undefined ? {} : { title: hint })}
      {...props}
    >
      <span className="truncate text-[9px] tracking-[0.07em] text-muted-foreground uppercase">
        {label}
      </span>
      <span className="flex min-w-0 items-baseline gap-1">
        <span
          className={cn(
            'tabular truncate leading-tight',
            VALUE_SIZE[size],
            absent ? 'text-muted-foreground/60 italic' : VALUE_TONE[tone],
          )}
        >
          {absent ? '—' : value}
        </span>
        {unit !== undefined && !absent && (
          <span className="shrink-0 text-[9px] text-muted-foreground">{unit}</span>
        )}
      </span>
      {inlineHint && (
        <span className="truncate text-[9px] leading-tight text-muted-foreground/80">{hint}</span>
      )}
    </div>
  );
}

/** A label-and-value row, for stacked diagnostics rather than a grid. */
export function DiagnosticRow({
  label,
  value,
  unit,
  tone = 'default',
  className,
  ...props
}: Omit<MetricReadoutProps, 'size' | 'hint'>): React.JSX.Element {
  const absent = value === null;
  return (
    <div className={cn('flex items-baseline justify-between gap-3 py-px', className)} {...props}>
      <span className="truncate text-[10px] text-muted-foreground">{label}</span>
      <span className="flex shrink-0 items-baseline gap-1">
        <span
          className={cn(
            'tabular text-[11px]',
            absent ? 'text-muted-foreground/60 italic' : VALUE_TONE[tone],
          )}
        >
          {absent ? '—' : value}
        </span>
        {unit !== undefined && !absent && (
          <span className="text-[9px] text-muted-foreground">{unit}</span>
        )}
      </span>
    </div>
  );
}

// --- Status -----------------------------------------------------------------

/**
 * The engineering statuses the workstation is allowed to report.
 *
 * A closed set, because a status that can be any string becomes any string.
 * There is deliberately no aggregate "system health": the application has no
 * basis for one, and a single percentage over incommensurable subsystems would
 * be invented.
 */
export type Status =
  'nominal' | 'active' | 'degraded' | 'recovering' | 'limited' | 'fault' | 'idle';

const STATUS_STYLE: Record<Status, string> = {
  nominal: 'border-status-nominal/50 bg-status-nominal/12 text-status-nominal',
  active: 'border-status-active/50 bg-status-active/12 text-status-active',
  degraded: 'border-status-degraded/50 bg-status-degraded/12 text-status-degraded',
  recovering: 'border-status-degraded/50 bg-status-degraded/12 text-status-degraded',
  limited: 'border-status-degraded/40 bg-status-degraded/8 text-status-degraded',
  fault: 'border-status-fault/55 bg-status-fault/12 text-status-fault',
  idle: 'border-panel-border bg-muted/40 text-muted-foreground',
};

export interface StatusBadgeProps extends React.ComponentProps<'span'> {
  readonly status: Status;
  /** The word shown. Required: colour is never the only channel. */
  readonly label: string;
  /** A slow pulse, for a genuinely abnormal live condition. */
  readonly pulse?: boolean;
  readonly size?: 'sm' | 'md';
}

export function StatusBadge({
  status,
  label,
  pulse = false,
  size = 'sm',
  className,
  ...props
}: StatusBadgeProps): React.JSX.Element {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1.5 rounded-sm border font-semibold tracking-[0.08em] whitespace-nowrap uppercase',
        size === 'sm' ? 'px-1.5 py-0.5 text-[9px]' : 'px-2 py-1 text-[11px]',
        STATUS_STYLE[status],
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className={cn('size-1.5 rounded-full bg-current', pulse && 'astra-pulse')}
      />
      {label}
    </span>
  );
}

// --- Bars -------------------------------------------------------------------

/**
 * A proportion, as a bar and a number.
 *
 * Both, always. The bar is read at a glance and the number is read when it
 * matters, and a bar alone cannot be quoted.
 */
export function ProportionBar({
  label,
  value,
  tone = 'active',
  className,
}: {
  label: string;
  /** On [0, 1], or `null` when undefined. */
  value: number | null;
  tone?: 'active' | 'nominal' | 'degraded' | 'fault' | 'truth' | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  const fill: Record<string, string> = {
    active: 'bg-status-active',
    nominal: 'bg-status-nominal',
    degraded: 'bg-status-degraded',
    fault: 'bg-status-fault',
    truth: 'bg-truth',
  };
  const percent = value === null ? 0 : Math.max(0, Math.min(1, value)) * 100;

  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="w-7 shrink-0 text-[9px] tracking-wider text-muted-foreground uppercase">
        {label}
      </span>
      <div
        className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-[2px] bg-muted/50"
        role="meter"
        aria-label={label}
        aria-valuenow={value ?? undefined}
        aria-valuemin={0}
        aria-valuemax={1}
      >
        <div
          className={cn('h-full transition-[width] duration-150', fill[tone])}
          style={{ width: `${percent.toFixed(1)}%` }}
        />
      </div>
      <span
        className={cn(
          'tabular w-9 shrink-0 text-right text-[10px]',
          value === null ? 'text-muted-foreground/60 italic' : 'text-foreground/80',
        )}
      >
        {value === null ? '—' : value.toFixed(2)}
      </span>
    </div>
  );
}

// --- States -----------------------------------------------------------------

/**
 * What a panel shows when it has nothing to show.
 *
 * Honest rather than decorative: it says what is absent and what would make it
 * appear. It never fills the space with sample values, which is the one thing
 * an engineering interface must not do.
 */
export function EmptyState({
  title,
  hint,
  icon: Icon,
  className,
}: {
  title: string;
  hint?: string | undefined;
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }> | undefined;
  className?: string | undefined;
}): React.JSX.Element {
  return (
    <div
      className={cn(
        'flex h-full min-h-20 flex-col items-center justify-center gap-1.5 px-4 py-6 text-center',
        className,
      )}
    >
      {Icon !== undefined && <Icon aria-hidden className="size-4 text-muted-foreground/50" />}
      <p className="text-[11px] text-muted-foreground">{title}</p>
      {hint !== undefined && (
        <p className="max-w-xs text-[10px] leading-snug text-muted-foreground/70">{hint}</p>
      )}
    </div>
  );
}

/** A persistent banner for a real warning or failure. Not a toast. */
export function WarningBanner({
  tone = 'warning',
  icon: Icon,
  children,
  className,
  ...props
}: React.ComponentProps<'div'> & {
  tone?: 'warning' | 'fault' | 'truth' | 'info';
  icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }>;
}): React.JSX.Element {
  const styles: Record<string, string> = {
    warning: 'border-status-degraded/45 bg-status-degraded/10 text-status-degraded',
    fault: 'border-status-fault/50 bg-status-fault/10 text-status-fault',
    truth: 'border-truth/45 bg-truth/10 text-truth',
    info: 'border-status-active/40 bg-status-active/8 text-status-active',
  };
  return (
    <div
      role={tone === 'fault' ? 'alert' : undefined}
      className={cn(
        'flex items-start gap-2 rounded-sm border px-2.5 py-1.5 text-[11px] leading-snug',
        styles[tone],
        className,
      )}
      {...props}
    >
      {Icon !== undefined && <Icon aria-hidden className="mt-px size-3.5 shrink-0" />}
      <span className="min-w-0">{children}</span>
    </div>
  );
}
