/**
 * The AstraLock-X panel: the one container everything in the workstation sits
 * in.
 *
 * There is exactly one of these so that fourteen panels across four workspaces
 * cannot drift into fourteen slightly different boxes. A panel is a 1px border,
 * a header a shade lighter than its body, and a body that scrolls on its own —
 * which is what lets Mission Control fill a 1366×768 screen without pushing the
 * sensor feed off the bottom.
 *
 * ## Tone
 *
 * `tone` is the panel's provenance, not its decoration:
 *
 *   default   algorithm-safe data — what a real terminal's software would have
 *   truth     privileged simulator state: ground truth, evaluation, debug only
 *   warning   a real degraded condition
 *   fault     a real failure
 *
 * `truth` is the one that matters most. Anything drawn from the simulator's own
 * knowledge is violet-edged and says so in its header, so that a reader can tell
 * at a glance whether they are looking at what the tracker worked out or at the
 * answer key. A screenshot with every truth panel hidden must still show the
 * tracker tracking, and that property is only checkable if the boundary is
 * visible.
 */

import type * as React from 'react';

import { cn } from '@/lib/utils';

export type PanelTone = 'default' | 'truth' | 'warning' | 'fault';

const TONE_BORDER: Record<PanelTone, string> = {
  default: 'border-panel-border',
  truth: 'border-truth/45',
  warning: 'border-status-degraded/45',
  fault: 'border-status-fault/50',
};

const TONE_HEADER: Record<PanelTone, string> = {
  default: 'text-foreground/70',
  truth: 'text-truth',
  warning: 'text-status-degraded',
  fault: 'text-status-fault',
};

export interface PanelProps extends React.ComponentProps<'section'> {
  readonly tone?: PanelTone | undefined;
  /** Removes the border, for a panel already inside a bordered container. */
  readonly flush?: boolean | undefined;
}

export function Panel({
  tone = 'default',
  flush = false,
  className,
  children,
  ...props
}: PanelProps): React.JSX.Element {
  return (
    <section
      data-tone={tone}
      className={cn(
        'flex min-h-0 min-w-0 flex-col overflow-hidden bg-panel',
        !flush && 'rounded-sm border',
        !flush && TONE_BORDER[tone],
        className,
      )}
      {...props}
    >
      {children}
    </section>
  );
}

export interface PanelHeaderProps extends React.ComponentProps<'header'> {
  readonly tone?: PanelTone | undefined;
  readonly icon?: React.ComponentType<{ className?: string; 'aria-hidden'?: boolean }> | undefined;
  readonly title: string;
  /** Sits under the title in small muted type. For the truth disclaimer. */
  readonly subtitle?: string | undefined;
  /** Pushed to the right: counts, units, a status chip. */
  readonly actions?: React.ReactNode;
}

/**
 * A panel header.
 *
 * Small, upper-case, letter-spaced — the label on an instrument rather than a
 * heading in a document. `h2` because a workspace's own title is the `h1` in
 * the title bar; nesting the levels correctly is what lets a screen reader move
 * through the workstation by structure.
 */
export function PanelHeader({
  tone = 'default',
  icon: Icon,
  title,
  subtitle,
  actions,
  className,
  ...props
}: PanelHeaderProps): React.JSX.Element {
  return (
    <header
      className={cn(
        'flex shrink-0 items-center gap-2 border-b px-2.5 py-1.5',
        tone === 'truth' ? 'border-truth/30 bg-truth/8' : 'border-panel-border bg-panel-header',
        className,
      )}
      {...props}
    >
      {Icon !== undefined && <Icon aria-hidden className={cn('size-3.5', TONE_HEADER[tone])} />}
      <div className="flex min-w-0 flex-col">
        <h2
          className={cn(
            'truncate text-[10px] font-semibold tracking-[0.08em] uppercase',
            TONE_HEADER[tone],
          )}
        >
          {title}
        </h2>
        {subtitle !== undefined && (
          <span className="truncate text-[9px] leading-tight text-muted-foreground">
            {subtitle}
          </span>
        )}
      </div>
      {actions !== undefined && (
        <div className="ml-auto flex shrink-0 items-center gap-1.5">{actions}</div>
      )}
    </header>
  );
}

/** A labelled group inside a panel body. */
export function Section({
  title,
  actions,
  className,
  children,
  ...props
}: React.ComponentProps<'div'> & {
  title: string;
  actions?: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className={cn('border-b border-panel-border/60 last:border-b-0', className)} {...props}>
      <div className="flex items-center gap-2 px-2.5 pt-2 pb-1">
        <span className="text-[9px] font-semibold tracking-[0.08em] text-muted-foreground uppercase">
          {title}
        </span>
        {actions !== undefined && <div className="ml-auto flex items-center gap-1">{actions}</div>}
      </div>
      <div className="px-2.5 pb-2">{children}</div>
    </div>
  );
}
