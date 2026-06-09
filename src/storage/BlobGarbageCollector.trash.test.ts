/**
 * JP-291 — the blob GC must treat trashed documents as live referencers.
 *
 * The collector is scan-based off the *active* document index, so without
 * unioning the trash mark-set, a document's blobs would be reclaimed the moment
 * it left the active index for the trash. This guards that: a blob referenced
 * only by a trashed doc survives, and is reclaimable again once the trash is
 * emptied.
 *
 * IndexedDB-free: a fake `BlobStorage` is injected and the persistence module
 * (active-doc source) is mocked; the trash side uses the real `TrashStorage`
 * over a mocked localStorage.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mock the active-document source the GC scans. The trash side stays real.
vi.mock('../store/persistenceStore', () => ({
  usePersistenceStore: {
    getState: () => ({
      getDocumentList: () => [{ id: 'active-doc', modifiedAt: 1, name: 'Active' }],
    }),
  },
  loadDocumentFromStorage: (id: string) =>
    id === 'active-doc' ? { id, blobReferences: ['active-blob'] } : null,
}));

import { BlobGarbageCollector } from './BlobGarbageCollector';
import type { BlobStorage } from './BlobStorage';
import type { BlobMetadata } from './BlobTypes';
import { moveToTrash, emptyTrash } from './TrashStorage';
import type { DiagramDocument, DocumentMetadata } from '../types/Document';

const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v; },
    removeItem: (k: string) => { delete store[k]; },
    clear: () => { store = {}; },
    get length() { return Object.keys(store).length; },
    key: (i: number) => Object.keys(store)[i] ?? null,
  };
})();
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

function blob(id: string): BlobMetadata {
  return { id, size: 10, type: 'image/png', createdAt: 0, usageCount: 1 } as BlobMetadata;
}

/** Fake content-addressed store holding three blobs; records deletions. */
function makeFakeStorage(deleted: Set<string>): BlobStorage {
  const all = [blob('active-blob'), blob('trash-blob'), blob('orphan-blob')];
  return {
    listAllBlobs: async () => all.filter((b) => !deleted.has(b.id)),
    deleteBlob: async (id: string) => { deleted.add(id); },
  } as unknown as BlobStorage;
}

const doc = (id: string): DiagramDocument => ({
  id,
  name: id,
  pages: {},
  pageOrder: ['p1'],
  activePageId: 'p1',
  createdAt: 0,
  modifiedAt: 0,
  version: 1,
});
const meta = (id: string): DocumentMetadata => ({ id, name: id, createdAt: 0, modifiedAt: 0, pageCount: 1 });

describe('BlobGarbageCollector + trash (JP-291)', () => {
  beforeEach(() => localStorageMock.clear());

  it('keeps a blob referenced only by a trashed doc, and reclaims it after empty', async () => {
    moveToTrash(doc('trashed-doc'), meta('trashed-doc'), undefined, { blobReferences: ['trash-blob'] });

    const deleted = new Set<string>();
    const gc = new BlobGarbageCollector(makeFakeStorage(deleted));

    // While trashed: only the truly-unreferenced blob is an orphan.
    let orphans = (await gc.getOrphanedBlobs()).map((b) => b.id);
    expect(orphans).toEqual(['orphan-blob']);

    await gc.collectGarbage();
    expect(deleted.has('trash-blob')).toBe(false); // survived
    expect(deleted.has('active-blob')).toBe(false);
    expect(deleted.has('orphan-blob')).toBe(true);

    // Empty the trash → the trashed doc's blob is now reclaimable.
    emptyTrash();
    orphans = (await gc.getOrphanedBlobs()).map((b) => b.id);
    expect(orphans).toContain('trash-blob');
  });

  it('incremental collection also honours the trash mark-set', async () => {
    moveToTrash(doc('trashed-doc'), meta('trashed-doc'), undefined, { blobReferences: ['trash-blob'] });

    const deleted = new Set<string>();
    const gc = new BlobGarbageCollector(makeFakeStorage(deleted));

    await gc.collectGarbageIncremental();
    expect(deleted.has('trash-blob')).toBe(false);
    expect(deleted.has('orphan-blob')).toBe(true);
  });
});
