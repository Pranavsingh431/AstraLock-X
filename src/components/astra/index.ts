/**
 * The AstraLock-X visual system.
 *
 * A small set of primitives — a panel, a readout, a status chip, a table, a
 * chart frame — rather than a component library. Its whole purpose is that four
 * workspaces built by different means still look like one instrument, and that
 * the rules which matter (a number carries its unit, absence is not zero,
 * privileged data is visibly privileged) are decided once instead of per panel.
 */

export * from './panel';
export * from './readout';
export * from './table';
export * from './chart';
export * from './chart-tokens';
export * from './panels';
export * from './pat-state';

// The resizable-panel primitives are re-exported here rather than from
// `panels.tsx`, so that file exports only components and Fast Refresh keeps
// working on it.
export { Group as SplitGroup, Panel as SplitPanel, useGroupRef } from 'react-resizable-panels';
