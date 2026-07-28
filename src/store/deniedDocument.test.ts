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

const h = vi.hoisted(() => ({
  hasPendingChanges: vi.fn(() => false),
  cacheRemove: vi.fn(async () => {}),
  removeDocument: vi.fn(),
  notifyError: vi.fn(),
  getDocument: vi.fn(),
  registerRemote: vi.fn(),
}));

vi.mock('../storage/RelayDocumentCache', () => ({
  RelayDocumentCache: {
    get: vi.fn(async () => null),
    put: vi.fn(async () => {}),
    remove: h.cacheRemove,
    has: vi.fn(() => false),
    getCachedIds: vi.fn(() => [] as string[]),
    getCachedIdsForHost: vi.fn(() => [] as string[]),
  },
}));
vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => ({ hasPendingChanges: h.hasPendingChanges }),
}));
vi.mock('./documentRegistry', () => ({
  useDocumentRegistry: Object.assign(
    (sel: (s: unknown) => unknown) => sel({ removeDocument: h.removeDocument }),
    {
      getState: () => ({
        removeDocument: h.removeDocument,
        setDocumentLoading: vi.fn(),
        setDocumentContent: vi.fn(),
        getDocumentContent: () => null,
        registerRemote: h.registerRemote,
      }),
    },
  ),
}));
vi.mock('./notificationStore', () => ({
  useNotificationStore: {
    getState: () => ({ error: h.notifyError, success: vi.fn(), info: vi.fn() }),
  },
}));

import { RelayError } from '../api/relayClient';
import {
  useRelayDocumentStore,
  RelayDocumentAccessRevokedError,
} from './relayDocumentStore';

const DOC = 'doc-revoked';

function forbidden(): RelayError {
  return new RelayError(403, `/api/docs/${DOC}`, 'ERR_VIEW_FORBIDDEN');
}

beforeEach(() => {
  vi.clearAllMocks();
  h.hasPendingChanges.mockReturnValue(false);
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

  it('KEEPS the offline copy when there are pending edits', async () => {
    // The load-bearing case. A revoked share must not delete work the user has
    // written but not yet synced.
    h.hasPendingChanges.mockReturnValue(true);
    await useRelayDocumentStore.getState().loadRelayDocument(DOC).catch(() => {});

    expect(h.cacheRemove).not.toHaveBeenCalled();
    expect(h.notifyError).toHaveBeenCalledWith(expect.stringContaining('unsaved changes'));
  });
});
