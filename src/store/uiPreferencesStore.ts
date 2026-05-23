/**
 * UI Preferences store for persisting UI state across sessions.
 *
 * Stores user preferences like expanded/collapsed sections, panel widths, etc.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

export type DocumentBrowserView = 'list' | 'grid';
export type DocumentBrowserSort =
  | 'modified-desc'
  | 'modified-asc'
  | 'name-asc'
  | 'name-desc'
  | 'created-desc';
export type DocumentBrowserGroupBy = 'none' | 'group';

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
 * Initial state.
 */
const initialState: UIPreferencesState = {
  expandedSections: { ...DEFAULT_EXPANDED },
  propertyPanelWidth: 240,
  documentBrowserView: 'list',
  documentBrowserSort: 'modified-desc',
  documentBrowserGroupBy: 'none',
  documentBrowserCollapsed: {},
};

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

      reset: () => {
        set(initialState);
      },
    }),
    {
      name: 'docushark-ui-preferences',
      partialize: (state) => ({
        expandedSections: state.expandedSections,
        propertyPanelWidth: state.propertyPanelWidth,
        documentBrowserView: state.documentBrowserView,
        documentBrowserSort: state.documentBrowserSort,
        documentBrowserGroupBy: state.documentBrowserGroupBy,
        documentBrowserCollapsed: state.documentBrowserCollapsed,
      }),
    }
  )
);
