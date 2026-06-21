/**
 * richTextPagesStore - Multi-page support for the rich text editor.
 *
 * Manages multiple pages within the document editor, each with its own
 * content, name, and color. Pages are persisted alongside the main
 * rich text content.
 *
 * WRITE RAIL (JP-198): page **content** (`updatePageContent`/`loadPages`) is a
 * PROJECTION — set only by the editor `onUpdate` mirror or a load. Don't write
 * page content from elsewhere. Page-structure ops (add/rename/reorder/setActive)
 * are ordinary user actions and are not governed. Enforced by
 * `proseWriteBoundary.test.ts`.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { PROSE_PAGE_BASE, nextDefaultPageName } from './pageNaming';
import type { ProsePageList } from '../collaboration/YjsDocument';

/**
 * Represents a single page in the rich text editor.
 */
export interface RichTextPage {
  /** Unique identifier for the page */
  id: string;
  /** Display name of the page */
  name: string;
  /** Optional color for the tab */
  color?: string;
  /** HTML content of the page */
  content: string;
  /** Order index for sorting */
  order: number;
  /** Creation timestamp */
  createdAt: number;
  /** Last modified timestamp */
  modifiedAt: number;
}

/**
 * State for the rich text pages store.
 */
interface RichTextPagesState {
  /** All pages indexed by ID */
  pages: Record<string, RichTextPage>;
  /** Currently active page ID */
  activePageId: string | null;
  /** Ordered list of page IDs */
  pageOrder: string[];
}

/**
 * Actions for the rich text pages store.
 */
interface RichTextPagesActions {
  /** Create a new page. `id` lets callers pin a deterministic id (e.g. the
   *  default page on a relay doc, so collaborators' fragments align). */
  createPage: (name?: string, color?: string, id?: string) => string;
  /** Delete a page by ID */
  deletePage: (id: string) => void;
  /** Rename a page */
  renamePage: (id: string, name: string) => void;
  /** Set page color */
  setPageColor: (id: string, color: string | undefined) => void;
  /** Set active page */
  setActivePage: (id: string) => void;
  /** Update page content */
  updatePageContent: (id: string, content: string) => void;
  /** Reorder pages */
  reorderPages: (fromIndex: number, toIndex: number) => void;
  /** Get the active page */
  getActivePage: () => RichTextPage | null;
  /** Initialize with default page if empty */
  initializeDefaultPage: () => void;
  /** Load pages from serialized data */
  loadPages: (data: { pages: Record<string, RichTextPage>; pageOrder: string[]; activePageId: string | null }) => void;
  /** Adopt a remote prose page-LIST (JP-339): merge tab metadata
   *  (name/color/order) from the CRDT, preserving each page's already-synced
   *  `content`, and prune pages absent from the merged set. */
  applyRemoteProsePageList: (list: ProsePageList) => void;
  /** Get serialized data for persistence */
  serialize: () => { pages: Record<string, RichTextPage>; pageOrder: string[]; activePageId: string | null };
}

/**
 * Generate a unique page ID.
 */
function generatePageId(): string {
  return `page-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Stable id for the auto-created default prose page. Two clients opening the
 * same never-had-prose relay doc must agree on the first page's id, or their
 * `prose:<id>` Y.XmlFragments never align and collaborative prose can't sync
 * (client-random ids would differ). Page ids are scoped per document, so a
 * constant is collision-free across docs.
 */
const DEFAULT_PROSE_PAGE_ID = 'rt-page-1';


/**
 * Rich text pages store.
 */
export const useRichTextPagesStore = create<RichTextPagesState & RichTextPagesActions>()(
  immer((set, get) => ({
    pages: {},
    activePageId: null,
    pageOrder: [],

    createPage: (name?: string, color?: string, id?: string) => {
      const pageId = id ?? generatePageId();
      const state = get();
      const order = state.pageOrder.length;
      const existingNames = state.pageOrder.map((pid) => state.pages[pid]?.name ?? '');
      const pageName = name || nextDefaultPageName(PROSE_PAGE_BASE, existingNames);
      const now = Date.now();

      set((draft) => {
        const page: RichTextPage = {
          id: pageId,
          name: pageName,
          content: '',
          order,
          createdAt: now,
          modifiedAt: now,
        };
        if (color !== undefined) {
          page.color = color;
        }
        draft.pages[pageId] = page;
        draft.pageOrder.push(pageId);
        if (!draft.activePageId) {
          draft.activePageId = pageId;
        }
      });

      return pageId;
    },

    deletePage: (id: string) => {
      const state = get();
      if (state.pageOrder.length <= 1) {
        // Don't delete the last page
        return;
      }

      set((draft) => {
        const index = draft.pageOrder.indexOf(id);
        if (index === -1) return;

        // Remove from order
        draft.pageOrder.splice(index, 1);
        
        // Delete page data
        delete draft.pages[id];

        // Update active page if necessary
        if (draft.activePageId === id) {
          // Switch to adjacent page
          const newIndex = Math.min(index, draft.pageOrder.length - 1);
          draft.activePageId = draft.pageOrder[newIndex] ?? null;
        }

        // Update order indices
        draft.pageOrder.forEach((pageId, i) => {
          const page = draft.pages[pageId];
          if (page) {
            page.order = i;
          }
        });
      });
    },

    renamePage: (id: string, name: string) => {
      set((draft) => {
        const page = draft.pages[id];
        if (page) {
          page.name = name.trim() || 'Untitled';
          page.modifiedAt = Date.now();
        }
      });
    },

    setPageColor: (id: string, color: string | undefined) => {
      set((draft) => {
        const page = draft.pages[id];
        if (page) {
          if (color === undefined) {
            delete page.color;
          } else {
            page.color = color;
          }
          page.modifiedAt = Date.now();
        }
      });
    },

    setActivePage: (id: string) => {
      set((draft) => {
        if (draft.pages[id]) {
          draft.activePageId = id;
        }
      });
    },

    updatePageContent: (id: string, content: string) => {
      set((draft) => {
        const page = draft.pages[id];
        if (page) {
          page.content = content;
          page.modifiedAt = Date.now();
        }
      });
    },

    reorderPages: (fromIndex: number, toIndex: number) => {
      set((draft) => {
        const [removed] = draft.pageOrder.splice(fromIndex, 1);
        if (removed) {
          draft.pageOrder.splice(toIndex, 0, removed);
          
          // Update order indices
          draft.pageOrder.forEach((pageId, i) => {
            const page = draft.pages[pageId];
            if (page) {
              page.order = i;
            }
          });
        }
      });
    },

    getActivePage: () => {
      const state = get();
      if (!state.activePageId) return null;
      return state.pages[state.activePageId] ?? null;
    },

    initializeDefaultPage: () => {
      const state = get();
      if (state.pageOrder.length === 0) {
        // Deterministic id so collaborators on a never-had-prose relay doc
        // create the same default page → their prose fragments align. No name →
        // bare `Prose` (the id is load-bearing; the name is cosmetic).
        get().createPage(undefined, undefined, DEFAULT_PROSE_PAGE_ID);
      }
    },

    loadPages: (data) => {
      set((draft) => {
        draft.pages = data.pages;
        draft.pageOrder = data.pageOrder;
        draft.activePageId = data.activePageId;
      });
    },

    serialize: () => {
      const state = get();
      return {
        pages: state.pages,
        pageOrder: state.pageOrder,
        activePageId: state.activePageId,
      };
    },

    applyRemoteProsePageList: (list) => {
      set((draft) => {
        const incoming = new Set(list.pageOrder);

        // Upsert each remote page's METADATA, preserving local content (which
        // syncs over its own `prose:<id>` fragment) so a page-list delta can
        // never wipe live prose. A page new to this client is created with
        // empty content — its fragment populates via the prose sync.
        list.pageOrder.forEach((id, index) => {
          const meta = list.pages[id];
          if (!meta) return;
          const existing = draft.pages[id];
          const now = Date.now();
          const page: RichTextPage = {
            id,
            name: meta.name,
            content: existing?.content ?? '',
            // Order is driven by `pageOrder` (the array), so the index in the
            // merged order is authoritative — not the (possibly stale) numeric
            // `meta.order`.
            order: index,
            createdAt: meta.createdAt ?? existing?.createdAt ?? now,
            modifiedAt: meta.modifiedAt ?? existing?.modifiedAt ?? now,
          };
          if (meta.color !== undefined) {
            page.color = meta.color;
          } else if (existing?.color !== undefined) {
            // Remote cleared the color — drop it (don't resurrect the old one).
            // (page.color already unset.)
          }
          draft.pages[id] = page;
        });

        // Drop pages the merged set no longer contains (a remote delete).
        for (const id of Object.keys(draft.pages)) {
          if (!incoming.has(id)) {
            delete draft.pages[id];
          }
        }

        draft.pageOrder = [...list.pageOrder];

        // Repoint the (client-local) active page if it was pruned.
        if (!draft.activePageId || !draft.pages[draft.activePageId]) {
          draft.activePageId = draft.pageOrder[0] ?? null;
        }
      });
    },
  }))
);

/**
 * Initialize the pages store with a default page if empty.
 */
export function initializeRichTextPages(): void {
  useRichTextPagesStore.getState().initializeDefaultPage();
}
