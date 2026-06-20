/**
 * removeCurrentWorkspace (JP-237): the hard purge. Verifies it tears down the
 * session and deletes the host's registry entries, durable offline copies, local
 * CRDT rooms, and the persisted connection — all scoped to the current host.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const {
  stopSession,
  clearRemoteDocuments,
  clearForHost,
  purgeLocalDocRoom,
  clearConnection,
  getCachedIdsForHost,
} = vi.hoisted(() => ({
  stopSession: vi.fn(),
  clearRemoteDocuments: vi.fn(),
  clearForHost: vi.fn(async () => {}),
  purgeLocalDocRoom: vi.fn(async () => {}),
  clearConnection: vi.fn(async () => {}),
  getCachedIdsForHost: vi.fn(() => ['doc-1', 'doc-2']),
}));

vi.mock('../store/connectionStore', () => ({
  useConnectionStore: { getState: () => ({ host: { address: 'relay-a:9876' } }) },
}));
vi.mock('../collaboration/collaborationStore', () => ({
  useCollaborationStore: { getState: () => ({ stopSession }) },
}));
vi.mock('../store/documentRegistry', () => ({
  useDocumentRegistry: { getState: () => ({ clearRemoteDocuments }) },
}));
vi.mock('../storage/RelayDocumentCache', () => ({
  RelayDocumentCache: { getCachedIdsForHost, clearForHost },
}));
vi.mock('../collaboration/ensureCollabSession', () => ({ purgeLocalDocRoom }));
vi.mock('../api/relayConnection', () => ({ clearConnection }));

import { removeCurrentWorkspace } from './removeWorkspace';

describe('removeCurrentWorkspace', () => {
  beforeEach(() => {
    [stopSession, clearRemoteDocuments, clearForHost, purgeLocalDocRoom, clearConnection].forEach(
      (m) => m.mockClear(),
    );
    getCachedIdsForHost.mockClear();
  });

  it('purges the host everywhere and forgets the connection', async () => {
    await removeCurrentWorkspace();

    expect(stopSession).toHaveBeenCalledTimes(1);
    expect(clearRemoteDocuments).toHaveBeenCalledWith('relay-a:9876');
    expect(clearForHost).toHaveBeenCalledWith('relay-a:9876');
    // One CRDT-room purge per cached doc.
    expect(purgeLocalDocRoom).toHaveBeenCalledWith('doc-1');
    expect(purgeLocalDocRoom).toHaveBeenCalledWith('doc-2');
    expect(clearConnection).toHaveBeenCalledTimes(1);
  });
});
