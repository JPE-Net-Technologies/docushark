/**
 * Trash store (JP-291)
 *
 * The client-side substrate behind the Documents "Trash" bin. It aggregates the
 * trashed documents the user can recover or purge, and orchestrates the *async*
 * blob reclaim around the otherwise-synchronous `TrashStorage` calls.
 *
 * Three kinds of document end up in the trash (see the parent ask, JP-175):
 *
 *  - **local**    — a personal document the user soft-deleted.
 *  - **stranded** — a relay document hard-deleted out from under us; we kept the
 *    last local copy rather than wiping it.
 *  - (future) **relay-soft** — a relay-side soft-delete still restorable on the
 *    server (JP-294). It lives on the relay, not here; when that lands it gets
 *    its own source and is unioned into the view — this store's shape leaves
 *    room for it without a reshape.
 *
 * **Blob lifetime.** Trashing never releases a document's blobs; they're kept
 * alive while the doc sits in trash because `BlobGarbageCollector` unions the
 * trash mark-set in. Purging / emptying / expiring an entry removes it from that
 * set, so a GC pass right after reclaims the now-unreferenced bytes. Restore
 * puts the document back into the active index, so its blobs stay referenced and
 * are never collected.
 */

import { create } from 'zustand';
import type { DiagramDocument } from '../types/Document';
import { getDocumentMetadata } from '../types/Document';
import { collectBlobReferences } from '../storage/AssetBundler';
import { blobStorage } from '../storage/BlobStorage';
import { BlobGarbageCollector } from '../storage/BlobGarbageCollector';
import {
  getTrashItems,
  moveToTrash,
  recoverFromTrash,
  permanentlyDeleteFromTrash,
  emptyTrash,
  cleanupExpiredTrash,
  type TrashItem,
  type TrashOrigin,
} from '../storage/TrashStorage';
import { usePersistenceStore } from './persistenceStore';

/** Reused so the incremental ref cache survives across reclaim passes. */
const gc = new BlobGarbageCollector(blobStorage);

/**
 * Reclaim blobs no longer referenced by any active OR trashed document. Called
 * after an entry leaves the trash (purge/empty/expire). Best-effort — a failure
 * just leaves the bytes for the next sweep; it must never break the trash op.
 */
async function reclaimOrphanedBlobs(): Promise<void> {
  try {
    await gc.collectGarbageIncremental();
  } catch (error) {
    console.warn('[trashStore] blob reclaim failed (will retry next sweep):', error);
  }
}

interface TrashState {
  /** Trashed documents, newest first. Mirror of `TrashStorage.getTrashItems()`. */
  items: TrashItem[];
}

interface TrashActions {
  /** Reload the in-memory list from storage. */
  refresh: () => void;

  /** Soft-delete a personal document into the trash (category 2). */
  trashLocal: (doc: DiagramDocument) => void;

  /**
   * Strand a relay document into the trash (category 3): it was hard-deleted on
   * the relay, but we keep our last local copy here rather than wiping it.
   */
  trashStranded: (doc: DiagramDocument, origin: TrashOrigin) => void;

  /**
   * Restore a trashed document. Both kinds come back as a *local* document — a
   * stranded relay doc can't return to a relay that deleted it. Returns false
   * if the bytes couldn't be read.
   */
  restore: (id: string) => Promise<boolean>;

  /** Permanently delete one entry and reclaim its blobs. */
  purge: (id: string) => Promise<void>;

  /** Empty the entire trash and reclaim freed blobs. Returns items removed. */
  emptyAll: () => Promise<number>;

  /**
   * Remove expired entries and reclaim their blobs. Safe to call on app start.
   * Returns the number of entries swept.
   */
  expireSweep: () => Promise<number>;
}

export const useTrashStore = create<TrashState & TrashActions>((set, get) => ({
  items: [],

  refresh: () => set({ items: getTrashItems() }),

  trashLocal: (doc) => {
    moveToTrash(doc, getDocumentMetadata(doc), undefined, {
      kind: 'local',
      blobReferences: collectBlobReferences(doc),
    });
    get().refresh();
  },

  trashStranded: (doc, origin) => {
    moveToTrash(doc, getDocumentMetadata(doc), undefined, {
      kind: 'stranded',
      origin,
      blobReferences: collectBlobReferences(doc),
    });
    get().refresh();
  },

  restore: async (id) => {
    const result = recoverFromTrash(id);
    if (!result.success || !result.document) return false;
    usePersistenceStore.getState().adoptDocument(result.document);
    get().refresh();
    return true;
  },

  purge: async (id) => {
    permanentlyDeleteFromTrash(id);
    get().refresh();
    await reclaimOrphanedBlobs();
  },

  emptyAll: async () => {
    const removed = emptyTrash();
    get().refresh();
    await reclaimOrphanedBlobs();
    return removed;
  },

  expireSweep: async () => {
    const swept = cleanupExpiredTrash();
    if (swept > 0) {
      get().refresh();
      await reclaimOrphanedBlobs();
    }
    return swept;
  },
}));

export default useTrashStore;
