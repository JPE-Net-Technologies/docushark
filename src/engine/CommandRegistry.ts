/**
 * Central command registry for the command palette.
 *
 * Every dispatchable action in the app is registered here with metadata
 * for display, keyboard shortcut hints, and execution.
 */

import type { ReactNode } from 'react';
import type { LucideIcon } from 'lucide-react';
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignHorizontalJustifyCenter,
  AlignHorizontalSpaceAround,
  AlignStartHorizontal,
  AlignStartVertical,
  AlignVerticalJustifyCenter,
  AlignVerticalSpaceAround,
  BookOpen,
  BoxSelect,
  ChevronLeft,
  ChevronRight,
  Circle,
  CirclePlus,
  ClipboardPaste,
  Columns2,
  Copy,
  FileDown,
  FileInput,
  FolderOpen,
  Group,
  Hand,
  History,
  Minus,
  MousePointer2,
  Network,
  PanelLeft,
  Redo2,
  ScanSearch,
  Search,
  Spline,
  Square,
  SquareDashed,
  SquarePlus,
  StickyNote,
  Trash2,
  Type,
  TypeOutline,
  Undo2,
  Ungroup,
  Waypoints,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';

import { useSessionStore, deleteSelected, getSelectedShapes } from '../store/sessionStore';
import { useDocumentStore } from '../store/documentStore';
import { useHistoryStore, pushHistory } from '../store/historyStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import { isGroup, type RectangleShape } from '../shapes/Shape';
import { useWhiteboardStore } from '../store/whiteboardStore';
import { isActiveDocReadOnly, getActiveDocumentRecord } from '../store/documentRegistry';
import { relaySessionUsable } from '../store/connectionStore';
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
import { LAYOUT_LABELS, LAYOUT_PRESETS } from '../ui/layout/modes';
import { LAYOUT_MODES, type LayoutMode } from '../ui/layout/types';
import { parseCombo, eventMatchesAny, formatCombo, type KeyScope } from './keybindings';
import { navigateActivePage } from './pageNavigation';

/**
 * A place a command can be offered to the user.
 *
 * There is deliberately no `'shortcut'` surface: whether a command has a key
 * binding is already answered by `keys`, and a second way to say it would drift
 * from the first.
 */
export type ActionSurface = 'palette' | 'tools';

/**
 * Extra commands contributed by feature areas, keyed by source id.
 *
 * The registry is engine-level and must not import feature stores — integrations
 * know about entitlement and connected providers, and the engine should not.
 * A feature registers a source at module init and returns whatever is currently
 * available; `buildCommands()` already runs fresh on every read, so a source is
 * free to consult live store state and its commands appear and disappear with
 * it.
 *
 * Keyed rather than appended so registering twice (a dev-server module reload)
 * replaces rather than duplicates.
 */
const commandSources = new Map<string, () => Command[]>();

/** Contribute commands from a feature area. Replaces any source with the same id. */
export function registerCommandSource(id: string, source: () => Command[]): void {
  commandSources.set(id, source);
}

/** Remove a contributed source (tests, and teardown of an optional feature). */
export function unregisterCommandSource(id: string): void {
  commandSources.delete(id);
}

function contributedCommands(): Command[] {
  const out: Command[] = [];
  for (const [id, source] of commandSources) {
    try {
      out.push(...source());
    } catch (e) {
      // A broken contributor must not take out the palette or the toolbar — the
      // core commands are the ones the user cannot work without.
      console.error(`[CommandRegistry] command source "${id}" threw:`, e);
    }
  }
  return out;
}

/**
 * Version history needs a relay-backed document and a usable REST session.
 * Defined once here and consumed by the command below, so the toolbar no longer
 * carries its own copy of the rule.
 */
function versionHistoryAvailable(): boolean {
  const record = getActiveDocumentRecord();
  return (record?.type === 'remote' || record?.type === 'cached') && relaySessionUsable();
}

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
  /**
   * Glyph for surfaces that show one. The tile system's anatomy opens with an
   * icon chip, so a command without an icon cannot appear in the Tools grid —
   * `toolsActions()` drops it rather than rendering a hole.
   */
  icon?: LucideIcon;
  /**
   * A rendered mark, for anything that is not a Lucide glyph — an integration
   * provider's brand SVG. Satisfies the tile system's icon chip in place of
   * `icon`; surfaces prefer it when both are present.
   */
  iconNode?: ReactNode;
  /**
   * Where this command is offered. Defaults to the palette only, which is what
   * every command did before surfaces existed — opting into `'tools'` is what
   * puts a command in the Tools grid.
   */
  surfaces?: readonly ActionSurface[];
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
    { id: 'tool.select', icon: MousePointer2, label: 'Select tool', category: 'Tools', keys: 'V', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('select') },
    { id: 'tool.rectangle', icon: Square, label: 'Rectangle tool', category: 'Tools', keys: 'R', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('rectangle') },
    { id: 'tool.ellipse', icon: Circle, label: 'Ellipse tool', category: 'Tools', keys: 'O', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('ellipse') },
    { id: 'tool.line', icon: Minus, label: 'Line tool', category: 'Tools', keys: 'L', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('line') },
    { id: 'tool.text', icon: Type, label: 'Text tool', category: 'Tools', keys: 'T', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('text') },
    { id: 'tool.connector', icon: Spline, label: 'Connector tool', category: 'Tools', keys: 'C', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('connector') },
    { id: 'tool.pan', icon: Hand, label: 'Pan (Hand) tool', category: 'Tools', keys: 'H', scope: 'canvas', reserved: true, execute: () => useSessionStore.getState().setActiveTool('pan') },

    // --- Add shape (instant create at viewport center) ---
    { id: 'add.rectangle', icon: SquarePlus, label: 'Add rectangle', category: 'Editing', execute: () => createShapeAtCenter('rectangle') },
    { id: 'add.ellipse', icon: CirclePlus, label: 'Add ellipse', category: 'Editing', execute: () => createShapeAtCenter('ellipse') },
    { id: 'add.text', icon: TypeOutline, label: 'Add text', category: 'Editing', execute: () => createShapeAtCenter('text') },
    { id: 'add.line', icon: Minus, label: 'Add line', category: 'Editing', execute: () => createShapeAtCenter('line') },
    { id: 'add.connector', icon: Waypoints, label: 'Add connector', category: 'Editing', execute: () => createShapeAtCenter('connector') },

    // --- Import ---
    {
      id: 'import.diagram',
      label: 'Import diagram…',
      category: 'File',
      icon: FileInput,
      surfaces: ['palette', 'tools'],
      // The palette can't reach the engine; CanvasContainer opens the picker.
      execute: () => window.dispatchEvent(new CustomEvent('docushark:import-diagram')),
      // JP-370: import writes into the active doc → unavailable view-only (mirror
      // the toolbar button's guard, which the palette path otherwise bypasses).
      canExecute: () => !isActiveDocReadOnly(),
    },

    // Version history was previously built inline in the toolbar and existed
    // nowhere else, so the palette could not reach it at all. Defining it here
    // is what makes the Tools grid and the palette the same list.
    {
      id: 'file.versionHistory',
      label: 'Version history',
      category: 'File',
      icon: History,
      surfaces: ['palette', 'tools'],
      execute: () => window.dispatchEvent(new CustomEvent('docushark:open-version-history')),
      canExecute: () => versionHistoryAvailable(),
    },

    // --- Export (PDF) --- the dialog lives in UnifiedToolbar's local state, so
    // the palette opens it by event, mirroring the import bridge above.
    {
      id: 'file.exportPdf',
      label: 'Export to PDF…',
      category: 'File',
      icon: FileDown,
      surfaces: ['palette', 'tools'],
      execute: () => window.dispatchEvent(new CustomEvent('docushark:open-pdf-export')),
    },

    // --- Documents surface (JP-218) ---
    {
      id: 'view.documents', icon: FolderOpen,
      label: 'Go to Documents',
      category: 'File',
      keys: 'Mod+Shift+O', scope: 'global', whileTyping: true,
      // The palette can't reach React state; App listens for this event.
      execute: () => window.dispatchEvent(new CustomEvent('docushark:open-documents')),
    },

    // --- Page navigation (JP-357) --- steps the focused surface's pages (prose
    // when the editor is focused, canvas otherwise). Literal Ctrl (not Mod):
    // Ctrl+Tab is the cross-platform tab-cycle even on macOS. whileTyping so it
    // works while the prose editor is focused. The keys are browser-reserved in
    // the web PWA (work in desktop); the palette entries are the web path.
    {
      id: 'page.next', icon: ChevronRight, label: 'Next page', category: 'Navigation',
      keys: 'Ctrl+PageDown | Ctrl+Tab', scope: 'global', whileTyping: true,
      execute: () => navigateActivePage('next'),
    },
    {
      id: 'page.prev', icon: ChevronLeft, label: 'Previous page', category: 'Navigation',
      keys: 'Ctrl+PageUp | Ctrl+Shift+Tab', scope: 'global', whileTyping: true,
      execute: () => navigateActivePage('prev'),
    },

    // --- Editing (canvas scope — active when the canvas owns focus) ---
    {
      id: 'edit.undo', icon: Undo2, label: 'Undo', category: 'Editing', keys: 'Mod+Z', scope: 'canvas',
      execute: () => { if (useHistoryStore.getState().canUndo()) useHistoryStore.getState().undo(); },
      // JP-370: undo/redo aren't selection-gated, so the read-only clear-selection
      // trick doesn't cover them — block them on a view-only doc.
      canExecute: () => !isActiveDocReadOnly() && useHistoryStore.getState().canUndo(),
    },
    {
      id: 'edit.redo', icon: Redo2, label: 'Redo', category: 'Editing', keys: 'Mod+Shift+Z | Mod+Y', scope: 'canvas',
      execute: () => { if (useHistoryStore.getState().canRedo()) useHistoryStore.getState().redo(); },
      canExecute: () => !isActiveDocReadOnly() && useHistoryStore.getState().canRedo(),
    },
    { id: 'edit.selectAll', icon: BoxSelect, label: 'Select all', category: 'Editing', keys: 'Mod+A', scope: 'canvas', execute: () => useSessionStore.getState().selectAll() },
    {
      id: 'edit.delete', icon: Trash2, label: 'Delete selected', category: 'Editing', keys: 'Delete | Backspace', scope: 'canvas',
      execute: () => { pushHistory('Delete shapes'); deleteSelected(); },
      canExecute: () => useSessionStore.getState().hasSelection(),
    },
    { id: 'edit.clearSelection', icon: SquareDashed, label: 'Clear selection', category: 'Editing', keys: 'Escape', scope: 'canvas', execute: () => useSessionStore.getState().clearSelection() },

    // --- Alignment ---
    ...alignmentCommands(),

    // --- Diagram layout (JP-305) ---
    {
      id: 'arrange.selectConnected', icon: Network,
      label: 'Select connected shapes',
      category: 'Editing',
      keys: 'Mod+Shift+A', scope: 'canvas',
      execute: () => selectConnectedChain(),
      canExecute: canSelectConnectedChain,
    },
    {
      id: 'arrange.autoLayoutTB', icon: AlignVerticalJustifyCenter,
      label: 'Auto-layout selection (top to bottom)',
      category: 'Editing',
      keys: 'Mod+Shift+L', scope: 'canvas',
      execute: () => autoLayoutSelection('TB'),
      canExecute: canAutoLayoutSelection,
    },
    {
      id: 'arrange.autoLayoutLR', icon: AlignHorizontalJustifyCenter,
      label: 'Auto-layout selection (left to right)',
      category: 'Editing',
      execute: () => autoLayoutSelection('LR'),
      canExecute: canAutoLayoutSelection,
    },

    // --- View ---
    { id: 'view.zoomIn', icon: ZoomIn, label: 'Zoom in', category: 'Navigation', keys: 'E', scope: 'canvas', reserved: true, execute: () => {} },
    { id: 'view.zoomOut', icon: ZoomOut, label: 'Zoom out', category: 'Navigation', keys: 'Q', scope: 'canvas', reserved: true, execute: () => {} },

    // --- Clipboard + grouping (canvas scope). Copy/paste are engine-coupled
    // (clipboard + spatial index) so they bridge to the engine via an event;
    // group/ungroup are pure store ops and run directly. ---
    {
      id: 'edit.copy', icon: Copy, label: 'Copy', category: 'Editing', keys: 'Mod+C', scope: 'canvas',
      execute: () => window.dispatchEvent(new CustomEvent('docushark:copy-shapes')),
      canExecute: () => useSessionStore.getState().hasSelection(),
    },
    {
      id: 'edit.paste', icon: ClipboardPaste, label: 'Paste', category: 'Editing', keys: 'Mod+V', scope: 'canvas',
      execute: () => window.dispatchEvent(new CustomEvent('docushark:paste-shapes')),
      // JP-370: paste isn't selection-gated either (the engine also guards).
      canExecute: () => !isActiveDocReadOnly(),
    },
    {
      id: 'edit.group', icon: Group, label: 'Group selected shapes', category: 'Editing', keys: 'Mod+G', scope: 'canvas',
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
      id: 'edit.ungroup', icon: Ungroup, label: 'Ungroup', category: 'Editing', keys: 'Mod+Shift+G', scope: 'canvas',
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
      id: 'view.toggleWhiteboard', label: 'Whiteboard', category: 'View', keys: 'Mod+I', scope: 'global',
      icon: StickyNote,
      surfaces: ['palette', 'tools'],
      execute: () => useWhiteboardStore.getState().toggleVisibility(),
    },
    {
      id: 'view.commandPalette', icon: Search, label: 'Command palette', category: 'View', keys: 'Mod+K', scope: 'global', whileTyping: true,
      execute: () => window.dispatchEvent(new CustomEvent('docushark:toggle-command-palette')),
    },
    {
      // Shape search; suppressed while typing so the prose find (Ctrl+F in the
      // editor) wins when the editor is focused.
      id: 'view.searchShapes', icon: ScanSearch, label: 'Search shapes', category: 'View', keys: 'Mod+F', scope: 'global',
      execute: () => window.dispatchEvent(new CustomEvent('docushark:toggle-search')),
    },
    {
      id: 'view.docs', icon: BookOpen, label: 'Open documentation', category: 'View', keys: 'F1', scope: 'global', whileTyping: true,
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
      id: 'view.cycleRelaxedFocus', icon: Columns2,
      label: 'Cycle prose / split / diagram focus',
      category: 'View',
      keys: 'Mod+Shift+\\', scope: 'global', whileTyping: true,
      execute: () => useSessionStore.getState().cycleRelaxedFocus(),
      // Focus only applies to the writing-first Relaxed layout.
      canExecute: () => useUIPreferencesStore.getState().layout.defaultMode === 'relaxed',
    },
    {
      id: 'view.toggleNavigator', icon: PanelLeft,
      label: 'Toggle Navigator panel',
      category: 'View',
      scope: 'global',
      // No default binding — Mod+Shift+1..4 belong to layouts; the palette (and
      // the panel-chrome menu / Settings → Layout) are the affordances (JP-475).
      execute: () => {
        const prefs = useUIPreferencesStore.getState();
        const mode = prefs.layout.defaultMode;
        const visible =
          prefs.layout.modeOverrides[mode]?.navigator?.visible ??
          LAYOUT_PRESETS[mode].navigator.visible;
        prefs.setPanelVisibleFor(mode, 'navigator', !visible);
      },
    },
  ];
}

/**
 * The command catalogue — the single source of truth for shortcuts. The display
 * hint (`shortcut`) is DERIVED here from each command's `keys` spec, so the
 * palette + help panel can never drift from the real binding.
 */
export function getAllCommands(): Command[] {
  return [...buildCommands(), ...contributedCommands()].map((c) =>
    c.keys ? { ...c, shortcut: formatCombo(c.keys) } : c,
  );
}

/** True when `c` is offered on `surface` (absent `surfaces` = palette only). */
export function isOnSurface(c: Command, surface: ActionSurface): boolean {
  return (c.surfaces ?? ['palette']).includes(surface);
}

/**
 * Commands for the Tools grid: opted in, currently available, and carrying an
 * icon (the tile anatomy needs one). This is the single list the Tools surface
 * renders — it does not maintain its own copy of what the app can do, which is
 * how the toolbar and the palette came to describe the same four actions with
 * different labels and two different paths into the PDF dialog.
 */
export function getToolsActions(): Command[] {
  return getAllCommands().filter(
    (c) =>
      !c.reserved &&
      // The tile anatomy opens with a chip, so an action with neither a glyph
      // nor a mark cannot render — drop it rather than leave a hole.
      (c.icon || c.iconNode) &&
      isOnSurface(c, 'tools') &&
      (!c.canExecute || c.canExecute()),
  );
}

/** Commands the user can run from the palette (executable, non-reserved). */
export function getPaletteCommands(): Command[] {
  return getAllCommands().filter((c) => !c.reserved && isOnSurface(c, 'palette'));
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
    { id: 'align.left', icon: AlignStartVertical, label: 'Align left', category: 'Editing', execute: () => { pushHistory('Align shapes'); const u = alignHorizontal(getSelectedShapes(), 'left'); if (u.length) updateShapes(u); }, canExecute: guard },
    { id: 'align.centerH', icon: AlignCenterVertical, label: 'Align center (horizontal)', category: 'Editing', execute: () => { pushHistory('Align shapes'); const u = alignHorizontal(getSelectedShapes(), 'center'); if (u.length) updateShapes(u); }, canExecute: guard },
    { id: 'align.right', icon: AlignEndVertical, label: 'Align right', category: 'Editing', execute: () => { pushHistory('Align shapes'); const u = alignHorizontal(getSelectedShapes(), 'right'); if (u.length) updateShapes(u); }, canExecute: guard },
    { id: 'align.top', icon: AlignStartHorizontal, label: 'Align top', category: 'Editing', execute: () => { pushHistory('Align shapes'); const u = alignVertical(getSelectedShapes(), 'top'); if (u.length) updateShapes(u); }, canExecute: guard },
    { id: 'align.centerV', icon: AlignCenterHorizontal, label: 'Align middle (vertical)', category: 'Editing', execute: () => { pushHistory('Align shapes'); const u = alignVertical(getSelectedShapes(), 'middle'); if (u.length) updateShapes(u); }, canExecute: guard },
    { id: 'align.bottom', icon: AlignEndHorizontal, label: 'Align bottom', category: 'Editing', execute: () => { pushHistory('Align shapes'); const u = alignVertical(getSelectedShapes(), 'bottom'); if (u.length) updateShapes(u); }, canExecute: guard },
    { id: 'align.distributeH', icon: AlignHorizontalSpaceAround, label: 'Distribute horizontally', category: 'Editing', execute: () => { pushHistory('Distribute shapes'); const u = distribute(getSelectedShapes(), 'horizontal'); if (u.length) updateShapes(u); }, canExecute: distGuard },
    { id: 'align.distributeV', icon: AlignVerticalSpaceAround, label: 'Distribute vertically', category: 'Editing', execute: () => { pushHistory('Distribute shapes'); const u = distribute(getSelectedShapes(), 'vertical'); if (u.length) updateShapes(u); }, canExecute: distGuard },
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
