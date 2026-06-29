import { create } from 'zustand';
import { useDocumentStore, DocumentSnapshot } from './documentStore';
import { useNotificationStore } from './notificationStore';
import { useCollaborationStore } from '../collaboration/collaborationStore';

/**
 * Snapshot-based undo/redo is disabled while a collaboration session is active
 * (JP-178). The relay Y.Doc is the authoritative source whenever a collab
 * *engine* session is live — including offline-first relay docs (engine ≠
 * provider) — so restoring a local history *snapshot* would diverge from the
 * Y.Doc and be silently clobbered on the next sync/reload.
 *
 * Instead of no-op'ing in collab, this store now **delegates** to the per-user
 * Yjs `UndoManager` owned by the YjsDocument (JP-402): a CRDT-native undo that
 * reverts only this user's edits and broadcasts as a normal op (no snapshot, no
 * divergence). The snapshot path below still owns pure local documents (no
 * session). Read at call time so there is no module eval-order dependency on the
 * collaboration store.
 */
function isCollabSessionActive(): boolean {
  return useCollaborationStore.getState().isActive;
}

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
  /**
   * The page this snapshot belongs to.
   *
   * Cross-page corruption guard: snapshots must only ever be restored onto
   * the page they originated from. Mismatch indicates a bug elsewhere
   * (ordering window in setActivePage, store drift, etc.) — undo/redo
   * refuses to apply rather than silently swap one page's content for another.
   */
  pageId: string;
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
 * Module-local mirror of pageStore.activePageId, kept in sync via
 * `registerPageStoreActiveId` (called from pageStore on every page switch).
 *
 * Avoids a circular static import (pageStore imports historyStore) while still
 * letting historyStore detect drift between its own activePageId and the
 * pageStore's. `null` means "not yet registered" — treat as unknown and skip
 * the check (e.g. during early bootstrap or in tests that drive historyStore
 * directly).
 */
let pageStoreActiveIdMirror: { value: string | null } | null = null;

/**
 * Called by pageStore whenever its activePageId changes. Lets historyStore
 * cross-check both stores agree before pushing or restoring.
 */
export function registerPageStoreActiveId(id: string | null): void {
  pageStoreActiveIdMirror = { value: id };
}

/**
 * Verify that historyStore.activePageId agrees with pageStore.activePageId.
 * A drift between the two means a snapshot push or restore is about to land
 * in the wrong page bucket — refuse the operation and surface the problem
 * loudly so we never silently swap one page's content for another.
 */
function assertActivePageConsistency(
  op: 'push' | 'undo' | 'redo',
  historyActiveId: string | null,
): boolean {
  if (pageStoreActiveIdMirror === null) return true; // not yet registered
  const pageActiveId = pageStoreActiveIdMirror.value;
  if (pageActiveId === historyActiveId) return true;
  // eslint-disable-next-line no-console
  console.error(
    `[historyStore] ${op} aborted: activePageId mismatch between stores. ` +
      `historyStore=${historyActiveId} pageStore=${pageActiveId}. ` +
      `This would corrupt page content — refusing.`,
  );
  useNotificationStore.getState().error(
    `${op === 'push' ? 'Edit' : op === 'undo' ? 'Undo' : 'Redo'} blocked: page tracking is out of sync. ` +
      `No data was changed. Please report this.`,
    { category: 'permanent' },
  );
  return false;
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
    // In a collab session the snapshot path is inactive (JP-178). `pushHistory`
    // is the single action-anchor funnel (Engine.ts → here), so close the current
    // CRDT undo step (JP-402) — each marked action becomes its own undo step.
    if (isCollabSessionActive()) {
      useCollaborationStore.getState().getYjsDocument()?.closeUndoStep();
      return;
    }
    const state = get();
    const { activePageId, isTracking } = state;

    if (!isTracking || !activePageId) return;

    // Cross-store consistency: refuse to push if historyStore and pageStore
    // disagree on which page is active — snapshot would land in the wrong bucket.
    if (!assertActivePageConsistency('push', activePageId)) return;

    // Get or create page history
    const pageHist = state.pageHistory[activePageId] ?? createEmptyPageHistory();

    // Debounce rapid pushes
    const now = Date.now();
    if (now - pageHist.lastPushTime < DEBOUNCE_TIME) {
      return;
    }

    const snapshot = createSnapshot();
    const entry: HistoryEntry = {
      pageId: activePageId,
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
    // Collab: delegate to the per-user CRDT UndoManager (JP-402) instead of the
    // snapshot path (which would diverge from the relay Y.Doc, JP-178).
    if (isCollabSessionActive()) {
      useCollaborationStore.getState().undoCanvas();
      return;
    }
    const state = get();
    const { activePageId } = state;

    if (!activePageId) return;
    if (!assertActivePageConsistency('undo', activePageId)) return;

    const pageHist = state.pageHistory[activePageId];
    if (!pageHist || pageHist.past.length === 0) return;

    // Get the last entry from past
    const lastEntry = pageHist.past[pageHist.past.length - 1];
    if (!lastEntry) return;

    // Page-identity guard: a snapshot must only ever be restored onto the
    // page it came from. If the bucket holds an entry tagged with a different
    // pageId, the entry is poison — applying it would replace the active
    // page's content with another page's content. Drop the entry (so it
    // doesn't keep firing on every undo press) and notify the user, rather
    // than silently applying corrupted data.
    if (lastEntry.pageId !== activePageId) {
      // eslint-disable-next-line no-console
      console.error(
        `[historyStore] undo: dropped poisoned history entry pageId=${lastEntry.pageId} ` +
          `from bucket=${activePageId}. Would have corrupted page content.`,
      );
      useNotificationStore.getState().warning(
        'Skipped a stale undo entry that belonged to a different page.',
        { category: 'transient' },
      );
      set((state) => {
        const cur = state.pageHistory[activePageId] ?? createEmptyPageHistory();
        return {
          pageHistory: {
            ...state.pageHistory,
            [activePageId]: {
              past: cur.past.slice(0, -1),
              future: cur.future,
              lastPushTime: cur.lastPushTime,
            },
          },
        };
      });
      return;
    }

    // Save current state to future before restoring
    const currentSnapshot = createSnapshot();
    const currentEntry: HistoryEntry = {
      pageId: activePageId,
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
    // Collab: delegate to the per-user CRDT UndoManager (JP-402).
    if (isCollabSessionActive()) {
      useCollaborationStore.getState().redoCanvas();
      return;
    }
    const state = get();
    const { activePageId } = state;

    if (!activePageId) return;
    if (!assertActivePageConsistency('redo', activePageId)) return;

    const pageHist = state.pageHistory[activePageId];
    if (!pageHist || pageHist.future.length === 0) return;

    // Get the first entry from future
    const nextEntry = pageHist.future[0];
    if (!nextEntry) return;

    // Same drop-and-notify policy as undo: if a future entry belongs to a
    // different page, drop it rather than silently apply corrupted data.
    // For redo specifically we prefer dropping over any chance of resurrecting
    // another page's content into this one.
    if (nextEntry.pageId !== activePageId) {
      // eslint-disable-next-line no-console
      console.error(
        `[historyStore] redo: dropped poisoned future entry pageId=${nextEntry.pageId} ` +
          `from bucket=${activePageId}. Would have corrupted page content.`,
      );
      useNotificationStore.getState().warning(
        'Skipped a stale redo entry that belonged to a different page.',
        { category: 'transient' },
      );
      set((state) => {
        const cur = state.pageHistory[activePageId] ?? createEmptyPageHistory();
        return {
          pageHistory: {
            ...state.pageHistory,
            [activePageId]: {
              past: cur.past,
              future: cur.future.slice(1),
              lastPushTime: cur.lastPushTime,
            },
          },
        };
      });
      return;
    }

    // Save current state to past before restoring
    const currentSnapshot = createSnapshot();
    const currentEntry: HistoryEntry = {
      pageId: activePageId,
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
    // Collab: availability comes from the CRDT UndoManager mirror (JP-402).
    if (isCollabSessionActive()) return useCollaborationStore.getState().canUndoCanvas;
    const state = get();
    if (!state.activePageId) return false;
    const pageHist = state.pageHistory[state.activePageId];
    return pageHist ? pageHist.past.length > 0 : false;
  },

  canRedo: () => {
    // Collab: availability comes from the CRDT UndoManager mirror (JP-402).
    if (isCollabSessionActive()) return useCollaborationStore.getState().canRedoCanvas;
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
