/**
 * removeCurrentWorkspace (JP-237): the hard purge. Verifies it tears down the
 * session and deletes the host's registry entries, durable offline copies, local
 * CRDT rooms, and the persisted connection — all scoped to the current host.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  stopSession,
  clearRemoteDocuments,
  clearForWorkspace,
  purgeLocalDocRoom,
  clearConnection,
  getCachedIds,
} = vi.hoisted(() => ({
  stopSession: vi.fn(),
  clearRemoteDocuments: vi.fn(),
  clearForWorkspace: vi.fn(async () => {}),
  purgeLocalDocRoom: vi.fn(async () => {}),
  clearConnection: vi.fn(async () => {}),
  getCachedIds: vi.fn(() => ['doc-1', 'doc-2']),
}));

// No token on the mocked connection → activeWorkspaceId() resolves to the
// single-tenant fallback 'default' (JP-370).
vi.mock('../store/connectionStore', () => ({
  useConnectionStore: { getState: () => ({ host: { address: 'relay-a:9876' }, token: null }) },
}));
vi.mock('../collaboration/collaborationStore', () => ({
  useCollaborationStore: { getState: () => ({ stopSession }) },
}));
vi.mock('../store/documentRegistry', () => ({
  useDocumentRegistry: { getState: () => ({ clearRemoteDocuments }) },
}));
vi.mock('../storage/RelayDocumentCache', () => ({
  RelayDocumentCache: { getCachedIds, clearForWorkspace },
}));
vi.mock('../collaboration/ensureCollabSession', () => ({ purgeLocalDocRoom }));
vi.mock('../api/relayConnection', () => ({ clearConnection }));

import { removeCurrentWorkspace } from './removeWorkspace';

describe('removeCurrentWorkspace', () => {
  beforeEach(() => {
    [stopSession, clearRemoteDocuments, clearForWorkspace, purgeLocalDocRoom, clearConnection].forEach(
      (m) => m.mockClear(),
    );
    getCachedIds.mockClear();
  });

  it('purges the workspace everywhere and forgets the connection', async () => {
    await removeCurrentWorkspace();

    expect(stopSession).toHaveBeenCalledTimes(1);
    // Registry clear is still scoped by relay host.
    expect(clearRemoteDocuments).toHaveBeenCalledWith('relay-a:9876');
    // JP-370: the durable cache is purged by WORKSPACE (here the 'default'
    // single-tenant fallback, since the mocked connection carries no token).
    expect(getCachedIds).toHaveBeenCalledWith('default');
    expect(clearForWorkspace).toHaveBeenCalledWith('default');
    // One CRDT-room purge per cached doc.
    expect(purgeLocalDocRoom).toHaveBeenCalledWith('doc-1');
    expect(purgeLocalDocRoom).toHaveBeenCalledWith('doc-2');
    expect(clearConnection).toHaveBeenCalledTimes(1);
  });
});
