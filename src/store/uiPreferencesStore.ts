/**
 * UI Preferences store for persisting UI state across sessions.
 *
 * Stores user preferences like expanded/collapsed sections, panel widths, etc.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type {
  DockSide,
  LayoutMode,
  LayoutState,
  PanelId,
  PanelState,
} from '../ui/layout/types';
import { LAYOUT_MODES } from '../ui/layout/types';
import { LAYOUT_PRESETS } from '../ui/layout/modes';
import type { MotionPreference } from '../platform/adaptiveBudget';
import { device } from '../platform/device';

export type DocumentBrowserView = 'list' | 'grid';
export type DocumentBrowserSort =
  | 'modified-desc'
  | 'modified-asc'
  | 'name-asc'
  | 'name-desc'
  | 'created-desc';
export type DocumentBrowserGroupBy = 'none' | 'collection';

/**
 * Accent hue driving the `--color-primary*` tokens. `'default'` keeps the
 * theme's own accent (navy in light, gold in dark) by adding no override.
 */
/** The light/dark base a custom theme builds on (mirrors themeStore's resolved theme). */
export type ThemeBase = 'light' | 'dark';

/** The user-controllable color slots of a custom theme. */
export type ThemeColorSlot = 'primary' | 'cta' | 'surface' | 'text';

/**
 * A sparse set of color overrides (hex). Only the slots the user set are
 * present; everything else falls through to the base token set in index.css —
 * which is how coverage stays complete (no token can be "missing").
 */
export type ThemeInputs = Partial<Record<ThemeColorSlot, string>>;

/** Per-base custom-theme inputs, so light + dark are customized independently. */
export interface ThemeBuild {
  light: ThemeInputs;
  dark: ThemeInputs;
}

/** Chrome spacing density — tightens/loosens spacing + control heights. */
export type Density = 'compact' | 'normal' | 'spacious';

/** Prose editor background preset (token-based gradients; `default` = base behavior). */
export type ProseBackground = 'default' | 'flat' | 'glow' | 'aurora';

/** Bounds for the interface-size (UI scale) multiplier. */
export const UI_SCALE_MIN = 0.9;
export const UI_SCALE_MAX = 1.25;

/** App-wide appearance preferences. (Theme light/dark base lives in `themeStore`.) */
export interface AppearancePrefs {
  /** Custom-theme color overrides per base; empty objects = the base defaults. */
  themeInputs: ThemeBuild;
  /** Interface-motion preference; fed into the adaptive motion budget. */
  motion: MotionPreference;
  /** Spacing density (chrome only). */
  density: Density;
  /** Interface size multiplier (rem root scale); clamped to [0.9, 1.25]. */
  uiScale: number;
  /** Prose editor background preset. */
  proseBackground: ProseBackground;
}

/**
 * UI preferences state.
 */
export interface UIPreferencesState {
  /** Expanded state of property panel sections */
  expandedSections: Record<string, boolean>;
  /** Unit used to display/edit shape rotation in the property panel. */
  rotationUnit: 'degrees' | 'radians';
  /** Property panel width */
  propertyPanelWidth: number;
  /**
   * Width (px) of the secondary canvas pane in the Relaxed `split` focus — the
   * draggable divider between the prose editor and the canvas. App-level.
   * `null` means "no explicit width yet" — a responsive ~50/50 CSS default
   * governs until the user drags the divider (which stores a concrete px).
   */
  relaxedSplitCanvasWidth: number | null;
  /** Document browser layout */
  documentBrowserView: DocumentBrowserView;
  /** Document browser sort key */
  documentBrowserSort: DocumentBrowserSort;
  /** Document browser grouping mode */
  documentBrowserGroupBy: DocumentBrowserGroupBy;
  /** Per-collection collapsed state in the browser (collectionId -> collapsed). */
  documentBrowserCollapsed: Record<string, boolean>;
  /**
   * Whether the one-time "how storage works" toast has been shown after a
   * Cloud workspace connect. Persisted so it fires at most once per browser.
   */
  storageInfoToastSeen: boolean;
  /** Layout manager slice — modes, per-doc memory, per-mode overrides, chrome. */
  layout: LayoutState;
  /** Appearance slice — accent + motion (theme is in `themeStore`). */
  appearancePrefs: AppearancePrefs;
  /**
   * Persisted top-left (viewport px) of the floating collaboration indicator.
   * `null` = use the default top-right anchor; the user's first drag pins it.
   * App-level (not per-doc), clamped into the viewport at render time.
   */
  collabIndicatorPos: { x: number; y: number } | null;
}

/**
 * UI preferences actions.
 */
export interface UIPreferencesActions {
  /** Toggle a section's expanded state */
  toggleSection: (sectionId: string) => void;
  /** Set a section's expanded state */
  setSection: (sectionId: string, expanded: boolean) => void;
  /** Set many sections' expanded state at once (e.g. expand/collapse all). */
  setSections: (sectionIds: string[], expanded: boolean) => void;
  /** Set the rotation display unit. */
  setRotationUnit: (unit: 'degrees' | 'radians') => void;
  /** Check if a section is expanded */
  isSectionExpanded: (sectionId: string, defaultExpanded?: boolean) => boolean;
  /** Set property panel width */
  setPropertyPanelWidth: (width: number) => void;
  /** Set the Relaxed split secondary-canvas width (px). */
  setRelaxedSplitCanvasWidth: (width: number | null) => void;
  /** Pin the floating collaboration indicator's top-left (viewport px). */
  setCollabIndicatorPos: (pos: { x: number; y: number }) => void;
  /** Set the document browser view (list/grid) */
  setDocumentBrowserView: (view: DocumentBrowserView) => void;
  /** Set the document browser sort key */
  setDocumentBrowserSort: (sort: DocumentBrowserSort) => void;
  /** Set the document browser grouping mode */
  setDocumentBrowserGroupBy: (groupBy: DocumentBrowserGroupBy) => void;
  /** Toggle a collection's collapsed state in the document browser */
  toggleDocumentBrowserGroupCollapsed: (collectionId: string) => void;
  /** Record that the one-time storage-info toast has been shown. */
  markStorageInfoToastSeen: () => void;

  // ── Layout actions (low-level; the `useLayout` hook composes ergonomic
  // "infer current mode" wrappers on top of these for normal call sites.)

  /** Set the single app-level active layout. */
  setDefaultLayout: (mode: LayoutMode) => void;
  /** Override a panel's dock side within a specific layout. */
  setPanelDockFor: (mode: LayoutMode, panel: PanelId, dock: DockSide) => void;
  /** Override a panel's visibility within a specific layout. */
  setPanelVisibleFor: (mode: LayoutMode, panel: PanelId, visible: boolean) => void;
  /** Override a panel's width within a specific layout. */
  setPanelWidthFor: (mode: LayoutMode, panel: PanelId, width: number) => void;
  /** Toggle a panel's pinned state within a specific layout. */
  togglePinFor: (mode: LayoutMode, panel: PanelId) => void;
  /** Set the custom-chrome opt-in flag. */
  setCustomChrome: (enabled: boolean) => void;
  /** Drop all per-layout customization, preserving defaultMode + customChrome. */
  resetLayoutCustomization: () => void;

  // ── Appearance actions
  /** Set (or clear, with `undefined`) one color slot of a base's custom theme. */
  setThemeInput: (base: ThemeBase, slot: ThemeColorSlot, value: string | undefined) => void;
  /** Replace one base's inputs wholesale (presets, "Surprise me", import). */
  setThemeInputs: (base: ThemeBase, inputs: ThemeInputs) => void;
  /** Clear all custom-theme inputs (both bases → base defaults). */
  resetThemeBuild: () => void;
  /** Set the interface motion preference. */
  setMotion: (motion: MotionPreference) => void;
  /** Set the spacing density. */
  setDensity: (density: Density) => void;
  /** Set the interface size multiplier (clamped to [0.9, 1.25]). */
  setUiScale: (uiScale: number) => void;
  /** Set the prose editor background preset. */
  setProseBackground: (proseBackground: ProseBackground) => void;

  /** Reset to initial state */
  reset: () => void;
}

/**
 * Default expanded state for sections.
 */
const DEFAULT_EXPANDED: Record<string, boolean> = {
  appearance: true,
  label: true,
  position: false,
  size: false,
  endpoints: false,
  group: true,
};

/**
 * Empty per-mode override map — each layout starts with no user deltas; the
 * preset table in `modes.ts` provides the defaults.
 */
const EMPTY_MODE_OVERRIDES: LayoutState['modeOverrides'] = {
  relaxed: {},
  designer: {},
  technician: {},
  power: {},
};

/** Initial layout state — Relaxed default, no overrides, native chrome. */
const initialLayoutState: LayoutState = {
  defaultMode: 'relaxed',
  modeOverrides: EMPTY_MODE_OVERRIDES,
  customChrome: false,
};

/**
 * Hex values of the legacy accent enum (JP-255), per base — used by the v5→v6
 * migration to carry a user's accent choice forward as a custom Primary. Mirrors
 * the old `[data-accent]` rules removed from index.css. `default` → no override.
 */
const LEGACY_ACCENT_HEX: Record<string, { light: string; dark: string }> = {
  teal: { light: '#0f766e', dark: '#5eead4' },
  violet: { light: '#6d28d9', dark: '#c4b5fd' },
  amber: { light: '#b45309', dark: '#fcd34d' },
  rose: { light: '#be123c', dark: '#fda4af' },
};

/**
 * Initial appearance prefs — base theme (no color overrides), follow-system
 * motion, scale 1. Density seeds from the input type on first run (touch gets
 * roomier hit targets); a persisted choice always wins via the persist merge.
 */
const initialAppearancePrefs: AppearancePrefs = {
  themeInputs: { light: {}, dark: {} },
  motion: 'system',
  density: device.isTouch() ? 'spacious' : 'normal',
  uiScale: 1,
  proseBackground: 'default',
};

/** Clamp a UI-scale value into the supported range. */
function clampUiScale(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, value));
}

/**
 * Initial state.
 */
const initialState: UIPreferencesState = {
  expandedSections: { ...DEFAULT_EXPANDED },
  rotationUnit: 'degrees',
  propertyPanelWidth: 240,
  relaxedSplitCanvasWidth: null,
  documentBrowserView: 'list',
  documentBrowserSort: 'modified-desc',
  documentBrowserGroupBy: 'none',
  documentBrowserCollapsed: {},
  storageInfoToastSeen: false,
  layout: initialLayoutState,
  appearancePrefs: { ...initialAppearancePrefs },
  collabIndicatorPos: null,
};

/**
 * Merge a single panel override into a layout's existing overrides without
 * dropping fields the caller didn't touch.
 */
function mergePanelOverride(
  current: LayoutState['modeOverrides'],
  mode: LayoutMode,
  panel: PanelId,
  patch: Partial<PanelState>
): LayoutState['modeOverrides'] {
  const modeMap = current[mode];
  const existing = modeMap[panel];
  const merged: PanelState = {
    dock: patch.dock ?? existing?.dock ?? 'right',
    visible: patch.visible ?? existing?.visible ?? true,
    order: patch.order ?? existing?.order ?? 0,
    ...(patch.width !== undefined ? { width: patch.width } : existing?.width !== undefined ? { width: existing.width } : {}),
    ...(patch.pinned !== undefined ? { pinned: patch.pinned } : existing?.pinned !== undefined ? { pinned: existing.pinned } : {}),
  };
  return {
    ...current,
    [mode]: { ...modeMap, [panel]: merged },
  };
}

/**
 * Read the legacy split-pane width key into a layout override on first migration
 * so users don't lose their preferred document panel width. The width-only
 * patch preserves the preset's dock and visibility for every layout.
 */
function adoptLegacySplitPaneWidth(layout: LayoutState): LayoutState {
  try {
    const saved = localStorage.getItem('docushark-split-pane-width');
    if (!saved) return layout;
    const width = parseInt(saved, 10);
    if (!Number.isFinite(width) || width < 200 || width > 600) return layout;
    let next = layout.modeOverrides;
    for (const mode of LAYOUT_MODES) {
      next = mergePanelOverride(next, mode, 'document', { width });
    }
    return { ...layout, modeOverrides: next };
  } catch {
    return layout;
  }
}

/**
 * UI preferences store.
 *
 * Persists UI preferences like expanded sections to localStorage.
 *
 * Usage:
 * ```typescript
 * const { isSectionExpanded, toggleSection } = useUIPreferencesStore();
 *
 * // Check if section is expanded
 * const isExpanded = isSectionExpanded('appearance', true);
 *
 * // Toggle section
 * toggleSection('appearance');
 * ```
 */
export const useUIPreferencesStore = create<UIPreferencesState & UIPreferencesActions>()(
  persist(
    (set, get) => ({
      // State
      ...initialState,

      // Actions
      toggleSection: (sectionId: string) => {
        const { expandedSections } = get();
        const currentState = expandedSections[sectionId] ?? DEFAULT_EXPANDED[sectionId] ?? true;
        set({
          expandedSections: {
            ...expandedSections,
            [sectionId]: !currentState,
          },
        });
      },

      setSection: (sectionId: string, expanded: boolean) => {
        const { expandedSections } = get();
        set({
          expandedSections: {
            ...expandedSections,
            [sectionId]: expanded,
          },
        });
      },

      setSections: (sectionIds: string[], expanded: boolean) => {
        if (sectionIds.length === 0) return;
        const { expandedSections } = get();
        const next = { ...expandedSections };
        for (const id of sectionIds) next[id] = expanded;
        set({ expandedSections: next });
      },

      setRotationUnit: (unit) => set({ rotationUnit: unit }),

      isSectionExpanded: (sectionId: string, defaultExpanded?: boolean): boolean => {
        const { expandedSections } = get();
        if (sectionId in expandedSections) {
          return expandedSections[sectionId] ?? true;
        }
        if (defaultExpanded !== undefined) {
          return defaultExpanded;
        }
        return DEFAULT_EXPANDED[sectionId] ?? true;
      },

      setPropertyPanelWidth: (width: number) => {
        set({ propertyPanelWidth: width });
      },

      setRelaxedSplitCanvasWidth: (width: number | null) => {
        set({ relaxedSplitCanvasWidth: width });
      },

      setCollabIndicatorPos: (pos: { x: number; y: number }) => {
        set({ collabIndicatorPos: { x: pos.x, y: pos.y } });
      },

      setDocumentBrowserView: (view) => set({ documentBrowserView: view }),
      setDocumentBrowserSort: (sort) => set({ documentBrowserSort: sort }),
      setDocumentBrowserGroupBy: (groupBy) => set({ documentBrowserGroupBy: groupBy }),
      toggleDocumentBrowserGroupCollapsed: (collectionId) => {
        const { documentBrowserCollapsed } = get();
        set({
          documentBrowserCollapsed: {
            ...documentBrowserCollapsed,
            [collectionId]: !documentBrowserCollapsed[collectionId],
          },
        });
      },

      markStorageInfoToastSeen: () => set({ storageInfoToastSeen: true }),

      setDefaultLayout: (mode) => {
        set({ layout: { ...get().layout, defaultMode: mode } });
      },

      setPanelDockFor: (mode, panel, dock) => {
        const { layout } = get();
        set({
          layout: {
            ...layout,
            modeOverrides: mergePanelOverride(layout.modeOverrides, mode, panel, { dock }),
          },
        });
      },

      setPanelVisibleFor: (mode, panel, visible) => {
        const { layout } = get();
        set({
          layout: {
            ...layout,
            modeOverrides: mergePanelOverride(layout.modeOverrides, mode, panel, { visible }),
          },
        });
      },

      setPanelWidthFor: (mode, panel, width) => {
        const { layout } = get();
        set({
          layout: {
            ...layout,
            modeOverrides: mergePanelOverride(layout.modeOverrides, mode, panel, { width }),
          },
        });
      },

      togglePinFor: (mode, panel) => {
        const { layout } = get();
        const current = layout.modeOverrides[mode][panel]?.pinned ?? false;
        set({
          layout: {
            ...layout,
            modeOverrides: mergePanelOverride(
              layout.modeOverrides,
              mode,
              panel,
              { pinned: !current }
            ),
          },
        });
      },

      setCustomChrome: (enabled) => {
        set({ layout: { ...get().layout, customChrome: enabled } });
      },

      resetLayoutCustomization: () => {
        const { layout } = get();
        set({
          layout: {
            ...layout,
            modeOverrides: EMPTY_MODE_OVERRIDES,
          },
        });
      },

      setThemeInput: (base, slot, value) => {
        const { appearancePrefs } = get();
        const baseInputs = { ...appearancePrefs.themeInputs[base] };
        if (value === undefined) {
          delete baseInputs[slot];
        } else {
          baseInputs[slot] = value;
        }
        set({
          appearancePrefs: {
            ...appearancePrefs,
            themeInputs: { ...appearancePrefs.themeInputs, [base]: baseInputs },
          },
        });
      },

      setThemeInputs: (base, inputs) => {
        const { appearancePrefs } = get();
        set({
          appearancePrefs: {
            ...appearancePrefs,
            themeInputs: { ...appearancePrefs.themeInputs, [base]: { ...inputs } },
          },
        });
      },

      resetThemeBuild: () => {
        set({
          appearancePrefs: { ...get().appearancePrefs, themeInputs: { light: {}, dark: {} } },
        });
      },

      setMotion: (motion) => {
        set({ appearancePrefs: { ...get().appearancePrefs, motion } });
      },

      setDensity: (density) => {
        set({ appearancePrefs: { ...get().appearancePrefs, density } });
      },

      setUiScale: (uiScale) => {
        set({ appearancePrefs: { ...get().appearancePrefs, uiScale: clampUiScale(uiScale) } });
      },

      setProseBackground: (proseBackground) => {
        set({ appearancePrefs: { ...get().appearancePrefs, proseBackground } });
      },

      reset: () => {
        set(initialState);
      },
    }),
    {
      name: 'docushark-ui-preferences',
      version: 9,
      partialize: (state) => ({
        expandedSections: state.expandedSections,
        rotationUnit: state.rotationUnit,
        propertyPanelWidth: state.propertyPanelWidth,
        relaxedSplitCanvasWidth: state.relaxedSplitCanvasWidth,
        documentBrowserView: state.documentBrowserView,
        documentBrowserSort: state.documentBrowserSort,
        documentBrowserGroupBy: state.documentBrowserGroupBy,
        documentBrowserCollapsed: state.documentBrowserCollapsed,
        storageInfoToastSeen: state.storageInfoToastSeen,
        layout: state.layout,
        appearancePrefs: state.appearancePrefs,
        collabIndicatorPos: state.collabIndicatorPos,
      }),
      migrate: (persisted, fromVersion) => {
        // Cast away the loose persisted-state typing — older payloads carry
        // shapes that no longer fit the current type. We re-narrow as we go.
        const next = (persisted ?? {}) as Record<string, unknown>;
        let layout = next['layout'] as LayoutState | undefined;
        // v0 → v1: layout slice didn't exist; adopt initial layout state and
        // pull the legacy split-pane width into the document panel override
        // so user width survives.
        if (fromVersion < 1 || !layout) {
          layout = adoptLegacySplitPaneWidth(initialLayoutState);
        }
        // v1 → v2: PanelState gained explicit `visible`; `dock: 'hidden'`
        // collapses into `visible: false` while preserving the user's side.
        if (fromVersion < 2 && layout.modeOverrides) {
          const upgraded: LayoutState['modeOverrides'] = {
            relaxed: {},
            designer: {},
            technician: {},
            power: {},
          };
          const oldOverrides = layout.modeOverrides as unknown as Record<
            LayoutMode,
            Record<string, Record<string, unknown>>
          >;
          for (const mode of LAYOUT_MODES) {
            const modeMap = oldOverrides[mode] ?? {};
            const upgradedMap: Partial<Record<PanelId, PanelState>> = {};
            for (const [panel, raw] of Object.entries(modeMap)) {
              const r = raw as { dock?: string; visible?: boolean; order?: number; width?: number; pinned?: boolean };
              const wasHidden = r.dock === 'hidden';
              const presetDock = LAYOUT_PRESETS[mode][panel as PanelId]?.dock ?? 'right';
              const side: DockSide =
                wasHidden
                  ? presetDock
                  : r.dock === 'left' || r.dock === 'right'
                    ? r.dock
                    : presetDock;
              upgradedMap[panel as PanelId] = {
                dock: side,
                visible: wasHidden ? false : (r.visible ?? true),
                order: r.order ?? 0,
                ...(r.width !== undefined ? { width: r.width } : {}),
                ...(r.pinned !== undefined ? { pinned: r.pinned } : {}),
              };
            }
            upgraded[mode] = upgradedMap;
          }
          layout = { ...layout, modeOverrides: upgraded };
        }
        // v2 → v3: layout became app-level; drop the per-document `perDoc` map.
        // The active mode falls back to `defaultMode`, which is preserved.
        if (fromVersion < 3 && layout && 'perDoc' in (layout as unknown as Record<string, unknown>)) {
          const { perDoc: _dropped, ...rest } = layout as LayoutState & {
            perDoc?: unknown;
          };
          void _dropped;
          layout = rest as LayoutState;
        }
        next['layout'] = layout;
        // v3 → v4: added the appearance slice (accent + motion). Default it so
        // existing behavior is preserved (theme's own accent, follow-system
        // motion); the `merge` below also backstops this.
        if (fromVersion < 4) {
          next['appearancePrefs'] = next['appearancePrefs'] ?? { ...initialAppearancePrefs };
        }
        // v4 → v5: the appearance slice gained density + uiScale. Fill any
        // missing fields from the defaults without clobbering accent/motion.
        if (fromVersion < 5) {
          next['appearancePrefs'] = {
            ...initialAppearancePrefs,
            ...((next['appearancePrefs'] as Partial<AppearancePrefs> | undefined) ?? {}),
          };
        }
        // v5 → v6: accent enum → custom-theme Primary (both bases). The old
        // `[data-accent]` rules are gone; a user's accent choice is preserved as
        // a Primary override so their look survives. `default` → no override.
        if (fromVersion < 6) {
          const ap = (next['appearancePrefs'] as Record<string, unknown> | undefined) ?? {};
          const accent = typeof ap['accent'] === 'string' ? (ap['accent'] as string) : 'default';
          const hex = LEGACY_ACCENT_HEX[accent];
          const themeInputs: ThemeBuild = hex
            ? { light: { primary: hex.light }, dark: { primary: hex.dark } }
            : { light: {}, dark: {} };
          delete ap['accent'];
          next['appearancePrefs'] = { ...ap, themeInputs };
        }
        // v6 → v7: document "groups" became "collections". The browser grouping
        // axis value `'group'` → `'collection'`; the retired `'relay'` axis
        // degrades to `'none'`. (Per-document membership itself lives in the
        // separate `collectionStore`; this only migrates the browser's group-by
        // preference so an old value doesn't render as an unknown axis.)
        if (fromVersion < 7) {
          const axis = next['documentBrowserGroupBy'];
          next['documentBrowserGroupBy'] = axis === 'group' ? 'collection' : axis === 'collection' ? 'collection' : 'none';
        }
        // v7 → v8: added the floating collaboration-indicator position. Default
        // to `null` (the top-right anchor) so existing users see no change until
        // they first drag it. (The `merge` below also backstops this.)
        if (fromVersion < 8) {
          next['collabIndicatorPos'] = next['collabIndicatorPos'] ?? null;
        }
        // v8 → v9: the Relaxed split-canvas width became responsive-by-default
        // (`null` = use the ~50/50 CSS clamp). The old hard default was 480px,
        // which rendered as a cramped ~33% pane on wide screens. Reset that
        // exact legacy default to `null` so existing users get the responsive
        // split; any other value is a deliberate drag and is preserved.
        if (fromVersion < 9) {
          if (next['relaxedSplitCanvasWidth'] === 480) {
            next['relaxedSplitCanvasWidth'] = null;
          }
        }
        return next as unknown as UIPreferencesState;
      },
      merge: (persisted, current) => {
        // Hand-rolled merge so partial persisted state (e.g. missing layout
        // sub-fields after a future migration) doesn't crash hydration.
        const p = (persisted ?? {}) as Partial<UIPreferencesState>;
        const layout: LayoutState = {
          ...initialLayoutState,
          ...(p.layout ?? {}),
          modeOverrides: {
            ...EMPTY_MODE_OVERRIDES,
            ...(p.layout?.modeOverrides ?? {}),
          },
        };
        const persistedAp = (p.appearancePrefs ?? {}) as Partial<AppearancePrefs>;
        const appearancePrefs: AppearancePrefs = {
          ...initialAppearancePrefs,
          ...persistedAp,
          // Always materialize both bases so the applier can index safely.
          themeInputs: {
            light: { ...(persistedAp.themeInputs?.light ?? {}) },
            dark: { ...(persistedAp.themeInputs?.dark ?? {}) },
          },
        };
        return { ...current, ...p, layout, appearancePrefs };
      },
    }
  )
);
