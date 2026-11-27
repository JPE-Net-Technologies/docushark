/**
 * Denied documents leave the browser — but never take unsynced work with them
 * (JP-459).
 *
 * Observed live: a document the relay refuses stayed in the list rendered as
 * "offline / idle". That is wrong twice over — it can never load, so it isn't
 * offline, and its title is on screen for someone with no access to it.
 *
 * The dangerous half of the fix is the cache purge. A share can be revoked while
 * the holder is offline with edits still queued, and a blind purge would delete
 * them silently. Losing access to the server's copy is not permission to destroy
 * the user's own writing, so the purge is gated on there being nothing pending.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const h = vi.hoisted(() => ({
  hasPendingChanges: vi.fn(() => false),
  discardPending: vi.fn(),
  cacheGet: vi.fn(async (): Promise<unknown> => null),
  cacheRemove: vi.fn(async () => {}),
  removeDocument: vi.fn(),
  notifyError: vi.fn(),
  notifyInfo: vi.fn(),
  trashStranded: vi.fn(),
  isLocalDocument: vi.fn(() => false),
  getDocument: vi.fn(),
  registerRemote: vi.fn(),
}));

vi.mock('../storage/RelayDocumentCache', () => ({
  RelayDocumentCache: {
    get: h.cacheGet,
    put: vi.fn(async () => {}),
    remove: h.cacheRemove,
    has: vi.fn(() => false),
    getCachedIds: vi.fn(() => [] as string[]),
    getCachedIdsForHost: vi.fn(() => [] as string[]),
  },
}));
vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => ({ hasPendingChanges: h.hasPendingChanges, discardPending: h.discardPending }),
}));
vi.mock('./trashStore', () => ({
  useTrashStore: { getState: () => ({ trashStranded: h.trashStranded }) },
}));
vi.mock('./documentRegistry', () => ({
  useDocumentRegistry: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ removeDocument: h.removeDocument }),
    {
      getState: () => ({
        removeDocument: h.removeDocument,
        setDocumentLoading: vi.fn(),
        setDocumentContent: vi.fn(),
        setSyncState: vi.fn(),
        getDocumentContent: () => null,
        isLocalDocument: h.isLocalDocument,
        registerRemote: h.registerRemote,
      }),
    },
  ),
}));
vi.mock('./notificationStore', () => ({
  useNotificationStore: {
    getState: () => ({ error: h.notifyError, success: vi.fn(), info: h.notifyInfo }),
  },
}));

import { RelayError } from '../api/relayClient';
import {
  useRelayDocumentStore,
  RelayDocumentAccessRevokedError,
  handleReplayFailure,
} from './relayDocumentStore';
import { usePersistenceStore } from './persistenceStore';

const DOC = 'doc-revoked';

function forbidden(): RelayError {
  return new RelayError(403, `/api/docs/${DOC}`, 'ERR_VIEW_FORBIDDEN');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.hasPendingChanges.mockReturnValue(false);
  h.cacheGet.mockResolvedValue(null);
  h.isLocalDocument.mockReturnValue(false);
  // A provider that refuses this document, and an online-looking connection so
  // the load actually attempts the network rather than short-circuiting.
  useRelayDocumentStore.setState({
    documentCache: {},
    relayDocuments: {},
    loadingDocs: new Set(),
  });
  useRelayDocumentStore.getState().setProvider({
    listDocuments: vi.fn(async () => []),
    getDocument: h.getDocument,
    saveDocument: vi.fn(),
    deleteDocument: vi.fn(),
  } as never);
  h.getDocument.mockRejectedValue(forbidden());
});

describe('a 403 on open', () => {
  it('reports revoked access rather than a generic failure', async () => {
    await expect(useRelayDocumentStore.getState().loadRelayDocument(DOC)).rejects.toBeInstanceOf(
      RelayDocumentAccessRevokedError,
    );
  });

  it('removes the document from the registry so it stops being listed', async () => {
    await useRelayDocumentStore.getState().loadRelayDocument(DOC).catch(() => {});
    expect(h.removeDocument).toHaveBeenCalledWith(DOC);
  });

  it('purges the offline copy when there is nothing unsynced', async () => {
    await useRelayDocumentStore.getState().loadRelayDocument(DOC).catch(() => {});
    expect(h.cacheRemove).toHaveBeenCalled();
  });

  it('moves unsynced work to Trash as a recoverable copy, then drops its doomed saves (DSK-13)', async () => {
    // The load-bearing case. A revoked share must not delete work the user has
    // written but not yet synced, and the work must stay reachable: Trash
    // restores it as a personal copy. The copy comes from the offline cache,
    // which holds the full body; the queued saves are refused on every replay.
    const cached = { id: DOC, name: 'Field notes', pages: {}, pageOrder: [], modifiedAt: 100 };
    h.hasPendingChanges.mockReturnValue(true);
    h.cacheGet.mockResolvedValue(cached);
    // The server's copy is newer than the cached one (a collaborator edited
    // before revoking), so the open goes to the network and meets the 403.
    useRelayDocumentStore.setState({ relayDocuments: { [DOC]: { modifiedAt: 200 } as never } });
    await useRelayDocumentStore.getState().loadRelayDocument(DOC).catch(() => {});

    expect(h.trashStranded).toHaveBeenCalledWith(cached, expect.objectContaining({ relayId: expect.any(String) }));
    expect(h.discardPending).toHaveBeenCalledWith(DOC);
    expect(h.cacheRemove).toHaveBeenCalled();
    expect(h.notifyInfo).toHaveBeenCalledWith(expect.stringContaining('Trash'));
    expect(h.notifyError).not.toHaveBeenCalled();
  });

  it('KEEPS the offline copy when there are pending edits but no readable copy', async () => {
    // With nothing to put in Trash, the cached bytes are the only copy: keep
    // them and keep the queued saves.
    h.hasPendingChanges.mockReturnValue(true);
    await useRelayDocumentStore.getState().loadRelayDocument(DOC).catch(() => {});

    expect(h.trashStranded).not.toHaveBeenCalled();
    expect(h.discardPending).not.toHaveBeenCalled();
    expect(h.cacheRemove).not.toHaveBeenCalled();
    expect(h.notifyError).toHaveBeenCalledWith(expect.stringContaining('unsaved changes'));
  });
});

describe('a refused replay of a queued save (DSK-13)', () => {
  // The common way to meet a revocation with unsynced work: the offline copy is
  // fresher than anything the server lists, so opening it never sees the 403.
  // The queued save's replay does, and would be refused forever.
  beforeEach(() => {
    h.cacheGet.mockResolvedValue({ id: DOC, name: 'Field notes', pages: {}, pageOrder: [], modifiedAt: 100 });
    usePersistenceStore.setState({ currentDocumentId: null });
  });

  it('moves the work to Trash and drops its queued saves', async () => {
    await handleReplayFailure(DOC, forbidden());
    expect(h.trashStranded).toHaveBeenCalledWith(
      expect.objectContaining({ id: DOC, name: 'Field notes' }),
      expect.objectContaining({ relayId: expect.any(String) }),
    );
    expect(h.discardPending).toHaveBeenCalledWith(DOC);
    expect(h.notifyInfo).toHaveBeenCalledWith(expect.stringContaining('Trash'));
  });

  it('leaves the open document to the collaboration layer', async () => {
    usePersistenceStore.setState({ currentDocumentId: DOC });
    await handleReplayFailure(DOC, forbidden());
    expect(h.trashStranded).not.toHaveBeenCalled();
    expect(h.discardPending).not.toHaveBeenCalled();
  });

  it('leaves any other failure to the queue’s retries', async () => {
    await handleReplayFailure(DOC, new RelayError(500, `/api/docs/${DOC}`, 'ERR_INTERNAL'));
    await handleReplayFailure(DOC, new Error('Network down'));
    expect(h.trashStranded).not.toHaveBeenCalled();
    expect(h.discardPending).not.toHaveBeenCalled();
  });

  it('never moves a document the registry holds as local, but drops its stale saves', async () => {
    // The open copy of a revoked document is demoted to a local document under
    // the same id. Its old workspace saves can only be refused; the document
    // itself is the user's own and must stay where it is.
    h.isLocalDocument.mockReturnValue(true);
    await handleReplayFailure(DOC, forbidden());
    expect(h.trashStranded).not.toHaveBeenCalled();
    expect(h.removeDocument).not.toHaveBeenCalled();
    expect(h.discardPending).toHaveBeenCalledWith(DOC);
  });

  it('is wired into the offline queue’s provider in App.tsx', () => {
    // The REST push stays in App.tsx (JP-423's write boundary), so the wiring
    // lives there too: the provider's save must hand its failures over.
    const app = readFileSync(resolve(__dirname, '../ui/App.tsx'), 'utf-8');
    const provider = app.slice(app.indexOf('syncManager.setProvider({'), app.indexOf('syncManager.initialize()'));
    expect(provider).toContain('saveToHost(');
    expect(provider).toContain('handleReplayFailure(doc.id, e)');
  });
});
