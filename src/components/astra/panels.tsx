/**
 * Resizable panel groups, restyled for the workstation.
 *
 * Thin wrappers over `react-resizable-panels` so that every drag handle in the
 * application looks and behaves the same: a 1px rule that thickens and turns
 * cyan when you grab it, and that a keyboard user can move with the arrow keys
 * because the underlying library gives it a role and a tabindex.
 *
 * The constraints matter more than the styling. Every panel in Mission Control
 * declares a minimum size, so dragging cannot reduce the sensor feed to a
 * sliver that is technically still present and practically useless.
 */

import { Separator } from 'react-resizable-panels';
import type * as React from 'react';

import { cn } from '@/lib/utils';

/**
 * The handle between two panels.
 *
 * The hit area is deliberately larger than the visible rule — a 1px target is
 * a 1px target — while the rule itself stays thin so a layout of six panels
 * does not read as a grid of thick dividers.
 */
export function ResizeHandle({
  direction,
  className,
  ...props
}: React.ComponentProps<typeof Separator> & {
  direction: 'horizontal' | 'vertical';
}): React.JSX.Element {
  return (
    <Separator
      className={cn(
        'group relative flex shrink-0 items-center justify-center bg-panel-border/60',
        'transition-colors outline-none data-[state=dragging]:bg-status-active',
        'hover:bg-status-active/60 focus-visible:bg-status-active',
        direction === 'horizontal' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize',
        className,
      )}
      {...props}
    >
      {/* The grab area, invisible and centred on the rule. */}
      <span
        aria-hidden
        className={cn(
          'absolute',
          direction === 'horizontal' ? '-inset-x-1 inset-y-0' : 'inset-x-0 -inset-y-1',
        )}
      />
    </Separator>
  );
}
