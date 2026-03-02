import { create } from 'zustand';
import { useDocumentStore, DocumentSnapshot } from './documentStore';

/**
 * Maximum number of history entries to keep per page.
 */
const MAX_HISTORY_SIZE = 100;

/**
 * Minimum time between pushes in milliseconds for debouncing.
 */
const DEBOUNCE_TIME = 300;

/**
 * A snapshot of the document state at a point in time.
 */
export interface HistoryEntry {
  /** Document state snapshot */
  snapshot: DocumentSnapshot;
  /** Timestamp when the entry was created */
  timestamp: number;
  /** Optional description of the action */
  description?: string | undefined;
}

/**
 * Per-page history data.
 */
export interface PageHistory {
  /** Past states (undo stack) */
  past: HistoryEntry[];
  /** Future states (redo stack) */
  future: HistoryEntry[];
  /** Last push timestamp for debouncing */
  lastPushTime: number;
}

/**
 * History state for undo/redo functionality.
 * History is tracked per-page to maintain separate undo stacks.
 */
export interface HistoryState {
  /** History data per page, keyed by page ID */
  pageHistory: Record<string, PageHistory>;
  /** Currently active page ID for history operations */
  activePageId: string | null;
  /** Whether history tracking is enabled */
  isTracking: boolean;
}

/**
 * History actions for undo/redo.
 */
export interface HistoryActions {
  /**
   * Push the current document state onto the history stack for the active page.
   * @param description Optional description of the change
   */
  push: (description?: string) => void;

  /**
   * Undo the last change on the active page.
   */
  undo: () => void;

  /**
   * Redo the last undone change on the active page.
   */
  redo: () => void;

  /**
   * Clear all history (all pages).
   */
  clear: () => void;

  /**
   * Clear history for a specific page.
   */
  clearPage: (pageId: string) => void;

  /**
   * Set the active page for history operations.
   */
  setActivePage: (pageId: string | null) => void;

  /**
   * Enable or disable history tracking.
   */
  setTracking: (enabled: boolean) => void;

  /**
   * Check if undo is available for the active page.
   */
  canUndo: () => boolean;

  /**
   * Check if redo is available for the active page.
   */
  canRedo: () => boolean;

  /**
   * Get the number of undo steps available for the active page.
   */
  getUndoCount: () => number;

  /**
   * Get the number of redo steps available for the active page.
   */
  getRedoCount: () => number;

  /**
   * Get the description of the action that would be undone.
   */
  getUndoDescription: () => string | undefined;

  /**
   * Get the description of the action that would be redone.
   */
  getRedoDescription: () => string | undefined;
}

/**
 * Initial history state.
 */
const initialState: HistoryState = {
  pageHistory: {},
  activePageId: null,
  isTracking: true,
};

/**
 * Create empty page history.
 */
function createEmptyPageHistory(): PageHistory {
  return {
    past: [],
    future: [],
    lastPushTime: 0,
  };
}

/**
 * Create a snapshot of the current document state.
 */
function createSnapshot(): DocumentSnapshot {
  return useDocumentStore.getState().getSnapshot();
}

/**
 * Restore a snapshot to the document store.
 */
function restoreSnapshot(snapshot: DocumentSnapshot): void {
  useDocumentStore.getState().loadSnapshot(snapshot);
}

/**
 * History store for undo/redo functionality.
 *
 * The history system stores complete document snapshots per page.
 * Each page has its own undo/redo stack for independent history.
 *
 * Usage:
 * ```typescript
 * const { undo, redo, canUndo, canRedo, setActivePage } = useHistoryStore();
 *
 * // Set active page when switching
 * setActivePage(pageId);
 *
 * // Push state before making changes
 * push('Move shapes');
 *
 * // Undo/Redo
 * if (canUndo()) undo();
 * if (canRedo()) redo();
 * ```
 */
export const useHistoryStore = create<HistoryState & HistoryActions>()((set, get) => ({
  // State
  ...initialState,

  // Actions
  push: (description?: string) => {
    const state = get();
    const { activePageId, isTracking } = state;

    if (!isTracking || !activePageId) return;

    // Get or create page history
    const pageHist = state.pageHistory[activePageId] ?? createEmptyPageHistory();

    // Debounce rapid pushes
    const now = Date.now();
    if (now - pageHist.lastPushTime < DEBOUNCE_TIME) {
      return;
    }

    const snapshot = createSnapshot();
    const entry: HistoryEntry = {
      snapshot,
      timestamp: now,
      description,
    };

    set((state) => {
      const currentPageHist = state.pageHistory[activePageId] ?? createEmptyPageHistory();

      // Add to past, clear future (new branch)
      const newPast = [...currentPageHist.past, entry];

      // Trim if exceeds max size
      if (newPast.length > MAX_HISTORY_SIZE) {
        newPast.shift();
      }

      return {
        pageHistory: {
          ...state.pageHistory,
          [activePageId]: {
            past: newPast,
            future: [],
            lastPushTime: now,
          },
        },
      };
    });
  },

  undo: () => {
    const state = get();
    const { activePageId } = state;

    if (!activePageId) return;

    const pageHist = state.pageHistory[activePageId];
    if (!pageHist || pageHist.past.length === 0) return;

    // Get the last entry from past
    const lastEntry = pageHist.past[pageHist.past.length - 1];
    if (!lastEntry) return;

    // Save current state to future before restoring
    const currentSnapshot = createSnapshot();
    const currentEntry: HistoryEntry = {
      snapshot: currentSnapshot,
      timestamp: Date.now(),
      description: lastEntry.description,
    };

    // Temporarily disable tracking while restoring
    set({ isTracking: false });

    // Restore the snapshot
    restoreSnapshot(lastEntry.snapshot);

    // Update history stacks
    set((state) => {
      const currentPageHist = state.pageHistory[activePageId] ?? createEmptyPageHistory();

      return {
        pageHistory: {
          ...state.pageHistory,
          [activePageId]: {
            past: currentPageHist.past.slice(0, -1),
            future: [currentEntry, ...currentPageHist.future],
            lastPushTime: currentPageHist.lastPushTime,
          },
        },
        isTracking: true,
      };
    });
  },

  redo: () => {
    const state = get();
    const { activePageId } = state;

    if (!activePageId) return;

    const pageHist = state.pageHistory[activePageId];
    if (!pageHist || pageHist.future.length === 0) return;

    // Get the first entry from future
    const nextEntry = pageHist.future[0];
    if (!nextEntry) return;

    // Save current state to past before restoring
    const currentSnapshot = createSnapshot();
    const currentEntry: HistoryEntry = {
      snapshot: currentSnapshot,
      timestamp: Date.now(),
      description: nextEntry.description,
    };

    // Temporarily disable tracking while restoring
    set({ isTracking: false });

    // Restore the snapshot
    restoreSnapshot(nextEntry.snapshot);

    // Update history stacks
    set((state) => {
      const currentPageHist = state.pageHistory[activePageId] ?? createEmptyPageHistory();

      return {
        pageHistory: {
          ...state.pageHistory,
          [activePageId]: {
            past: [...currentPageHist.past, currentEntry],
            future: currentPageHist.future.slice(1),
            lastPushTime: currentPageHist.lastPushTime,
          },
        },
        isTracking: true,
      };
    });
  },

  clear: () => {
    set({
      pageHistory: {},
    });
  },

  clearPage: (pageId: string) => {
    set((state) => {
      const newPageHistory = { ...state.pageHistory };
      delete newPageHistory[pageId];
      return { pageHistory: newPageHistory };
    });
  },

  setActivePage: (pageId: string | null) => {
    set({ activePageId: pageId });
  },

  setTracking: (enabled: boolean) => {
    set({ isTracking: enabled });
  },

  canUndo: () => {
    const state = get();
    if (!state.activePageId) return false;
    const pageHist = state.pageHistory[state.activePageId];
    return pageHist ? pageHist.past.length > 0 : false;
  },

  canRedo: () => {
    const state = get();
    if (!state.activePageId) return false;
    const pageHist = state.pageHistory[state.activePageId];
    return pageHist ? pageHist.future.length > 0 : false;
  },

  getUndoCount: () => {
    const state = get();
    if (!state.activePageId) return 0;
    const pageHist = state.pageHistory[state.activePageId];
    return pageHist ? pageHist.past.length : 0;
  },

  getRedoCount: () => {
    const state = get();
    if (!state.activePageId) return 0;
    const pageHist = state.pageHistory[state.activePageId];
    return pageHist ? pageHist.future.length : 0;
  },

  getUndoDescription: () => {
    const state = get();
    if (!state.activePageId) return undefined;
    const pageHist = state.pageHistory[state.activePageId];
    if (!pageHist || pageHist.past.length === 0) return undefined;
    return pageHist.past[pageHist.past.length - 1]?.description;
  },

  getRedoDescription: () => {
    const state = get();
    if (!state.activePageId) return undefined;
    const pageHist = state.pageHistory[state.activePageId];
    if (!pageHist || pageHist.future.length === 0) return undefined;
    return pageHist.future[0]?.description;
  },
}));

/**
 * Push a history entry with automatic debouncing.
 * Convenience function for use in mutations.
 */
export function pushHistory(description?: string): void {
  useHistoryStore.getState().push(description);
}

/**
 * Perform an action with history tracking.
 * Pushes history before the action and optionally after if successful.
 */
export function withHistory<T>(action: () => T, description?: string): T {
  pushHistory(description);
  return action();
}
