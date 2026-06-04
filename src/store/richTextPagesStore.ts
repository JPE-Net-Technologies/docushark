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
 * Default page names for new pages.
 */
const DEFAULT_PAGE_NAMES = [
  'Page 1',
  'Notes',
  'Draft',
  'Ideas',
  'Reference',
];

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
      const pageName = name || `Page ${order + 1}`;
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
        // create the same default page → their prose fragments align.
        get().createPage(DEFAULT_PAGE_NAMES[0], undefined, DEFAULT_PROSE_PAGE_ID);
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
  }))
);

/**
 * Initialize the pages store with a default page if empty.
 */
export function initializeRichTextPages(): void {
  useRichTextPagesStore.getState().initializeDefaultPage();
}
