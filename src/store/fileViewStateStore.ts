/**
 * Persisted per-user file reading state (last page, zoom, bookmarks), keyed
 * `docId:shapeId`. Deliberately isolated from the versioned uiPreferencesStore
 * (shapePickerStore pattern): its own localStorage key, no migration chain,
 * capped by the bookmark-preferring LRU in fileViewState.ts. Local-only by
 * design — reading position must never enter the document or the CRDT.
 */

import { create } from 'zustand';
import { persist, createJSONStorage } from 'zustand/middleware';
import {
  upsertRecord,
  viewKey,
  type FileViewRecord,
} from './fileViewState';

export interface FileViewStateState {
  records: Record<string, FileViewRecord>;
  /** Merge a patch into the record for this file (creates it if absent). */
  upsert: (
    docId: string,
    shapeId: string,
    patch: Partial<Omit<FileViewRecord, 'updatedAt'>>,
  ) => void;
  clear: () => void;
}

export const useFileViewStateStore = create<FileViewStateState>()(
  persist(
    (set) => ({
      records: {},
      upsert: (docId, shapeId, patch) =>
        set((state) => ({
          records: upsertRecord(state.records, viewKey(docId, shapeId), patch, Date.now()),
        })),
      clear: () => set({ records: {} }),
    }),
    {
      name: 'docushark-file-view-state',
      storage: createJSONStorage(() => localStorage),
      partialize: (state) => ({ records: state.records }),
    },
  ),
);

/** Non-hook read for imperative call-sites. */
export function getFileViewRecord(
  docId: string,
  shapeId: string,
): FileViewRecord | undefined {
  return useFileViewStateStore.getState().records[viewKey(docId, shapeId)];
}
