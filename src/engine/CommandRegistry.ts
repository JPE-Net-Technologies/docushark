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
import { isGroup, type RectangleShape } from '../shapes/Shape';
import { useWhiteboardStore } from '../store/whiteboardStore';
import { opener } from '../platform/opener';
import { Vec2 } from '../math/Vec2';
import { nanoid } from 'nanoid';
import { alignHorizontal, alignVertical, distribute } from '../shapes/utils/alignment';
import {
  selectConnectedChain,
  canSelectConnectedChain,
  autoLayoutSelection,
  canAutoLayoutSelection,
} from './selectionLayout';
import type { ShortcutCategory } from './KeyboardShortcuts';
import { LAYOUT_LABELS } from '../ui/layout/modes';
import { LAYOUT_MODES, type LayoutMode } from '../ui/layout/types';
import { parseCombo, eventMatchesAny, formatCombo, type KeyScope } from './keybindings';

export interface Command {
  /** Unique identifier */
  id: string;
  /** Display label */
  label: string;
  /** Category for grouping */
  category: ShortcutCategory;
  /**
   * Binding spec — the single source of truth for this command's shortcut, e.g.
   * `"Mod+Shift+L"` or `"Delete | Backspace"` (`Mod` = ⌘/Ctrl per platform).
   * The display hint (`shortcut`) is derived from this; don't set both by hand.
   */
  keys?: string;
  /** Where the binding is active / dispatched (default `'global'`). */
  scope?: KeyScope;
  /** For `global` bindings: also fire while an input/contenteditable is focused. Default false. */
  whileTyping?: boolean;
  /**
   * Documented for the shortcut help panel but NOT an executable palette action
   * — dispatched by other machinery (ToolManager, the pan/zoom handler) or pure
   * reference (scroll wheel). Hidden from the command palette; `dispatchKey`
   * never runs it.
   */
  reserved?: boolean;
  /**
   * Keyboard shortcut hint (display only). DERIVED from `keys` at build time —
   * only set directly for a command with no real binding.
   */
  shortcut?: string;
  /** Execute the command. Returns true if handled. */
  execute: () => void;
  /** Optional guard — hide command when it returns false / skip dispatch. */
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

/**
 * Create an icon-only shape at the viewport centre (JP-325 #1).
 *
 * An "icon shape" is a rectangle in `icon-only` display mode — the renderer
 * skips fill/stroke and the icon fills the (square) bounds. This is the same
 * shape the PropertyPanel "display as icon" toggle produces; the toolbar entry
 * just makes it a one-step insert with the chosen icon already set.
 */
export function createIconShapeAtCenter(iconId: string): void {
  const handler = shapeRegistry.getHandler('rectangle');
  const { camera } = useSessionStore.getState();
  const id = nanoid();
  const base = handler.create(new Vec2(camera.x, camera.y), id) as RectangleShape;

  const shape: RectangleShape = {
    ...base,
    width: 80,
    height: 80,
    iconId,
    iconDisplayMode: 'icon-only',
  };

  pushHistory('Create icon');
  useDocumentStore.getState().addShape(shape);
  useSessionStore.getState().select([id]);
  useSessionStore.getState().setActiveTool('select');
}

// ---------------------------------------------------------------------------
// All commands
// ---------------------------------------------------------------------------
function buildCommands(): Command[] {
  return [
    // --- Tools (activate draw mode) --- dispatched by ToolManager (scope 'reserved').
    { id: 'tool.select', label: 'Select tool', category: 'Tools', keys: 'V', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('select') },
    { id: 'tool.rectangle', label: 'Rectangle tool', category: 'Tools', keys: 'R', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('rectangle') },
    { id: 'tool.ellipse', label: 'Ellipse tool', category: 'Tools', keys: 'O', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('ellipse') },
    { id: 'tool.line', label: 'Line tool', category: 'Tools', keys: 'L', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('line') },
    { id: 'tool.text', label: 'Text tool', category: 'Tools', keys: 'T', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('text') },
    { id: 'tool.connector', label: 'Connector tool', category: 'Tools', keys: 'C', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('connector') },
    { id: 'tool.pan', label: 'Pan (Hand) tool', category: 'Tools', keys: 'H', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('pan') },

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
      keys: 'Mod+Shift+O', scope: 'global', whileTyping: true,
      // The palette can't reach React state; App listens for this event.
      execute: () => window.dispatchEvent(new CustomEvent('docushark:open-documents')),
    },

    // --- Editing (canvas scope — active when the canvas owns focus) ---
    {
      id: 'edit.undo', label: 'Undo', category: 'Editing', keys: 'Mod+Z', scope: 'canvas',
      execute: () => { if (useHistoryStore.getState().canUndo()) useHistoryStore.getState().undo(); },
    },
    {
      id: 'edit.redo', label: 'Redo', category: 'Editing', keys: 'Mod+Shift+Z | Mod+Y', scope: 'canvas',
      execute: () => { if (useHistoryStore.getState().canRedo()) useHistoryStore.getState().redo(); },
    },
    { id: 'edit.selectAll', label: 'Select all', category: 'Editing', keys: 'Mod+A', scope: 'canvas', execute: () => useSessionStore.getState().selectAll() },
    {
      id: 'edit.delete', label: 'Delete selected', category: 'Editing', keys: 'Delete | Backspace', scope: 'canvas',
      execute: () => { pushHistory('Delete shapes'); deleteSelected(); },
      canExecute: () => useSessionStore.getState().hasSelection(),
    },
    { id: 'edit.clearSelection', label: 'Clear selection', category: 'Editing', keys: 'Escape', scope: 'canvas', execute: () => useSessionStore.getState().clearSelection() },

    // --- Alignment ---
    ...alignmentCommands(),

    // --- Diagram layout (JP-305) ---
    {
      id: 'arrange.selectConnected',
      label: 'Select connected shapes',
      category: 'Editing',
      keys: 'Mod+Shift+A', scope: 'canvas',
      execute: () => selectConnectedChain(),
      canExecute: canSelectConnectedChain,
    },
    {
      id: 'arrange.autoLayoutTB',
      label: 'Auto-layout selection (top to bottom)',
      category: 'Editing',
      keys: 'Mod+Shift+L', scope: 'canvas',
      execute: () => autoLayoutSelection('TB'),
      canExecute: canAutoLayoutSelection,
    },
    {
      id: 'arrange.autoLayoutLR',
      label: 'Auto-layout selection (left to right)',
      category: 'Editing',
      execute: () => autoLayoutSelection('LR'),
      canExecute: canAutoLayoutSelection,
    },

    // --- View ---
    { id: 'view.zoomIn', label: 'Zoom in', category: 'Navigation', keys: 'E', scope: 'canvas', reserved: true, execute: () => {} },
    { id: 'view.zoomOut', label: 'Zoom out', category: 'Navigation', keys: 'Q', scope: 'canvas', reserved: true, execute: () => {} },

    // --- Clipboard + grouping (canvas scope). Copy/paste are engine-coupled
    // (clipboard + spatial index) so they bridge to the engine via an event;
    // group/ungroup are pure store ops and run directly. ---
    {
      id: 'edit.copy', label: 'Copy', category: 'Editing', keys: 'Mod+C', scope: 'canvas',
      execute: () => window.dispatchEvent(new CustomEvent('docushark:copy-shapes')),
      canExecute: () => useSessionStore.getState().hasSelection(),
    },
    {
      id: 'edit.paste', label: 'Paste', category: 'Editing', keys: 'Mod+V', scope: 'canvas',
      execute: () => window.dispatchEvent(new CustomEvent('docushark:paste-shapes')),
    },
    {
      id: 'edit.group', label: 'Group selected shapes', category: 'Editing', keys: 'Mod+G', scope: 'canvas',
      execute: () => {
        const ids = useSessionStore.getState().getSelectedIds();
        if (ids.length < 2) return;
        pushHistory('Group shapes');
        const groupId = nanoid();
        useDocumentStore.getState().groupShapes(ids, groupId);
        useSessionStore.getState().select([groupId]);
      },
      canExecute: () => getSelectedShapes().length >= 2,
    },
    {
      id: 'edit.ungroup', label: 'Ungroup', category: 'Editing', keys: 'Mod+Shift+G', scope: 'canvas',
      execute: () => {
        const ids = useSessionStore.getState().getSelectedIds();
        if (ids.length !== 1) return;
        const shape = useDocumentStore.getState().shapes[ids[0]!];
        if (!shape || !isGroup(shape)) return;
        pushHistory('Ungroup shapes');
        const childIds = [...shape.childIds];
        useDocumentStore.getState().ungroupShape(shape.id);
        useSessionStore.getState().select(childIds);
      },
    },

    // --- View / app (global scope) ---
    {
      id: 'view.toggleWhiteboard', label: 'Toggle whiteboard (Ideas)', category: 'View', keys: 'Mod+I', scope: 'global',
      execute: () => useWhiteboardStore.getState().toggleVisibility(),
    },
    {
      id: 'view.commandPalette', label: 'Command palette', category: 'View', keys: 'Mod+K', scope: 'global', whileTyping: true,
      execute: () => window.dispatchEvent(new CustomEvent('docushark:toggle-command-palette')),
    },
    {
      // Shape search; suppressed while typing so the prose find (Ctrl+F in the
      // editor) wins when the editor is focused.
      id: 'view.searchShapes', label: 'Search shapes', category: 'View', keys: 'Mod+F', scope: 'global',
      execute: () => window.dispatchEvent(new CustomEvent('docushark:toggle-search')),
    },
    {
      id: 'view.docs', label: 'Open documentation', category: 'View', keys: 'F1', scope: 'global', whileTyping: true,
      execute: () => { void opener.openDocs(); },
    },

    // --- Reference-only rows for the help panel (dispatched by other machinery
    // or pure reference; hidden from the palette). ---
    { id: 'ref.pan', label: 'Pan canvas', category: 'Navigation', keys: 'W', scope: 'canvas', reserved: true, execute: () => {} },
    { id: 'ref.nudge', label: 'Nudge shapes / pan', category: 'Navigation', keys: 'ArrowUp', scope: 'canvas', reserved: true, execute: () => {} },
    { id: 'ref.scroll', label: 'Zoom at cursor', category: 'Navigation', shortcut: 'Scroll', reserved: true, execute: () => {} },
    { id: 'ref.help', label: 'Keyboard shortcuts', category: 'View', keys: 'Shift+/', scope: 'global', reserved: true, execute: () => {} },

    // --- Layouts ---
    ...layoutCommands(),
    {
      id: 'view.cycleRelaxedFocus',
      label: 'Cycle prose / split / diagram focus',
      category: 'View',
      keys: 'Mod+Shift+\\', scope: 'global', whileTyping: true,
      execute: () => useSessionStore.getState().cycleRelaxedFocus(),
      // Focus only applies to the writing-first Relaxed layout.
      canExecute: () => useUIPreferencesStore.getState().layout.defaultMode === 'relaxed',
    },
  ];
}

/**
 * The command catalogue — the single source of truth for shortcuts. The display
 * hint (`shortcut`) is DERIVED here from each command's `keys` spec, so the
 * palette + help panel can never drift from the real binding.
 */
export function getAllCommands(): Command[] {
  return buildCommands().map((c) =>
    c.keys ? { ...c, shortcut: formatCombo(c.keys) } : c,
  );
}

/** Commands the user can run from the palette (executable, non-reserved). */
export function getPaletteCommands(): Command[] {
  return getAllCommands().filter((c) => !c.reserved);
}

/**
 * Dispatch a keyboard event against the registry for a given scope. Returns true
 * if a command matched and ran. `reserved` commands are never dispatched here
 * (their keys are owned by ToolManager / the pan handler / prose). For `global`
 * scope, bindings without `whileTyping` are skipped while an input/textarea/
 * contenteditable is focused.
 */
export function dispatchKey(event: KeyboardEvent, scope: KeyScope): boolean {
  const typing = isTypingContext();
  for (const cmd of getAllCommands()) {
    if (cmd.reserved || !cmd.keys || (cmd.scope ?? 'global') !== scope) continue;
    if (scope === 'global' && typing && !cmd.whileTyping) continue;
    if (!eventMatchesAny(event, parseCombo(cmd.keys))) continue;
    if (cmd.canExecute && !cmd.canExecute()) continue;
    event.preventDefault();
    cmd.execute();
    recordRecent(cmd.id);
    return true;
  }
  return false;
}

function isTypingContext(): boolean {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  if (!el) return false;
  const tag = el.tagName?.toLowerCase();
  return tag === 'input' || tag === 'textarea' || (el as HTMLElement).isContentEditable === true;
}

/**
 * Dev/test guardrail: return any two bindings that collide on the same combo +
 * scope. Reserved entries participate (a real binding must not shadow a reserved
 * one in the same scope); cross-scope duplicates (e.g. Mod+F global vs prose)
 * are allowed.
 */
export function findShortcutConflicts(): Array<{ a: string; b: string; combo: string }> {
  const seen = new Map<string, string>();
  const conflicts: Array<{ a: string; b: string; combo: string }> = [];
  for (const cmd of getAllCommands()) {
    if (!cmd.keys) continue;
    const scope = cmd.scope ?? 'global';
    for (const combo of parseCombo(cmd.keys)) {
      const sig = `${scope}::${combo.ctrl}${combo.meta}${combo.shift}${combo.alt}:${combo.key}`;
      const prev = seen.get(sig);
      if (prev) conflicts.push({ a: prev, b: cmd.id, combo: formatCombo(cmd.keys) });
      else seen.set(sig, cmd.id);
    }
  }
  return conflicts;
}

function layoutCommands(): Command[] {
  return LAYOUT_MODES.map((mode, idx) => ({
    id: `view.layout.${mode}`,
    label: `Switch to ${LAYOUT_LABELS[mode]} layout`,
    category: 'View' as const,
    keys: `Mod+Shift+${idx + 1}`,
    scope: 'global' as const,
    whileTyping: true,
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
