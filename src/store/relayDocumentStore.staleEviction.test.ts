/**
 * Coverage for `refreshStaleCachedDocuments`'s reconciliation behavior.
 *
 * The cache is host-scoped: every entry remembers which relay it came
 * from. The staleness sweep must only look at entries from the
 * currently-connected relay, and entries that are no longer on that
 * relay are reconciled via the JP-175 strand path — the local copy is
 * preserved in Trash (or demoted if open) and the cache entry removed —
 * rather than being silently dropped on reconnect.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// `vi.mock` is hoisted above all imports, so the mock object has to be
// declared via `vi.hoisted` to be referenceable from inside the factory.
const cacheMock = vi.hoisted(() => ({
  getCachedIdsForHost: vi.fn<[string], string[]>(() => []),
  getCachedIds: vi.fn<[], string[]>(() => []),
  getMeta: vi.fn<[string], { cachedAt: number; relayId: string } | null>(() => null),
  remove: vi.fn<[string], Promise<void>>(async () => {}),
  // The strand path reads the cached bytes before removing. Default: no bytes
  // (nothing to preserve → the entry is just cleaned up).
  get: vi.fn<[string], Promise<unknown>>(async () => null),
}));

vi.mock('../storage/RelayDocumentCache', () => ({
  RelayDocumentCache: cacheMock,
}));

const syncManagerMock = vi.hoisted(() => ({
  hasPendingChanges: vi.fn<[string], boolean>(() => false),
}));

vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => syncManagerMock,
}));

import { useRelayDocumentStore } from './relayDocumentStore';
import { useConnectionStore } from './connectionStore';
import type { DocumentProvider } from './relayDocumentStore';
import type { DocumentMetadata } from '../types/Document';

function makeMeta(id: string, modifiedAt = 100): DocumentMetadata {
  return {
    id,
    name: id,
    pageCount: 1,
    ownerId: 'admin-1',
    ownerName: 'admin',
    createdAt: 1,
    modifiedAt,
    isRelayDocument: true,
  };
}

const noopProvider: DocumentProvider = {
  listDocuments: async () => [],
  getDocument: async () => {
    throw new Error('not used');
  },
  saveDocument: async () => ({ newVersion: 1 }),
  deleteDocument: async () => {},
};

describe('refreshStaleCachedDocuments — host-scoped eviction', () => {
  beforeEach(() => {
    cacheMock.getCachedIdsForHost.mockReset();
    cacheMock.getCachedIds.mockReset();
    cacheMock.getMeta.mockReset();
    cacheMock.remove.mockReset();
    cacheMock.remove.mockResolvedValue(undefined);
    cacheMock.get.mockReset();
    cacheMock.get.mockResolvedValue(null);
    syncManagerMock.hasPendingChanges.mockReset();
    syncManagerMock.hasPendingChanges.mockReturnValue(false);

    useRelayDocumentStore.getState().setProvider(noopProvider);
    useRelayDocumentStore.setState({ relayDocuments: {}, documentCache: {} });
    useConnectionStore.setState({
      host: { address: 'localhost:9876', url: 'http://localhost:9876' },
    });
  });

  it('reconciles cached docs that this host no longer has (strand + clean up)', async () => {
    cacheMock.getCachedIdsForHost.mockReturnValue(['ghost-A', 'ghost-B']);
    // Server returned an empty doc list — both cache entries are orphans.

    await useRelayDocumentStore.getState().refreshStaleCachedDocuments();

    expect(cacheMock.getCachedIdsForHost).toHaveBeenCalledWith('localhost:9876');
    // Removal happens after the strand path reads the bytes (async), so wait
    // for the deferred cleanup to land.
    await vi.waitFor(() => {
      expect(cacheMock.remove).toHaveBeenCalledWith('ghost-A');
      expect(cacheMock.remove).toHaveBeenCalledWith('ghost-B');
    });
  });

  it('leaves docs the server still has alone', async () => {
    cacheMock.getCachedIdsForHost.mockReturnValue(['present']);
    cacheMock.getMeta.mockReturnValue({ cachedAt: 200, relayId: 'localhost:9876' });
    useRelayDocumentStore.setState({
      relayDocuments: { present: makeMeta('present', 50) }, // modifiedAt < cachedAt → fresh
    });

    await useRelayDocumentStore.getState().refreshStaleCachedDocuments();

    expect(cacheMock.remove).not.toHaveBeenCalled();
  });

  it('never touches entries from other hosts', async () => {
    // The unscoped getCachedIds would have returned both — host scoping
    // is what keeps cross-relay cached docs safe.
    cacheMock.getCachedIdsForHost.mockReturnValue([]);
    cacheMock.getCachedIds.mockReturnValue(['from-other-host']);

    await useRelayDocumentStore.getState().refreshStaleCachedDocuments();

    expect(cacheMock.remove).not.toHaveBeenCalled();
    expect(cacheMock.getCachedIds).not.toHaveBeenCalled();
  });

  it('preserves an orphan that still has unsynced offline edits queued (JP-106)', async () => {
    // Server no longer lists this doc, but it has edits waiting in the
    // sync queue — evicting it would destroy unsynced work before replay.
    cacheMock.getCachedIdsForHost.mockReturnValue(['orphan-with-edits']);
    syncManagerMock.hasPendingChanges.mockImplementation(
      (id) => id === 'orphan-with-edits',
    );

    await useRelayDocumentStore.getState().refreshStaleCachedDocuments();

    expect(syncManagerMock.hasPendingChanges).toHaveBeenCalledWith('orphan-with-edits');
    expect(cacheMock.remove).not.toHaveBeenCalled();
  });

  it('clears any in-memory shadow of the stranded doc', async () => {
    cacheMock.getCachedIdsForHost.mockReturnValue(['orphan']);
    useRelayDocumentStore.setState({
      documentCache: {
        orphan: {
          id: 'orphan',
          name: 'orphan',
          pages: {},
          pageOrder: ['p1'],
          activePageId: 'p1',
          createdAt: 0,
          modifiedAt: 0,
          version: 1,
        } as never,
      },
    });

    await useRelayDocumentStore.getState().refreshStaleCachedDocuments();

    expect(useRelayDocumentStore.getState().documentCache).not.toHaveProperty('orphan');
  });
});
