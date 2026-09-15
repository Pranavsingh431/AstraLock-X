/**
 * The engineering table.
 *
 * Dense by design: this is desktop software where a reader wants twenty rows on
 * screen, not six. Numeric cells are monospaced and right-aligned so a column of
 * values lines up on the decimal point and a changing digit does not shift the
 * ones beside it.
 *
 * It is a thin wrapper over real `table` markup rather than a grid of divs,
 * because a table of engineering results is a table and a screen reader should
 * be told so.
 */

import type * as React from 'react';

import { cn } from '@/lib/utils';

export function EngineeringTable({
  className,
  ...props
}: React.ComponentProps<'table'>): React.JSX.Element {
  return (
    <div className="min-w-0 overflow-x-auto">
      <table
        className={cn('w-full border-collapse text-[11px] whitespace-nowrap', className)}
        {...props}
      />
    </div>
  );
}

export function TableHead({
  className,
  ...props
}: React.ComponentProps<'thead'>): React.JSX.Element {
  return (
    <thead
      className={cn(
        'sticky top-0 z-10 bg-panel-header text-[9px] tracking-[0.07em] text-muted-foreground uppercase',
        className,
      )}
      {...props}
    />
  );
}

export function TableBody(props: React.ComponentProps<'tbody'>): React.JSX.Element {
  return <tbody {...props} />;
}

export function Tr({
  selected = false,
  interactive = false,
  className,
  ...props
}: React.ComponentProps<'tr'> & {
  selected?: boolean;
  interactive?: boolean;
}): React.JSX.Element {
  return (
    <tr
      data-selected={selected || undefined}
      className={cn(
        'border-b border-panel-border/50 last:border-b-0',
        interactive && 'cursor-pointer hover:bg-accent/40',
        selected && 'bg-status-active/12',
        className,
      )}
      {...props}
    />
  );
}

/** A header cell. `numeric` right-aligns it to match its column. */
export function Th({
  numeric = false,
  className,
  ...props
}: React.ComponentProps<'th'> & { numeric?: boolean }): React.JSX.Element {
  return (
    <th
      scope="col"
      className={cn(
        'border-b border-panel-border px-2 py-1 font-semibold',
        numeric ? 'text-right' : 'text-left',
        className,
      )}
      {...props}
    />
  );
}

/**
 * A body cell.
 *
 * `numeric` makes it monospaced, tabular and right-aligned; `absent` renders the
 * em dash that stands for a quantity which does not exist, so no caller has to
 * decide again whether a missing value should be a zero.
 */
export function Td({
  numeric = false,
  absent = false,
  className,
  children,
  ...props
}: React.ComponentProps<'td'> & { numeric?: boolean; absent?: boolean }): React.JSX.Element {
  return (
    <td
      className={cn(
        'px-2 py-1',
        numeric && 'tabular text-right',
        absent && 'text-muted-foreground/60 italic',
        className,
      )}
      {...props}
    >
      {absent ? '—' : children}
    </td>
  );
}

/** A row header, for tables whose first column names the row. */
export function Rh({ className, ...props }: React.ComponentProps<'th'>): React.JSX.Element {
  return (
    <th
      scope="row"
      className={cn('px-2 py-1 text-left font-normal text-foreground/85', className)}
      {...props}
    />
  );
}
