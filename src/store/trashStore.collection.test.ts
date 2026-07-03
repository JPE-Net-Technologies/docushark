/**
 * JP-418 — trashing a document drops its collection enrollment.
 *
 * A collection counts members from `collectionStore.assignments`. Before this
 * fix a trashed doc kept its assignment, so the collection's sidebar count kept
 * including a doc that no longer exists in the active set. `trashLocal` and
 * `trashStranded` (the single funnel for all three trash paths) now clear the
 * assignment. Restore brings the doc back Unassigned.
 *
 * We use the REAL `collectionStore` (a plain zustand store) and mock only the
 * storage layer so no IndexedDB is touched.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../storage/TrashStorage', () => ({
  moveToTrash: vi.fn(),
  getTrashItems: vi.fn(() => []),
  getTrashedBlobReferences: vi.fn(() => new Set<string>()),
  recoverFromTrash: vi.fn(),
  permanentlyDeleteFromTrash: vi.fn(),
  emptyTrash: vi.fn(() => 0),
  cleanupExpiredTrash: vi.fn(() => 0),
}));
vi.mock('../storage/AssetBundler', () => ({
  collectBlobReferences: vi.fn(() => []),
}));
vi.mock('../storage/BlobStorage', () => ({
  blobStorage: { listAllBlobs: vi.fn(async () => []) },
}));
vi.mock('../storage/BlobGarbageCollector', () => ({
  BlobGarbageCollector: class {
    collectGarbageIncremental = vi.fn(async () => {});
  },
}));
vi.mock('./persistenceStore', () => ({
  usePersistenceStore: { getState: () => ({ getDocumentList: () => [], adoptDocument: vi.fn() }) },
  loadDocumentFromStorage: vi.fn(() => null),
}));

import { useTrashStore } from './trashStore';
import { useCollectionStore } from './collectionStore';
import type { DiagramDocument } from '../types/Document';

const DOC_ID = 'doc-1';
const makeDoc = (): DiagramDocument =>
  ({ id: DOC_ID, name: 'My Doc', pages: {}, pageOrder: [] }) as unknown as DiagramDocument;

function seedAssignedDoc(): string {
  useCollectionStore.getState().reset();
  const cid = useCollectionStore.getState().createCollection('Research', undefined, 'local');
  useCollectionStore.getState().assignDocument(DOC_ID, cid);
  // Sanity: the doc counts as a member before trashing.
  expect(useCollectionStore.getState().assignments[DOC_ID]).toBe(cid);
  return cid;
}

describe('trashStore drops collection enrollment (JP-418)', () => {
  beforeEach(() => {
    useCollectionStore.getState().reset();
  });

  it('trashLocal clears the doc assignment', () => {
    const cid = seedAssignedDoc();
    useTrashStore.getState().trashLocal(makeDoc());
    expect(useCollectionStore.getState().assignments[DOC_ID]).toBeUndefined();
    // The collection's member count (derived from assignments) drops to 0.
    const count = Object.values(useCollectionStore.getState().assignments).filter((c) => c === cid).length;
    expect(count).toBe(0);
  });

  it('trashStranded clears the doc assignment', () => {
    const cid = seedAssignedDoc();
    useTrashStore.getState().trashStranded(makeDoc(), { relayId: 'relay-1' });
    expect(useCollectionStore.getState().assignments[DOC_ID]).toBeUndefined();
    const count = Object.values(useCollectionStore.getState().assignments).filter((c) => c === cid).length;
    expect(count).toBe(0);
  });
});
