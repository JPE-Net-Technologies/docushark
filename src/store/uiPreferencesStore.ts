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

export type DocumentBrowserView = 'list' | 'grid';
export type DocumentBrowserSort =
  | 'modified-desc'
  | 'modified-asc'
  | 'name-asc'
  | 'name-desc'
  | 'created-desc';
export type DocumentBrowserGroupBy = 'none' | 'group' | 'relay';

/**
 * UI preferences state.
 */
export interface UIPreferencesState {
  /** Expanded state of property panel sections */
  expandedSections: Record<string, boolean>;
  /** Property panel width */
  propertyPanelWidth: number;
  /** Document browser layout */
  documentBrowserView: DocumentBrowserView;
  /** Document browser sort key */
  documentBrowserSort: DocumentBrowserSort;
  /** Document browser grouping mode */
  documentBrowserGroupBy: DocumentBrowserGroupBy;
  /** Per-group collapsed state in the browser (groupId -> collapsed). */
  documentBrowserCollapsed: Record<string, boolean>;
  /** Layout manager slice — modes, per-doc memory, per-mode overrides, chrome. */
  layout: LayoutState;
}

/**
 * UI preferences actions.
 */
export interface UIPreferencesActions {
  /** Toggle a section's expanded state */
  toggleSection: (sectionId: string) => void;
  /** Set a section's expanded state */
  setSection: (sectionId: string, expanded: boolean) => void;
  /** Check if a section is expanded */
  isSectionExpanded: (sectionId: string, defaultExpanded?: boolean) => boolean;
  /** Set property panel width */
  setPropertyPanelWidth: (width: number) => void;
  /** Set the document browser view (list/grid) */
  setDocumentBrowserView: (view: DocumentBrowserView) => void;
  /** Set the document browser sort key */
  setDocumentBrowserSort: (sort: DocumentBrowserSort) => void;
  /** Set the document browser grouping mode */
  setDocumentBrowserGroupBy: (groupBy: DocumentBrowserGroupBy) => void;
  /** Toggle a group's collapsed state in the document browser */
  toggleDocumentBrowserGroupCollapsed: (groupId: string) => void;

  // ── Layout actions (low-level; the `useLayout` hook composes ergonomic
  // "infer current mode" wrappers on top of these for normal call sites.)

  /** Set the global default layout for newly created documents. */
  setDefaultLayout: (mode: LayoutMode) => void;
  /** Record the layout choice for a specific document (client-only memory). */
  setLayoutForDoc: (docId: string, mode: LayoutMode) => void;
  /** Forget any per-doc layout choice for the given doc. */
  clearLayoutForDoc: (docId: string) => void;
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
  perDoc: {},
  modeOverrides: EMPTY_MODE_OVERRIDES,
  customChrome: false,
};

/**
 * Initial state.
 */
const initialState: UIPreferencesState = {
  expandedSections: { ...DEFAULT_EXPANDED },
  propertyPanelWidth: 240,
  documentBrowserView: 'list',
  documentBrowserSort: 'modified-desc',
  documentBrowserGroupBy: 'none',
  documentBrowserCollapsed: {},
  layout: initialLayoutState,
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

      setDocumentBrowserView: (view) => set({ documentBrowserView: view }),
      setDocumentBrowserSort: (sort) => set({ documentBrowserSort: sort }),
      setDocumentBrowserGroupBy: (groupBy) => set({ documentBrowserGroupBy: groupBy }),
      toggleDocumentBrowserGroupCollapsed: (groupId) => {
        const { documentBrowserCollapsed } = get();
        set({
          documentBrowserCollapsed: {
            ...documentBrowserCollapsed,
            [groupId]: !documentBrowserCollapsed[groupId],
          },
        });
      },

      setDefaultLayout: (mode) => {
        set({ layout: { ...get().layout, defaultMode: mode } });
      },

      setLayoutForDoc: (docId, mode) => {
        const { layout } = get();
        set({
          layout: {
            ...layout,
            perDoc: { ...layout.perDoc, [docId]: mode },
          },
        });
      },

      clearLayoutForDoc: (docId) => {
        const { layout } = get();
        if (!(docId in layout.perDoc)) return;
        const nextPerDoc = { ...layout.perDoc };
        delete nextPerDoc[docId];
        set({ layout: { ...layout, perDoc: nextPerDoc } });
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
            perDoc: {},
          },
        });
      },

      reset: () => {
        set(initialState);
      },
    }),
    {
      name: 'docushark-ui-preferences',
      version: 2,
      partialize: (state) => ({
        expandedSections: state.expandedSections,
        propertyPanelWidth: state.propertyPanelWidth,
        documentBrowserView: state.documentBrowserView,
        documentBrowserSort: state.documentBrowserSort,
        documentBrowserGroupBy: state.documentBrowserGroupBy,
        documentBrowserCollapsed: state.documentBrowserCollapsed,
        layout: state.layout,
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
        next['layout'] = layout;
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
          perDoc: { ...(p.layout?.perDoc ?? {}) },
        };
        return { ...current, ...p, layout };
      },
    }
  )
);
