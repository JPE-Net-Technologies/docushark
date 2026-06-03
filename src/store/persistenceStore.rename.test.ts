/**
 * CRDT-native rename: `applyRemoteDocumentName` applies a name received over the
 * collaboration channel (Y.Doc metadata) to local state, without writing back
 * to the relay/CRDT (which would loop).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const cacheMock = vi.hoisted(() => ({
  put: vi.fn(async () => {}),
  getMeta: vi.fn(() => null),
}));
vi.mock('../storage/RelayDocumentCache', () => ({ RelayDocumentCache: cacheMock }));

const syncManagerMock = vi.hoisted(() => ({
  queueSave: vi.fn(() => ({ id: 'op-1' })),
  hasPendingChanges: vi.fn(() => false),
  processQueueForHost: vi.fn(async () => []),
}));
vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => syncManagerMock,
}));

import { applyRemoteDocumentName, usePersistenceStore } from './persistenceStore';
import { useDocumentRegistry } from './documentRegistry';
import type { DocumentMetadata } from '../types/Document';

function meta(id: string, name: string): DocumentMetadata {
  return { id, name, createdAt: 1, modifiedAt: 1 } as DocumentMetadata;
}

describe('applyRemoteDocumentName', () => {
  beforeEach(() => {
    usePersistenceStore.setState({
      currentDocumentId: 'doc-1',
      currentDocumentName: 'Old Name',
      documents: { 'doc-1': meta('doc-1', 'Old Name') },
    } as never);
    vi.restoreAllMocks();
  });

  it('updates the active doc name, the index, and the registry', () => {
    const updateSpy = vi
      .spyOn(useDocumentRegistry.getState(), 'updateRecord')
      .mockImplementation(() => {});

    applyRemoteDocumentName('doc-1', 'New Name');

    const s = usePersistenceStore.getState();
    expect(s.currentDocumentName).toBe('New Name');
    expect(s.documents['doc-1']?.name).toBe('New Name');
    expect(updateSpy).toHaveBeenCalledWith('doc-1', { name: 'New Name' });
  });

  it('updates a non-active doc without touching the active display name', () => {
    vi.spyOn(useDocumentRegistry.getState(), 'updateRecord').mockImplementation(() => {});
    usePersistenceStore.setState((s) => ({
      documents: { ...s.documents, 'doc-2': meta('doc-2', 'Two') },
    }));

    applyRemoteDocumentName('doc-2', 'Two Renamed');

    const s = usePersistenceStore.getState();
    expect(s.currentDocumentName).toBe('Old Name');
    expect(s.documents['doc-2']?.name).toBe('Two Renamed');
  });

  it('is a no-op for an unchanged name or an empty name', () => {
    const updateSpy = vi
      .spyOn(useDocumentRegistry.getState(), 'updateRecord')
      .mockImplementation(() => {});

    applyRemoteDocumentName('doc-1', 'Old Name'); // unchanged
    applyRemoteDocumentName('doc-1', ''); // empty — ignored

    expect(updateSpy).not.toHaveBeenCalled();
    expect(usePersistenceStore.getState().currentDocumentName).toBe('Old Name');
  });
});
