/**
 * JP-292 — local delete routing.
 *
 *  - `deleteDocument` is a *soft* delete: the doc moves to the Trash and its
 *    blobs are NOT released (they stay reffed via the trash mark-set).
 *  - `permanentlyDeleteDocument` bypasses the Trash: hard removal + blob release.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { usePersistenceStore, saveDocumentToStorage } from './persistenceStore';
import { isInTrash, getTrashItem, emptyTrash } from '../storage/TrashStorage';
import { blobStorage } from '../storage/BlobStorage';
import { getDocumentMetadata, type DiagramDocument } from '../types/Document';

function makeDoc(id: string): DiagramDocument {
  return {
    id,
    name: id,
    pages: {},
    pageOrder: ['p1'],
    activePageId: 'p1',
    createdAt: 0,
    modifiedAt: 0,
    version: 1,
    blobReferences: ['b1'],
  };
}

describe('persistenceStore delete routing (JP-292)', () => {
  beforeEach(() => {
    localStorage.clear();
    emptyTrash();
    vi.restoreAllMocks();
    // Keep currentDocumentId off the doc under test so deleting it doesn't
    // trigger newDocument() (which would spin up the page store).
    usePersistenceStore.setState({ currentDocumentId: 'other', documents: {} });
  });

  it('deleteDocument soft-deletes to the Trash without releasing blobs', () => {
    const dec = vi.spyOn(blobStorage, 'decrementUsageCount').mockResolvedValue(undefined);
    const doc = makeDoc('d1');
    saveDocumentToStorage(doc);
    usePersistenceStore.setState((s) => ({ documents: { ...s.documents, d1: getDocumentMetadata(doc) } }));

    usePersistenceStore.getState().deleteDocument('d1');

    expect(isInTrash('d1')).toBe(true);
    expect(getTrashItem('d1')?.kind).toBe('local');
    expect(usePersistenceStore.getState().documents.d1).toBeUndefined();
    expect(dec).not.toHaveBeenCalled();
  });

  it('permanentlyDeleteDocument hard-removes and releases blobs', () => {
    const dec = vi.spyOn(blobStorage, 'decrementUsageCount').mockResolvedValue(undefined);
    const doc = makeDoc('d2');
    saveDocumentToStorage(doc);
    usePersistenceStore.setState((s) => ({ documents: { ...s.documents, d2: getDocumentMetadata(doc) } }));

    usePersistenceStore.getState().permanentlyDeleteDocument('d2');

    expect(isInTrash('d2')).toBe(false);
    expect(usePersistenceStore.getState().documents.d2).toBeUndefined();
    expect(dec).toHaveBeenCalledWith('b1');
  });
});
