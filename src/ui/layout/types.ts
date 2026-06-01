/**
 * Layout manager types — the four named layouts, their panels, and the per-mode
 * customization overrides users can apply.
 *
 * See the UX Components doc (Linear) for the philosophy behind these names.
 */

/** Named layout modes. Phase A ships these four; Zen is backlogged. */
export type LayoutMode = 'relaxed' | 'designer' | 'technician' | 'power';

/** Side panels addressable by the layout system. */
export type PanelId = 'document' | 'properties' | 'layers';

/** Which side of the canvas a panel docks to when visible. */
export type DockSide = 'left' | 'right';

/**
 * Focus within the writing-first Relaxed layout. `write` is prose-only (canvas
 * one tap away), `split` shows prose alongside a secondary canvas, `diagram`
 * promotes the canvas to primary. Ephemeral app-level UI state (sessionStore),
 * never persisted. On a `compact` viewport `split` is unavailable — the same
 * single-pane shape the future mobile layout will reuse.
 */
export type RelaxedFocus = 'write' | 'split' | 'diagram';

/**
 * Per-panel state within a given layout. `dock` always holds a side (so the
 * user's preferred side survives a hide-then-show round trip); `visible`
 * drives rendering.
 */
export interface PanelState {
  /** Side the panel lives on when visible. Never lost when toggled off. */
  dock: DockSide;
  /** Whether to render the panel at all. */
  visible: boolean;
  /** Position within the dock side; 0 is closest to the canvas. */
  order: number;
  /** Pixel width when docked or pinned; undefined falls back to panel default. */
  width?: number;
  /**
   * When true, a fly-out panel stays open instead of auto-collapsing. Only
   * meaningful in layouts that render the panel as a fly-out.
   */
  pinned?: boolean;
}

/** All panels' state for one layout. */
export type LayoutPanelMap = Record<PanelId, PanelState>;

/**
 * The persisted layout slice in `uiPreferencesStore`.
 *
 * Layout is an **app-level** concern: a single active mode for the whole
 * editor, not keyed per document. (An earlier design kept a `perDoc` map here;
 * it coupled UI prefs to document identity and was removed in the v3
 * migration.) If a document ever needs to *suggest* a layout, that belongs in a
 * separate, isolated metadata payload owned by the document — not in this UI
 * preferences slice — so the access boundary stays clean. A future `mobile`
 * LayoutMode would slot into `LayoutMode` + `LAYOUT_PRESETS` and be selected by
 * the `useBreakpoint` seam rather than stored here.
 */
export interface LayoutState {
  /** The single active layout for the whole app (app-level, not per-doc). */
  defaultMode: LayoutMode;
  /** User customization deltas, scoped per layout so switching is clean. */
  modeOverrides: Record<LayoutMode, Partial<LayoutPanelMap>>;
  /**
   * Opt-in flag for the custom (non-native) window chrome. False by default
   * because native decorations are the safest cross-platform path.
   */
  customChrome: boolean;
}

/** Ordered tuple of all known layouts, useful for selectors and tests. */
export const LAYOUT_MODES: readonly LayoutMode[] = [
  'relaxed',
  'designer',
  'technician',
  'power',
] as const;

/** Ordered tuple of all known panels. */
export const PANEL_IDS: readonly PanelId[] = ['document', 'properties', 'layers'] as const;
