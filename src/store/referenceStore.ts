/**
 * referenceStore - Per-document reference library (JP-89, slice 1).
 *
 * Holds the active document's CSL-JSON references (the backing store for inline
 * citations + the bibliography block in later slices). Modelled on
 * `richTextPagesStore`: a pure id-map + order-array data store, serialized into
 * `DiagramDocument.references` on save and reloaded / cleared on document
 * switch by `persistenceStore`.
 *
 * This is a **data store only** — no formatting, ingest, or DOI lookup (those
 * are JP-89 slices 2/3). Keep it free of network and `@citation-js` imports so
 * it stays light and synchronous.
 */

import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { CSLItem, CitationStyle, ReferenceLibrary } from '../types/Citation';
import { DEFAULT_CITATION_STYLE, isReferenceLibrary } from '../types/Citation';

/**
 * State for the reference store.
 */
interface ReferenceState {
  /** CSL items keyed by id. */
  items: Record<string, CSLItem>;
  /** Display order of item ids. */
  itemOrder: string[];
  /** Active citation style for the document (persisted per-doc). */
  activeStyle: CitationStyle;
}

/**
 * Actions for the reference store.
 */
interface ReferenceActions {
  /** Insert a new reference. If its id collides, it is treated as an upsert. */
  addReference: (item: CSLItem) => string;
  /** Insert or replace a reference by id (id generated if absent). */
  upsertReference: (item: CSLItem) => string;
  /** Shallow-merge a patch into an existing reference. No-op if id unknown. */
  updateReference: (id: string, patch: Partial<CSLItem>) => void;
  /** Remove a reference by id. */
  removeReference: (id: string) => void;
  /** Get a reference by id. */
  getReference: (id: string) => CSLItem | undefined;
  /** All references in display order. */
  listReferences: () => CSLItem[];
  /** Set the document's active citation style. */
  setStyle: (style: CitationStyle) => void;
  /** Reset to an empty library + default style (document switch / new document). */
  clear: () => void;
  /** Load a serialized library, defensively normalizing malformed input. */
  loadReferences: (data: ReferenceLibrary) => void;
  /** Serialize for persistence into `DiagramDocument.references`. */
  serialize: () => ReferenceLibrary;
}

/**
 * Generate a unique reference id when an item arrives without a citekey.
 * Mirrors the id-generation idiom in `richTextPagesStore`. Ids are scoped per
 * document, so the timestamp+random suffix is collision-free in practice.
 */
function generateReferenceId(): string {
  return `ref-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

export const useReferenceStore = create<ReferenceState & ReferenceActions>()(
  immer((set, get) => ({
    items: {},
    itemOrder: [],
    activeStyle: DEFAULT_CITATION_STYLE,

    upsertReference: (item: CSLItem) => {
      const id = item.id && item.id.trim() ? item.id : generateReferenceId();
      set((draft) => {
        const stored: CSLItem = { ...item, id };
        if (!draft.items[id]) {
          draft.itemOrder.push(id);
        }
        draft.items[id] = stored;
      });
      return id;
    },

    addReference: (item: CSLItem) => {
      // Insert semantics with id-collision tolerance == upsert.
      return get().upsertReference(item);
    },

    updateReference: (id: string, patch: Partial<CSLItem>) => {
      set((draft) => {
        const existing = draft.items[id];
        if (!existing) return;
        // Preserve the canonical id; a patch must not silently re-key an item.
        draft.items[id] = { ...existing, ...patch, id };
      });
    },

    removeReference: (id: string) => {
      set((draft) => {
        if (!draft.items[id]) return;
        delete draft.items[id];
        const index = draft.itemOrder.indexOf(id);
        if (index !== -1) {
          draft.itemOrder.splice(index, 1);
        }
      });
    },

    getReference: (id: string) => {
      return get().items[id];
    },

    listReferences: () => {
      const state = get();
      return state.itemOrder
        .map((id) => state.items[id])
        .filter((item): item is CSLItem => item !== undefined);
    },

    setStyle: (style: CitationStyle) => {
      set((draft) => {
        draft.activeStyle = style;
      });
    },

    clear: () => {
      set((draft) => {
        draft.items = {};
        draft.itemOrder = [];
        draft.activeStyle = DEFAULT_CITATION_STYLE;
      });
    },

    loadReferences: (data: ReferenceLibrary) => {
      set((draft) => {
        if (!isReferenceLibrary(data)) {
          // Malformed input degrades to an empty library — never throw.
          draft.items = {};
          draft.itemOrder = [];
          draft.activeStyle = DEFAULT_CITATION_STYLE;
          return;
        }
        // Drop order entries with no backing item, and append any items missing
        // from the order, so the two collections stay consistent after an
        // imperfect import.
        const items = data.items;
        const order = data.itemOrder.filter((id) => items[id] !== undefined);
        for (const id of Object.keys(items)) {
          if (!order.includes(id)) {
            order.push(id);
          }
        }
        draft.items = items;
        draft.itemOrder = order;
        draft.activeStyle = data.style ?? DEFAULT_CITATION_STYLE;
      });
    },

    serialize: () => {
      const state = get();
      return {
        items: state.items,
        itemOrder: state.itemOrder,
        style: state.activeStyle,
      };
    },
  }))
);
