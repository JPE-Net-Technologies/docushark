/**
 * JP-395 — `handleRelayJoinError` must NOT treat a transient `ERR_UNKNOWN_DOC`
 * as a deletion. The relay emits `ERR_UNKNOWN_DOC` whenever its in-memory index
 * misses (a cold/un-hydrated index, or a JWKS cold-start auth blip after a
 * redeploy) — which fake-deleted live docs (trash + cache evict + "deleted"
 * toast). A genuine deletion arrives as `ERR_DELETED` (JP-375) and must still
 * strand. This drives the extracted handler directly (the UnifiedSyncProvider
 * mock discards the inline `onError`, so it's otherwise unreachable).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Heavy collab deps — mock so importing collaborationStore stays lightweight
// (mirrors collaborationStore.test.ts).
vi.mock('./YjsDocument', () => ({
  YjsDocument: vi.fn().mockImplementation(() => ({
    getDoc: vi.fn(),
    destroy: vi.fn(),
    onUndoStackChange: vi.fn(() => vi.fn()),
    clearUndoHistory: vi.fn(),
  })),
}));
vi.mock('./UnifiedSyncProvider', () => ({
  UnifiedSyncProvider: vi.fn().mockImplementation(() => ({})),
}));

const hoisted = vi.hoisted(() => ({
  strandOrDemoteDeletedDoc: vi.fn(),
  getRecord: vi.fn(),
  setSyncState: vi.fn(),
  warning: vi.fn(),
  host: { address: 'home-relay:443' } as { address: string } | null,
}));

vi.mock('../store/relayDocumentStore', () => ({
  useRelayDocumentStore: {
    getState: () => ({ strandOrDemoteDeletedDoc: hoisted.strandOrDemoteDeletedDoc }),
  },
}));
vi.mock('../store/documentRegistry', () => ({
  useDocumentRegistry: {
    getState: () => ({ getRecord: hoisted.getRecord, setSyncState: hoisted.setSyncState }),
  },
}));
vi.mock('../store/connectionStore', () => ({
  useConnectionStore: {
    getState: () => ({ host: hoisted.host }),
    subscribe: () => () => {},
  },
  // collaborationStore imports several named exports from this module at load.
  isRelayAuthenticated: vi.fn(() => false),
  startTokenExpirationMonitor: vi.fn(),
  stopTokenExpirationMonitor: vi.fn(),
  muteConnectionToasts: vi.fn(),
  markReconnectCancelled: vi.fn(),
  clearReconnectTerminal: vi.fn(),
}));
vi.mock('../store/presenceStore', () => ({ usePresenceStore: { getState: () => ({}) } }));
vi.mock('../store/notificationStore', () => ({
  useNotificationStore: { getState: () => ({ warning: hoisted.warning }) },
}));

import { handleRelayJoinError } from './collaborationStore';

const HOME = 'home-relay:443';
const DOC = 'doc-1';
const base = { id: DOC, name: 'Doc', pageCount: 1, createdAt: 0, modifiedAt: 0 };
const remote = (relayId = HOME) => ({
  ...base,
  type: 'remote' as const,
  relayId,
  workspaceId: 'ws-1',
  ownerId: 'u1',
  ownerName: 'U',
  permission: 'owner' as const,
  syncState: 'synced' as const,
  lastSyncedAt: 0,
});
const cached = (relayId = HOME) => ({
  ...base,
  type: 'cached' as const,
  relayId,
  workspaceId: 'ws-1',
  originalDocId: DOC,
  cachedAt: 0,
  pendingChanges: 0,
  permission: 'editor' as const,
});
const localDoc = { ...base, type: 'local' as const };

beforeEach(() => {
  hoisted.strandOrDemoteDeletedDoc.mockClear();
  hoisted.getRecord.mockReset();
  hoisted.setSyncState.mockClear();
  hoisted.warning.mockClear();
  hoisted.host = { address: HOME };
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('handleRelayJoinError — JP-395', () => {
  it('does NOT strand a CACHED doc on ERR_UNKNOWN_DOC (the fake-deletion bug)', () => {
    hoisted.getRecord.mockReturnValue(cached());
    handleRelayJoinError('ERR_UNKNOWN_DOC', DOC);

    expect(hoisted.strandOrDemoteDeletedDoc).not.toHaveBeenCalled();
    expect(hoisted.setSyncState).toHaveBeenCalledWith(DOC, 'error');
    expect(hoisted.warning).not.toHaveBeenCalled(); // transient → no alarming toast
  });

  it('does NOT strand a REMOTE doc on ERR_UNKNOWN_DOC', () => {
    hoisted.getRecord.mockReturnValue(remote());
    handleRelayJoinError('ERR_UNKNOWN_DOC', DOC);

    expect(hoisted.strandOrDemoteDeletedDoc).not.toHaveBeenCalled();
    expect(hoisted.setSyncState).toHaveBeenCalledWith(DOC, 'error');
    expect(hoisted.warning).not.toHaveBeenCalled();
  });

  it('STILL strands on ERR_DELETED (definitive tombstone, JP-375)', () => {
    hoisted.getRecord.mockReturnValue(remote());
    handleRelayJoinError('ERR_DELETED', DOC);

    expect(hoisted.strandOrDemoteDeletedDoc).toHaveBeenCalledWith(DOC);
  });

  it('strands with access-revoked on ERR_VIEW_FORBIDDEN (JP-370)', () => {
    hoisted.getRecord.mockReturnValue(remote());
    handleRelayJoinError('ERR_VIEW_FORBIDDEN', DOC);

    expect(hoisted.strandOrDemoteDeletedDoc).toHaveBeenCalledWith(DOC, undefined, 'access-revoked');
  });

  it('is a silent no-op for a foreign-relay doc on ERR_UNKNOWN_DOC (JP-308)', () => {
    hoisted.getRecord.mockReturnValue(remote('other-relay:443')); // != connected HOME
    handleRelayJoinError('ERR_UNKNOWN_DOC', DOC);

    expect(hoisted.strandOrDemoteDeletedDoc).not.toHaveBeenCalled();
    expect(hoisted.setSyncState).not.toHaveBeenCalled();
    expect(hoisted.warning).not.toHaveBeenCalled();
  });

  it('is a silent no-op for a local-only doc on ERR_UNKNOWN_DOC', () => {
    hoisted.getRecord.mockReturnValue(localDoc);
    handleRelayJoinError('ERR_UNKNOWN_DOC', DOC);

    expect(hoisted.strandOrDemoteDeletedDoc).not.toHaveBeenCalled();
    expect(hoisted.setSyncState).not.toHaveBeenCalled();
    expect(hoisted.warning).not.toHaveBeenCalled();
  });

  it('warns (non-destructive) for an unknown id with NO local record', () => {
    hoisted.getRecord.mockReturnValue(undefined);
    handleRelayJoinError('ERR_UNKNOWN_DOC', DOC);

    expect(hoisted.strandOrDemoteDeletedDoc).not.toHaveBeenCalled();
    expect(hoisted.setSyncState).toHaveBeenCalledWith(DOC, 'error');
    expect(hoisted.warning).toHaveBeenCalledTimes(1);
  });
});
