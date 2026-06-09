/**
 * CollectionStore
 *
 * Client-side document organisation into **collections** — "workspaces inside
 * your workspace". Each document belongs to at most one collection (a single,
 * flat membership; absence means "Unassigned"). Collections are user-defined
 * with a name, optional accent colour, and a user-controlled order. Membership
 * is keyed by document id so it works uniformly for local, remote, and cached
 * document records — no changes to the document JSON schema are needed.
 *
 * This is the **canonical client-side collections model**. Membership lives
 * locally today; giving it a server-readable home (so docushark-web can render
 * a collection's document-members) is later work that builds on this exact
 * shape — the stable `id` + `documentId → collectionId` map are deliberately
 * kept portable so future server/web layers can mirror them without a reshape.
 * Keep additions forward-compatible: prefer optional fields with sensible
 * defaults.
 *
 * Membership authority (resolved in the relay slice, not here): this store is
 * authoritative for **local-only** documents; once collections gain a
 * server-readable home, the relay becomes authoritative for **relay-hosted**
 * documents and the client write-through reconciles into this store on load.
 *
 * Stale assignments (referencing documents that no longer exist) are harmless;
 * the browser UI prunes them lazily when rendering.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { nanoid } from 'nanoid';

export interface Collection {
  id: string;
  name: string;
  color?: string;
  order: number;
  createdAt: number;
}

export interface CollectionState {
  /** Collection definitions keyed by collection id. */
  collections: Record<string, Collection>;
  /** documentId -> collectionId. Absence means "Unassigned". */
  assignments: Record<string, string>;
}

export interface CollectionActions {
  createCollection: (name: string, color?: string) => string;
  renameCollection: (id: string, name: string) => void;
  recolorCollection: (id: string, color: string | undefined) => void;
  reorderCollections: (orderedIds: string[]) => void;
  deleteCollection: (id: string) => void;
  assignDocument: (documentId: string, collectionId: string | null) => void;
  assignMany: (documentIds: string[], collectionId: string | null) => void;
  getCollectionForDocument: (documentId: string) => Collection | undefined;
  /** Returns collections sorted by order asc. */
  listCollections: () => Collection[];
  reset: () => void;
}

const initialState: CollectionState = {
  collections: {},
  assignments: {},
};

export const useCollectionStore = create<CollectionState & CollectionActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      createCollection: (name, color) => {
        const trimmed = name.trim();
        if (!trimmed) return '';
        const id = nanoid();
        const { collections } = get();
        const maxOrder = Object.values(collections).reduce((m, c) => Math.max(m, c.order), -1);
        const collection: Collection = {
          id,
          name: trimmed,
          order: maxOrder + 1,
          createdAt: Date.now(),
          ...(color !== undefined ? { color } : {}),
        };
        set({ collections: { ...collections, [id]: collection } });
        return id;
      },

      renameCollection: (id, name) => {
        const trimmed = name.trim();
        if (!trimmed) return;
        const { collections } = get();
        const existing = collections[id];
        if (!existing) return;
        set({ collections: { ...collections, [id]: { ...existing, name: trimmed } } });
      },

      recolorCollection: (id, color) => {
        const { collections } = get();
        const existing = collections[id];
        if (!existing) return;
        const next: Collection =
          color === undefined
            ? (() => {
                const { color: _drop, ...rest } = existing;
                return rest as Collection;
              })()
            : { ...existing, color };
        set({ collections: { ...collections, [id]: next } });
      },

      reorderCollections: (orderedIds) => {
        const { collections } = get();
        const next: Record<string, Collection> = { ...collections };
        orderedIds.forEach((id, index) => {
          const existing = next[id];
          if (existing) {
            next[id] = { ...existing, order: index };
          }
        });
        set({ collections: next });
      },

      deleteCollection: (id) => {
        const { collections, assignments } = get();
        if (!collections[id]) return;
        const nextCollections = { ...collections };
        delete nextCollections[id];
        const nextAssignments: Record<string, string> = {};
        for (const [docId, cid] of Object.entries(assignments)) {
          if (cid !== id) nextAssignments[docId] = cid;
        }
        set({ collections: nextCollections, assignments: nextAssignments });
      },

      assignDocument: (documentId, collectionId) => {
        const { assignments, collections } = get();
        if (collectionId === null) {
          if (!(documentId in assignments)) return;
          const next = { ...assignments };
          delete next[documentId];
          set({ assignments: next });
          return;
        }
        if (!collections[collectionId]) return;
        if (assignments[documentId] === collectionId) return;
        set({ assignments: { ...assignments, [documentId]: collectionId } });
      },

      assignMany: (documentIds, collectionId) => {
        const { assignments, collections } = get();
        if (collectionId !== null && !collections[collectionId]) return;
        const next = { ...assignments };
        for (const docId of documentIds) {
          if (collectionId === null) {
            delete next[docId];
          } else {
            next[docId] = collectionId;
          }
        }
        set({ assignments: next });
      },

      getCollectionForDocument: (documentId) => {
        const { assignments, collections } = get();
        const cid = assignments[documentId];
        if (!cid) return undefined;
        return collections[cid];
      },

      listCollections: () => {
        const { collections } = get();
        return Object.values(collections).sort((a, b) => a.order - b.order);
      },

      reset: () => set(initialState),
    }),
    {
      name: 'docushark-collections',
      version: 1,
      partialize: (state) => ({
        collections: state.collections,
        assignments: state.assignments,
      }),
    }
  )
);

/** Preset swatches for the collection recolor picker. */
export const COLLECTION_SWATCHES: readonly string[] = [
  '#ef4444', // red
  '#f59e0b', // amber
  '#10b981', // emerald
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
];
