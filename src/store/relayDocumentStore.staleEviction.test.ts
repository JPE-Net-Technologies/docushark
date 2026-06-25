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
  // JP-370: the sweep is now WORKSPACE-scoped — `getCachedIds(workspaceId)`
  // returns only the active workspace's cached docs (was host-scoped).
  getCachedIds: vi.fn<[string], string[]>(() => []),
  getMeta: vi.fn<[string, string], { cachedAt: number; relayId: string } | null>(() => null),
  remove: vi.fn<[string, string], Promise<void>>(async () => {}),
  // The strand path reads the cached bytes before removing. Default: no bytes
  // (nothing to preserve → the entry is just cleaned up).
  get: vi.fn<[string, string], Promise<unknown>>(async () => null),
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

describe('refreshStaleCachedDocuments — workspace-scoped eviction', () => {
  beforeEach(() => {
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
    // No token on the connection → activeWorkspaceId() resolves to 'default'.
    useConnectionStore.setState({
      host: { address: 'localhost:9876', url: 'http://localhost:9876' },
      token: null,
    });
  });

  it('reconciles cached docs that this workspace no longer has (strand + clean up)', async () => {
    cacheMock.getCachedIds.mockReturnValue(['ghost-A', 'ghost-B']);
    // Server returned an empty doc list — both cache entries are orphans.

    await useRelayDocumentStore.getState().refreshStaleCachedDocuments();

    expect(cacheMock.getCachedIds).toHaveBeenCalledWith('default');
    // Removal happens after the strand path reads the bytes (async), so wait
    // for the deferred cleanup to land.
    await vi.waitFor(() => {
      expect(cacheMock.remove).toHaveBeenCalledWith('default', 'ghost-A');
      expect(cacheMock.remove).toHaveBeenCalledWith('default', 'ghost-B');
    });
  });

  it('leaves docs the server still has alone', async () => {
    cacheMock.getCachedIds.mockReturnValue(['present']);
    cacheMock.getMeta.mockReturnValue({ cachedAt: 200, relayId: 'localhost:9876' });
    useRelayDocumentStore.setState({
      relayDocuments: { present: makeMeta('present', 50) }, // modifiedAt < cachedAt → fresh
    });

    await useRelayDocumentStore.getState().refreshStaleCachedDocuments();

    expect(cacheMock.remove).not.toHaveBeenCalled();
  });

  it('never touches entries from other workspaces', async () => {
    // getCachedIds is workspace-scoped: a doc cached under a different
    // workspace simply isn't returned for the active one, so it's safe.
    cacheMock.getCachedIds.mockReturnValue([]);

    await useRelayDocumentStore.getState().refreshStaleCachedDocuments();

    expect(cacheMock.remove).not.toHaveBeenCalled();
  });

  it('preserves an orphan that still has unsynced offline edits queued (JP-106)', async () => {
    // Server no longer lists this doc, but it has edits waiting in the
    // sync queue — evicting it would destroy unsynced work before replay.
    cacheMock.getCachedIds.mockReturnValue(['orphan-with-edits']);
    syncManagerMock.hasPendingChanges.mockImplementation(
      (id) => id === 'orphan-with-edits',
    );

    await useRelayDocumentStore.getState().refreshStaleCachedDocuments();

    expect(syncManagerMock.hasPendingChanges).toHaveBeenCalledWith('orphan-with-edits');
    expect(cacheMock.remove).not.toHaveBeenCalled();
  });

  it('clears any in-memory shadow of the stranded doc', async () => {
    cacheMock.getCachedIds.mockReturnValue(['orphan']);
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
