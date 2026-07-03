/**
 * JP-423 — pending-sync marker lifecycle at doc-level transitions.
 *
 * Markers protect offline-created pages until the relay handoff completes
 * (JP-335). When the doc itself goes away for good — hard delete, relay
 * delete, transfer to personal — its markers must clear so they don't sit in
 * localStorage forever. Soft delete (trash) deliberately KEEPS them: a
 * restored doc may still owe the relay its pages.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cacheMock = vi.hoisted(() => ({
  get: vi.fn(async () => null as unknown),
  put: vi.fn(async () => {}),
  getCachedIdsForHost: vi.fn(() => [] as string[]),
  getMeta: vi.fn(() => null),
  remove: vi.fn(async () => {}),
}));

vi.mock('../storage/RelayDocumentCache', () => ({ RelayDocumentCache: cacheMock }));
vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => ({ hasPendingChanges: () => false }),
}));

import { usePersistenceStore, saveDocumentToStorage } from './persistenceStore';
import { useRelayDocumentStore, type DocumentProvider } from './relayDocumentStore';
import { usePendingSyncPages } from './pendingSyncPages';
import { emptyTrash, isInTrash } from '../storage/TrashStorage';
import { blobStorage } from '../storage/BlobStorage';
import { getDocumentMetadata, type DiagramDocument } from '../types/Document';

function makeDoc(id: string, relay = false): DiagramDocument {
  const doc: DiagramDocument = {
    id,
    name: id,
    pages: {},
    pageOrder: ['p1'],
    activePageId: 'p1',
    createdAt: 0,
    modifiedAt: 0,
    version: 1,
    blobReferences: [],
  };
  if (relay) {
    doc.isRelayDocument = true;
    doc.ownerId = 'u1';
  }
  return doc;
}

function seedMarkers(): void {
  usePendingSyncPages.setState({ pending: {} });
  const mark = usePendingSyncPages.getState().markPending;
  mark('page-a1', 'doc-a');
  mark('page-a2', 'doc-a');
  mark('page-b1', 'doc-b');
}

function pendingIds(): string[] {
  return Object.keys(usePendingSyncPages.getState().pending).sort();
}

describe('pendingSyncPages.clearDoc wiring (JP-423)', () => {
  beforeEach(() => {
    localStorage.clear();
    emptyTrash();
    vi.restoreAllMocks();
    vi.spyOn(blobStorage, 'decrementUsageCount').mockResolvedValue(undefined);
    usePersistenceStore.setState({ currentDocumentId: 'other', documents: {} });
    useRelayDocumentStore.getState().setProvider(null);
    seedMarkers();
  });

  it('permanentlyDeleteDocument clears only the deleted doc\'s markers', () => {
    const doc = makeDoc('doc-a');
    saveDocumentToStorage(doc);
    usePersistenceStore.setState((s) => ({
      documents: { ...s.documents, 'doc-a': getDocumentMetadata(doc) },
    }));

    usePersistenceStore.getState().permanentlyDeleteDocument('doc-a');

    expect(pendingIds()).toEqual(['page-b1']);
  });

  it('soft delete (trash) keeps markers — the doc is restorable', () => {
    const doc = makeDoc('doc-a');
    saveDocumentToStorage(doc);
    usePersistenceStore.setState((s) => ({
      documents: { ...s.documents, 'doc-a': getDocumentMetadata(doc) },
    }));

    usePersistenceStore.getState().deleteDocument('doc-a');

    expect(isInTrash('doc-a')).toBe(true);
    expect(pendingIds()).toEqual(['page-a1', 'page-a2', 'page-b1']);
  });

  it('transferToPersonal clears the doc\'s markers', () => {
    const doc = makeDoc('doc-a', true);
    saveDocumentToStorage(doc);
    usePersistenceStore.setState((s) => ({
      documents: { ...s.documents, 'doc-a': getDocumentMetadata(doc) },
    }));

    const ok = usePersistenceStore.getState().transferToPersonal('doc-a');

    expect(ok).toBe(true);
    expect(pendingIds()).toEqual(['page-b1']);
  });

  it('deleteFromHost clears markers on a successful relay delete', async () => {
    const provider = {
      deleteDocument: vi.fn(async () => {}),
    } as unknown as DocumentProvider;
    useRelayDocumentStore.getState().setProvider(provider);

    await useRelayDocumentStore.getState().deleteFromHost('doc-a');

    expect(pendingIds()).toEqual(['page-b1']);
  });

  it('deleteFromHost keeps markers when the relay delete fails', async () => {
    const provider = {
      deleteDocument: vi.fn(async () => {
        throw new Error('relay unreachable');
      }),
    } as unknown as DocumentProvider;
    useRelayDocumentStore.getState().setProvider(provider);

    await expect(useRelayDocumentStore.getState().deleteFromHost('doc-a')).rejects.toThrow(
      'relay unreachable',
    );

    expect(pendingIds()).toEqual(['page-a1', 'page-a2', 'page-b1']);
  });
});
