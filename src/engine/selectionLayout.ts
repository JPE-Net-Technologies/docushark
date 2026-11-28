/**
 * Selection-scoped layout actions (JP-305 Slice D) — the single implementation
 * behind the context menu, command palette, and keyboard shortcuts so all three
 * surfaces behave identically.
 *
 * - `selectConnectedChain` expands the selection to the whole connected
 *   component(s) of what's selected (a pure selection change — not undoable,
 *   so no history entry).
 * - `autoLayoutSelection` tidies the selected shapes with the shared Sugiyama
 *   auto-layout; one history entry, applied through the document store (which
 *   reroutes connectors), matching the alignment commands' pattern.
 * - `rebuildConnectorRoutes` re-seats every connector on the page; one history
 *   entry, the same pattern. (Page-wide rather than selection-scoped, but the
 *   same kind of layout command.)
 */

import { useSessionStore } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { pushHistory } from '../store/historyStore';
import { findConnectedShapes } from '../shapes/connectivity';
import type { GraphDirection } from '../shapes/import/layoutGraph';

/** True when the current selection touches at least one connector-linked shape. */
export function canSelectConnectedChain(): boolean {
  return useSessionStore.getState().getSelectedIds().length >= 1;
}

/** Expand the selection to the full connected chain(s) of the current selection. */
export function selectConnectedChain(): void {
  const session = useSessionStore.getState();
  const seedIds = session.getSelectedIds();
  if (seedIds.length === 0) return;
  const connected = findConnectedShapes(seedIds, useDocumentStore.getState().shapes);
  if (connected.length > seedIds.length) {
    session.select(connected);
  }
}

/** True when there are enough shapes selected for auto-layout to do anything. */
export function canAutoLayoutSelection(): boolean {
  return useSessionStore.getState().getSelectedIds().length >= 2;
}

/**
 * Tidy the selected shapes with the shared auto-layout. `direction` controls
 * the flow (top-to-bottom by default). No-op for fewer than two shapes.
 */
export function autoLayoutSelection(direction: GraphDirection = 'TB'): void {
  const ids = useSessionStore.getState().getSelectedIds();
  if (ids.length < 2) return;
  pushHistory('Auto-layout');
  useDocumentStore.getState().autoLayoutShapes(ids, { direction });
}

/**
 * Rebuild every connector route on the page: the canvas toolbar's "Rebuild all
 * connector routes". Like every other command, it opens its own history step
 * first. Without one, undo after a rebuild restored the step before it, so it
 * also reverted the edit made just before; in a collaborative document, the
 * rebuild's writes didn't close an undo step of their own.
 */
export function rebuildConnectorRoutes(): void {
  pushHistory('Rebuild connector routes');
  useDocumentStore.getState().rebuildAllConnectorRoutes();
}
