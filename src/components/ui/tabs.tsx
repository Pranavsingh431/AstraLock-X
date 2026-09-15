/**
 * Tabs, restyled into the workstation's language.
 *
 * Radix for the behaviour — roving focus, arrow-key navigation, the right ARIA
 * roles — and our own appearance: a row of small upper-case labels with the
 * active one underlined in the instrument cyan, rather than the pill-shaped
 * default. They read as the tabs on a piece of test equipment, which is what
 * they are selecting between.
 */

import * as TabsPrimitive from '@radix-ui/react-tabs';
import type * as React from 'react';

import { cn } from '@/lib/utils';

function Tabs({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Root>): React.JSX.Element {
  return (
    <TabsPrimitive.Root
      data-slot="tabs"
      className={cn('flex min-h-0 flex-col', className)}
      {...props}
    />
  );
}

function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.List>): React.JSX.Element {
  return (
    <TabsPrimitive.List
      data-slot="tabs-list"
      className={cn('flex shrink-0 items-stretch gap-px border-b border-panel-border', className)}
      {...props}
    />
  );
}

function TabsTrigger({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Trigger>): React.JSX.Element {
  return (
    <TabsPrimitive.Trigger
      data-slot="tabs-trigger"
      className={cn(
        'relative -mb-px border-b-2 border-transparent px-2.5 py-1.5 text-[10px] font-semibold tracking-[0.08em] whitespace-nowrap text-muted-foreground uppercase',
        'transition-colors hover:text-foreground',
        'data-[state=active]:border-status-active data-[state=active]:text-status-active',
        'disabled:pointer-events-none disabled:opacity-40',
        className,
      )}
      {...props}
    />
  );
}

function TabsContent({
  className,
  ...props
}: React.ComponentProps<typeof TabsPrimitive.Content>): React.JSX.Element {
  return (
    <TabsPrimitive.Content
      data-slot="tabs-content"
      className={cn('min-h-0 flex-1 outline-none', className)}
      {...props}
    />
  );
}

export { Tabs, TabsList, TabsTrigger, TabsContent };
