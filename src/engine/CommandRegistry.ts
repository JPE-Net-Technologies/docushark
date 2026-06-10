/**
 * Central command registry for the command palette.
 *
 * Every dispatchable action in the app is registered here with metadata
 * for display, keyboard shortcut hints, and execution.
 */

import { useSessionStore, deleteSelected, getSelectedShapes } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { useHistoryStore, pushHistory } from '../store/historyStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import { Vec2 } from '../math/Vec2';
import { nanoid } from 'nanoid';
import { alignHorizontal, alignVertical, distribute } from '../shapes/utils/alignment';
import type { ShortcutCategory } from './KeyboardShortcuts';
import { LAYOUT_LABELS } from '../ui/layout/modes';
import { LAYOUT_MODES, type LayoutMode } from '../ui/layout/types';

export interface Command {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: string;
  /** Category for grouping */
  category: ShortcutCategory;
  /** Keyboard shortcut hint (display only) */
  shortcut?: string;
  /** Execute the command. Returns true if handled. */
  execute: () => void;
  /** Optional guard — hide command when it returns false */
  canExecute?: () => boolean;
}

/** Recently executed command IDs (most recent first) */
const recentCommandIds: string[] = [];
const MAX_RECENT = 8;

/**
 * Record a command as recently used.
 */
export function recordRecent(id: string): void {
  const idx = recentCommandIds.indexOf(id);
  if (idx !== -1) recentCommandIds.splice(idx, 1);
  recentCommandIds.unshift(id);
  if (recentCommandIds.length > MAX_RECENT) recentCommandIds.pop();
}

/**
 * Get recently used command IDs.
 */
export function getRecentCommandIds(): readonly string[] {
  return recentCommandIds;
}

// ---------------------------------------------------------------------------
// Helper: update multiple shapes (alignment)
// ---------------------------------------------------------------------------
function updateShapes(updates: Array<{ id: string; updates: Record<string, unknown> }>) {
  const store = useDocumentStore.getState();
  for (const u of updates) {
    store.updateShape(u.id, u.updates);
  }
}

// ---------------------------------------------------------------------------
// Helper: create shape at viewport center
// ---------------------------------------------------------------------------
/**
 * Create a default-sized shape at the viewport center.
 * Used by CommandPalette "Add" commands and ShapePicker click-to-add.
 */
export function createShapeAtCenter(shapeType: string): void {
  const handler = shapeRegistry.getHandler(shapeType);
  const { camera } = useSessionStore.getState();
  const id = nanoid();
  const shape = handler.create(new Vec2(camera.x, camera.y), id);

  pushHistory(`Create ${shapeType}`);
  useDocumentStore.getState().addShape(shape);
  useSessionStore.getState().select([id]);
  useSessionStore.getState().setActiveTool('select');
}

// ---------------------------------------------------------------------------
// All commands
// ---------------------------------------------------------------------------
export function getAllCommands(): Command[] {
  return [
    // --- Tools (activate draw mode) ---
    { id: 'tool.select', label: 'Select tool', category: 'Tools', shortcut: 'V', execute: () => useSessionStore.getState().setActiveTool('select') },
    { id: 'tool.rectangle', label: 'Rectangle tool', category: 'Tools', shortcut: 'R', execute: () => useSessionStore.getState().setActiveTool('rectangle') },
    { id: 'tool.ellipse', label: 'Ellipse tool', category: 'Tools', shortcut: 'O', execute: () => useSessionStore.getState().setActiveTool('ellipse') },
    { id: 'tool.line', label: 'Line tool', category: 'Tools', shortcut: 'L', execute: () => useSessionStore.getState().setActiveTool('line') },
    { id: 'tool.text', label: 'Text tool', category: 'Tools', shortcut: 'T', execute: () => useSessionStore.getState().setActiveTool('text') },
    { id: 'tool.connector', label: 'Connector tool', category: 'Tools', shortcut: 'C', execute: () => useSessionStore.getState().setActiveTool('connector') },
    { id: 'tool.pan', label: 'Pan (Hand) tool', category: 'Tools', shortcut: 'H', execute: () => useSessionStore.getState().setActiveTool('pan') },

    // --- Add shape (instant create at viewport center) ---
    { id: 'add.rectangle', label: 'Add rectangle', category: 'Editing', execute: () => createShapeAtCenter('rectangle') },
    { id: 'add.ellipse', label: 'Add ellipse', category: 'Editing', execute: () => createShapeAtCenter('ellipse') },
    { id: 'add.text', label: 'Add text', category: 'Editing', execute: () => createShapeAtCenter('text') },
    { id: 'add.line', label: 'Add line', category: 'Editing', execute: () => createShapeAtCenter('line') },
    { id: 'add.connector', label: 'Add connector', category: 'Editing', execute: () => createShapeAtCenter('connector') },

    // --- Import ---
    {
      id: 'import.diagram',
      label: 'Import diagram (Excalidraw)…',
      category: 'File',
      // The palette can't reach the engine; CanvasContainer opens the picker.
      execute: () => window.dispatchEvent(new CustomEvent('docushark:import-diagram')),
    },

    // --- Documents surface (JP-218) ---
    {
      id: 'view.documents',
      label: 'Go to Documents',
      category: 'File',
      shortcut: 'Ctrl+Shift+O',
      // The palette can't reach React state; App listens for this event.
      execute: () => window.dispatchEvent(new CustomEvent('docushark:open-documents')),
    },

    // --- Editing ---
    {
      id: 'edit.undo', label: 'Undo', category: 'Editing', shortcut: 'Ctrl+Z',
      execute: () => { if (useHistoryStore.getState().canUndo()) useHistoryStore.getState().undo(); },
    },
    {
      id: 'edit.redo', label: 'Redo', category: 'Editing', shortcut: 'Ctrl+Shift+Z',
      execute: () => { if (useHistoryStore.getState().canRedo()) useHistoryStore.getState().redo(); },
    },
    { id: 'edit.selectAll', label: 'Select all', category: 'Editing', shortcut: 'Ctrl+A', execute: () => useSessionStore.getState().selectAll() },
    {
      id: 'edit.delete', label: 'Delete selected', category: 'Editing', shortcut: 'Del',
      execute: () => { pushHistory('Delete shapes'); deleteSelected(); },
      canExecute: () => useSessionStore.getState().hasSelection(),
    },
    { id: 'edit.clearSelection', label: 'Clear selection', category: 'Editing', shortcut: 'Esc', execute: () => useSessionStore.getState().clearSelection() },

    // --- Alignment ---
    ...alignmentCommands(),

    // --- View ---
    { id: 'view.zoomIn', label: 'Zoom in', category: 'Navigation', shortcut: 'E', execute: () => { /* dispatched via Engine key handler */ } },
    { id: 'view.zoomOut', label: 'Zoom out', category: 'Navigation', shortcut: 'Q', execute: () => { /* dispatched via Engine key handler */ } },

    // --- Layouts ---
    ...layoutCommands(),
    {
      id: 'view.cycleRelaxedFocus',
      label: 'Cycle prose / split / diagram focus',
      category: 'View',
      shortcut: 'Ctrl+Shift+\\',
      execute: () => useSessionStore.getState().cycleRelaxedFocus(),
      // Focus only applies to the writing-first Relaxed layout.
      canExecute: () => useUIPreferencesStore.getState().layout.defaultMode === 'relaxed',
    },
  ];
}

function layoutCommands(): Command[] {
  return LAYOUT_MODES.map((mode, idx) => ({
    id: `view.layout.${mode}`,
    label: `Switch to ${LAYOUT_LABELS[mode]} layout`,
    category: 'View' as const,
    shortcut: `Ctrl+Shift+${idx + 1}`,
    execute: () => applyLayoutMode(mode),
  }));
}

/**
 * Apply a layout. Layout is app-level (a single active mode for the whole
 * editor), so this just sets the active mode.
 */
export function applyLayoutMode(mode: LayoutMode): void {
  useUIPreferencesStore.getState().setDefaultLayout(mode);
}

function alignmentCommands(): Command[] {
  const guard = () => getSelectedShapes().length >= 2;
  const distGuard = () => getSelectedShapes().length >= 3;

  return [
    { id: 'align.left', label: 'Align left', category: 'Editing', execute: () => { pushHistory('Align shapes'); const u = alignHorizontal(getSelectedShapes(), 'left'); if (u.length) updateShapes(u); }, canExecute: guard },
    { id: 'align.centerH', label: 'Align center (horizontal)', category: 'Editing', execute: () => { pushHistory('Align shapes'); const u = alignHorizontal(getSelectedShapes(), 'center'); if (u.length) updateShapes(u); }, canExecute: guard },
    { id: 'align.right', label: 'Align right', category: 'Editing', execute: () => { pushHistory('Align shapes'); const u = alignHorizontal(getSelectedShapes(), 'right'); if (u.length) updateShapes(u); }, canExecute: guard },
    { id: 'align.top', label: 'Align top', category: 'Editing', execute: () => { pushHistory('Align shapes'); const u = alignVertical(getSelectedShapes(), 'top'); if (u.length) updateShapes(u); }, canExecute: guard },
    { id: 'align.centerV', label: 'Align middle (vertical)', category: 'Editing', execute: () => { pushHistory('Align shapes'); const u = alignVertical(getSelectedShapes(), 'middle'); if (u.length) updateShapes(u); }, canExecute: guard },
    { id: 'align.bottom', label: 'Align bottom', category: 'Editing', execute: () => { pushHistory('Align shapes'); const u = alignVertical(getSelectedShapes(), 'bottom'); if (u.length) updateShapes(u); }, canExecute: guard },
    { id: 'align.distributeH', label: 'Distribute horizontally', category: 'Editing', execute: () => { pushHistory('Distribute shapes'); const u = distribute(getSelectedShapes(), 'horizontal'); if (u.length) updateShapes(u); }, canExecute: distGuard },
    { id: 'align.distributeV', label: 'Distribute vertically', category: 'Editing', execute: () => { pushHistory('Distribute shapes'); const u = distribute(getSelectedShapes(), 'vertical'); if (u.length) updateShapes(u); }, canExecute: distGuard },
  ];
}

/**
 * Simple fuzzy match — checks if all characters in the query appear in order.
 */
export function fuzzyMatch(query: string, text: string): { match: boolean; score: number } {
  const q = query.toLowerCase();
  const t = text.toLowerCase();

  if (q.length === 0) return { match: true, score: 0 };

  // Prefer substring match
  const substringIdx = t.indexOf(q);
  if (substringIdx !== -1) {
    // Bonus for match at start
    return { match: true, score: substringIdx === 0 ? 100 : 80 };
  }

  // Fall back to subsequence
  let qi = 0;
  let score = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      // Bonus for consecutive matches
      score += 10;
    }
  }

  if (qi === q.length) {
    return { match: true, score };
  }
  return { match: false, score: 0 };
}
