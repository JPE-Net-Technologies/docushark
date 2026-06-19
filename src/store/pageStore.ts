/**
 * Page store for managing multiple pages within a document.
 *
 * Coordinates with documentStore to load/save page content when switching pages.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { nanoid } from 'nanoid';
import { Page, createPage } from '../types/Document';
import type { CanvasPageList } from '../collaboration/YjsDocument';
import { useDocumentStore } from './documentStore';
import { useSessionStore } from './sessionStore';
import { useHistoryStore, registerPageStoreActiveId } from './historyStore';

/**
 * JP-340: whether a live collab session owns loading the active page's shapes
 * into `documentStore` (so `setActivePage` must NOT also load `pages[id].shapes`,
 * which would flash a stale/empty snapshot before the YjsDocument rebind). The
 * collab layer registers the real predicate via {@link registerCollabOwnsActivePageLoad};
 * default `false` keeps non-collab (local) page switches loading normally. A
 * registered indirection avoids a pageStore→collaborationStore import cycle.
 */
let collabOwnsActivePageLoad: () => boolean = () => false;
export function registerCollabOwnsActivePageLoad(fn: () => boolean): void {
  collabOwnsActivePageLoad = fn;
}

/**
 * Page state.
 */
export interface PageState {
  /** All pages in the current document, keyed by ID */
  pages: Record<string, Page>;
  /** Order of pages (for tab display) */
  pageOrder: string[];
  /** Currently active page ID */
  activePageId: string | null;
}

/**
 * Page actions.
 */
export interface PageActions {
  // Page CRUD
  createPage: (name?: string) => string;
  deletePage: (id: string) => void;
  renamePage: (id: string, name: string) => void;
  duplicatePage: (id: string) => string | null;

  // Page ordering
  reorderPages: (newOrder: string[]) => void;

  // Navigation
  setActivePage: (id: string) => void;

  // Utilities
  getPage: (id: string) => Page | undefined;
  getActivePage: () => Page | undefined;
  getPageCount: () => number;

  // Synchronization with documentStore
  syncCurrentPageFromDocument: () => void;
  syncDocumentToCurrentPage: () => void;

  // Serialization for persistence
  getSnapshot: () => PageStoreSnapshot;
  loadSnapshot: (snapshot: PageStoreSnapshot) => void;
  /** Adopt a remote canvas page-LIST (JP-339): merge tab metadata (name) from
   *  the CRDT, preserving each page's shapes/shapeOrder, and prune pages absent
   *  from the merged set. */
  applyRemoteCanvasPageList: (list: CanvasPageList) => void;

  // Reset
  reset: () => void;
  initializeDefault: () => void;
}

/**
 * Snapshot of entire page store for persistence.
 */
export interface PageStoreSnapshot {
  pages: Record<string, Page>;
  pageOrder: string[];
  activePageId: string | null;
}

/**
 * Initial empty state.
 */
const initialState: PageState = {
  pages: {},
  pageOrder: [],
  activePageId: null,
};

/**
 * Page store for managing document pages.
 *
 * Usage:
 * ```typescript
 * const { pages, createPage, setActivePage } = usePageStore();
 *
 * // Create a new page
 * const newPageId = createPage('My Page');
 *
 * // Switch to a page
 * setActivePage(pageId);
 * ```
 */
export const usePageStore = create<PageState & PageActions>()(
  immer((set, get) => ({
    // State
    ...initialState,

    // Create a new page
    createPage: (name?: string): string => {
      const pageId = nanoid();
      const pageName = name || `Page ${get().pageOrder.length + 1}`;

      set((state) => {
        const newPage = createPage(pageName, pageId);
        state.pages[pageId] = newPage;
        state.pageOrder.push(pageId);

        // If this is the first page, make it active
        if (state.activePageId === null) {
          state.activePageId = pageId;
        }
      });

      // Keep historyStore in lockstep if we just activated this page. Both the
      // history store's own activePageId AND its pageStore-mirror must move
      // together — updating only the mirror (as before) left history pinned to
      // the previous doc's page on a fresh doc (createPage activates page 1 but
      // history.clear() doesn't realign activePageId), so the consistency guard
      // then refused every edit on the new doc.
      if (get().activePageId === pageId) {
        useHistoryStore.getState().setActivePage(pageId);
        registerPageStoreActiveId(pageId);
      }

      return pageId;
    },

    // Delete a page
    deletePage: (id: string) => {
      const state = get();

      // Can't delete the last page
      if (state.pageOrder.length <= 1) {
        console.warn('Cannot delete the last page');
        return;
      }

      // Can't delete non-existent page
      if (!state.pages[id]) {
        return;
      }

      const wasActive = state.activePageId === id;
      const currentIndex = state.pageOrder.indexOf(id);

      set((draft) => {
        // Remove from pages and order
        delete draft.pages[id];
        draft.pageOrder = draft.pageOrder.filter((pageId) => pageId !== id);

        // If we deleted the active page, switch to adjacent page
        if (wasActive && draft.pageOrder.length > 0) {
          // Prefer the next page, or previous if we deleted the last one
          const newIndex = Math.min(currentIndex, draft.pageOrder.length - 1);
          draft.activePageId = draft.pageOrder[newIndex] ?? draft.pageOrder[0] ?? null;
        }
      });

      // If we switched pages, load the new active page content
      if (wasActive) {
        const newState = get();
        if (newState.activePageId) {
          get().syncDocumentToCurrentPage();
          // Update history active page (clears page history if switching)
          useHistoryStore.getState().setActivePage(newState.activePageId);
          registerPageStoreActiveId(newState.activePageId);
        }
      }

      // Drop history for the deleted page so its entries can never resurface
      // and target the wrong page bucket later.
      useHistoryStore.getState().clearPage(id);
    },

    // Rename a page
    renamePage: (id: string, name: string) => {
      set((state) => {
        const page = state.pages[id];
        if (page) {
          page.name = name;
          page.modifiedAt = Date.now();
        }
      });
    },

    // Duplicate a page
    duplicatePage: (id: string): string | null => {
      const state = get();
      const sourcePage = state.pages[id];
      if (!sourcePage) {
        return null;
      }

      const newPageId = nanoid();
      const currentIndex = state.pageOrder.indexOf(id);

      set((draft) => {
        // Deep copy the page
        const newPage: Page = {
          ...JSON.parse(JSON.stringify(sourcePage)),
          id: newPageId,
          name: `${sourcePage.name} (Copy)`,
          createdAt: Date.now(),
          modifiedAt: Date.now(),
        };

        // Generate new IDs for all shapes
        const oldToNewId: Record<string, string> = {};
        const newShapes: Record<string, typeof newPage.shapes[string]> = {};
        const newShapeOrder: string[] = [];

        for (const oldId of newPage.shapeOrder) {
          const shape = newPage.shapes[oldId];
          if (shape) {
            const newId = nanoid();
            oldToNewId[oldId] = newId;
            newShapes[newId] = { ...shape, id: newId };
            newShapeOrder.push(newId);
          }
        }

        // Update group childIds to use new IDs
        for (const shape of Object.values(newShapes)) {
          if (shape.type === 'group' && 'childIds' in shape) {
            (shape as { childIds: string[] }).childIds = (
              shape as { childIds: string[] }
            ).childIds.map((childId) => oldToNewId[childId] ?? childId);
          }
          // Update connector references
          if (shape.type === 'connector' && 'startShapeId' in shape) {
            const connector = shape as { startShapeId?: string; endShapeId?: string };
            if (connector.startShapeId) {
              const newStartId = oldToNewId[connector.startShapeId];
              if (newStartId) {
                connector.startShapeId = newStartId;
              }
            }
            if (connector.endShapeId) {
              const newEndId = oldToNewId[connector.endShapeId];
              if (newEndId) {
                connector.endShapeId = newEndId;
              }
            }
          }
        }

        newPage.shapes = newShapes;
        newPage.shapeOrder = newShapeOrder;

        draft.pages[newPageId] = newPage;
        // Insert after the source page
        draft.pageOrder.splice(currentIndex + 1, 0, newPageId);
      });

      return newPageId;
    },

    // Reorder pages
    reorderPages: (newOrder: string[]) => {
      set((state) => {
        // Validate all IDs exist
        const existingIds = new Set(Object.keys(state.pages));
        const validOrder = newOrder.filter((id) => existingIds.has(id));

        if (validOrder.length === state.pageOrder.length) {
          state.pageOrder = validOrder;
        }
      });
    },

    // Set active page
    setActivePage: (id: string) => {
      const state = get();

      // Don't switch if already active or page doesn't exist
      if (state.activePageId === id || !state.pages[id]) {
        return;
      }

      // Cross-page corruption guard: disable history tracking across the
      // entire swap so any synchronous subscriber that reacts to the
      // documentStore mutation cannot push a snapshot into the wrong
      // page bucket. Update historyStore's activePageId BEFORE the
      // documentStore swap so the page-id mirror is correct if any
      // re-entrant push slips through.
      const history = useHistoryStore.getState();
      const wasTracking = history.isTracking;
      history.setTracking(false);
      try {
        // Save current page camera state before switching
        if (state.activePageId) {
          useSessionStore.getState().savePageCamera(state.activePageId);
        }

        // Save current page content from documentStore (still on old page)
        get().syncCurrentPageFromDocument();

        // Flip page identity in both stores BEFORE touching documentStore.
        set((draft) => {
          draft.activePageId = id;
        });
        history.setActivePage(id);
        registerPageStoreActiveId(id);

        // Load new page content into documentStore — UNLESS a live collab session
        // owns the active-page load (JP-340). In collab the YjsDocument rebind
        // (useCollaborationSync) is the authoritative loader of the new page's
        // shapes from its `shapes:<id>` surface; `pages[id].shapes` here is a
        // stale/empty snapshot (a remote-created page carries no shapes in the
        // page-list meta) that would flash before the rebind. The OLD-page save
        // (`syncCurrentPageFromDocument` above) is harmless and kept either way.
        if (!collabOwnsActivePageLoad()) {
          get().syncDocumentToCurrentPage();
        }

        // Restore camera state for new page
        useSessionStore.getState().restorePageCamera(id);
        useSessionStore.getState().clearSelection();
      } finally {
        history.setTracking(wasTracking);
      }
    },

    // Get a page by ID
    getPage: (id: string): Page | undefined => {
      return get().pages[id];
    },

    // Get the active page
    getActivePage: (): Page | undefined => {
      const state = get();
      return state.activePageId ? state.pages[state.activePageId] : undefined;
    },

    // Get page count
    getPageCount: (): number => {
      return get().pageOrder.length;
    },

    // Sync current documentStore content to the active page
    syncCurrentPageFromDocument: () => {
      const state = get();
      if (!state.activePageId) return;

      const docState = useDocumentStore.getState();

      set((draft) => {
        const page = draft.pages[draft.activePageId!];
        if (page) {
          page.shapes = JSON.parse(JSON.stringify(docState.shapes));
          page.shapeOrder = [...docState.shapeOrder];
          page.modifiedAt = Date.now();
        }
      });
    },

    // Load active page content into documentStore
    syncDocumentToCurrentPage: () => {
      const state = get();
      const activePage = state.activePageId ? state.pages[state.activePageId] : null;

      if (activePage) {
        useDocumentStore.getState().loadSnapshot({
          shapes: activePage.shapes,
          shapeOrder: activePage.shapeOrder,
          version: 1,
        });
      }
    },

    // Get snapshot for persistence
    getSnapshot: (): PageStoreSnapshot => {
      // First sync current page from document
      get().syncCurrentPageFromDocument();

      const state = get();
      return {
        pages: JSON.parse(JSON.stringify(state.pages)),
        pageOrder: [...state.pageOrder],
        activePageId: state.activePageId,
      };
    },

    // Load from snapshot
    loadSnapshot: (snapshot: PageStoreSnapshot) => {
      set((state) => {
        state.pages = JSON.parse(JSON.stringify(snapshot.pages));
        state.pageOrder = [...snapshot.pageOrder];
        state.activePageId = snapshot.activePageId;
      });

      // Load active page into documentStore
      get().syncDocumentToCurrentPage();

      // Clear session state and set history active page
      useSessionStore.getState().clearSelection();
      useHistoryStore.getState().clear();
      if (snapshot.activePageId) {
        useHistoryStore.getState().setActivePage(snapshot.activePageId);
      }
      registerPageStoreActiveId(snapshot.activePageId);
    },

    applyRemoteCanvasPageList: (list: CanvasPageList) => {
      set((draft) => {
        const incoming = new Set(list.pageOrder);

        // Upsert each remote page's METADATA, preserving local shapes/shapeOrder
        // (only the active page's shapes live in the Y.Doc, so a page-list delta
        // must never wipe a page's diagram). A page new to this client is created
        // as an empty skeleton — its shapes materialize when it becomes active
        // (the JP-34 active-page-only limitation, unchanged by JP-339).
        for (const id of list.pageOrder) {
          const meta = list.pages[id];
          if (!meta) continue;
          const existing = draft.pages[id];
          if (existing) {
            existing.name = meta.name;
          } else {
            const page = createPage(meta.name, id);
            if (meta.createdAt !== undefined) page.createdAt = meta.createdAt;
            if (meta.modifiedAt !== undefined) page.modifiedAt = meta.modifiedAt;
            draft.pages[id] = page;
          }
        }

        // Drop pages the merged set no longer contains (a remote delete).
        for (const id of Object.keys(draft.pages)) {
          if (!incoming.has(id)) {
            delete draft.pages[id];
          }
        }

        draft.pageOrder = [...list.pageOrder];

        // Repoint the (client-local) active page if it was pruned. The deleted-
        // active-page case is also covered by the relay's resident-page evict +
        // re-hydrate (delete_canvas_page), so this is belt-and-suspenders.
        if (!draft.activePageId || !draft.pages[draft.activePageId]) {
          draft.activePageId = draft.pageOrder[0] ?? null;
        }
      });
    },

    // Reset to empty state
    reset: () => {
      set((state) => {
        state.pages = {};
        state.pageOrder = [];
        state.activePageId = null;
      });
      // Lockstep with the mirror: clear history's active page too so there's
      // no window where the two disagree (e.g. reset before re-init).
      useHistoryStore.getState().setActivePage(null);
      registerPageStoreActiveId(null);
    },

    // Initialize with a default page
    initializeDefault: () => {
      const state = get();
      if (state.pageOrder.length === 0) {
        get().createPage('Page 1');
      }
    },
  }))
);

/**
 * Get the active page ID.
 */
export function getActivePageId(): string | null {
  return usePageStore.getState().activePageId;
}

/**
 * Check if a page exists.
 */
export function pageExists(id: string): boolean {
  return usePageStore.getState().pages[id] !== undefined;
}
