/**
 * JP-175 — clients react to a deleted relay document by preserving the user's
 * copy instead of silently dropping it. `strandOrDemoteDeletedDoc` decides:
 *   - open doc        → demote to local + stop relay sync (don't strand)
 *   - other doc, copy → strand into Trash
 *   - self-initiated  → nothing to preserve
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable harness state the mocks read, so each test can vary "what's open".
const h = vi.hoisted(() => ({
  currentDocumentId: null as string | null,
  currentUserId: 'me' as string | undefined,
  demote: vi.fn(),
  leaveDocument: vi.fn(),
  trashStranded: vi.fn(),
  removeDocument: vi.fn(),
  warning: vi.fn(),
  info: vi.fn(),
  cacheGet: vi.fn(async () => null as unknown),
  cacheRemove: vi.fn(async () => {}),
}));

vi.mock('./persistenceStore', () => ({
  usePersistenceStore: {
    getState: () => ({
      currentDocumentId: h.currentDocumentId,
      demoteCurrentDocumentToLocal: h.demote,
    }),
  },
}));
vi.mock('./notificationStore', () => ({
  useNotificationStore: { getState: () => ({ warning: h.warning, info: h.info }) },
}));
vi.mock('./trashStore', () => ({
  useTrashStore: { getState: () => ({ trashStranded: h.trashStranded }) },
}));
vi.mock('../store/userStore', () => ({
  useUserStore: { getState: () => ({ currentUser: { id: h.currentUserId, role: 'user' } }) },
}));
vi.mock('../store/connectionStore', () => ({
  useConnectionStore: { getState: () => ({ host: { address: 'relay-1' } }) },
  useIsRelayAuthenticated: () => false,
}));
vi.mock('../collaboration/collaborationStore', () => ({
  isCollabContentDoc: () => false,
  useCollaborationStore: { getState: () => ({ leaveDocument: h.leaveDocument }) },
}));
vi.mock('./documentRegistry', () => ({
  useDocumentRegistry: {
    getState: () => ({
      getDocumentContent: () => undefined,
      removeDocument: h.removeDocument,
      registerRemote: vi.fn(),
    }),
  },
}));
vi.mock('../storage/RelayDocumentCache', () => ({
  RelayDocumentCache: { get: h.cacheGet, remove: h.cacheRemove },
}));

import { useRelayDocumentStore } from './relayDocumentStore';
import type { DiagramDocument } from '../types/Document';

const DOC_ID = 'doc-1';
const makeDoc = (): DiagramDocument =>
  ({ id: DOC_ID, name: 'My Doc', pages: {}, pageOrder: [] }) as unknown as DiagramDocument;

function seedRelayDoc() {
  useRelayDocumentStore.setState({
    documentCache: { [DOC_ID]: makeDoc() },
    relayDocuments: {
      [DOC_ID]: { id: DOC_ID, name: 'My Doc', createdAt: 0, modifiedAt: 5, pageCount: 1, ownerId: 'owner-1' },
    },
  });
}

describe('strandOrDemoteDeletedDoc (JP-175)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.currentDocumentId = null;
    h.currentUserId = 'me';
    h.cacheGet.mockResolvedValue(null);
    seedRelayDoc();
  });

  it('strands a non-open doc into Trash and clears relay state', () => {
    useRelayDocumentStore.getState().strandOrDemoteDeletedDoc(DOC_ID, 'someone-else');

    expect(h.trashStranded).toHaveBeenCalledTimes(1);
    const [doc, origin] = h.trashStranded.mock.calls[0]!;
    expect((doc as DiagramDocument).id).toBe(DOC_ID);
    expect(origin).toEqual({ relayId: 'relay-1', ownerId: 'owner-1', lastSyncedAt: 5 });

    expect(h.removeDocument).toHaveBeenCalledWith(DOC_ID);
    expect(h.demote).not.toHaveBeenCalled();
    expect(useRelayDocumentStore.getState().relayDocuments[DOC_ID]).toBeUndefined();
    expect(useRelayDocumentStore.getState().documentCache[DOC_ID]).toBeUndefined();
  });

  it('demotes the OPEN doc to local instead of stranding it', () => {
    h.currentDocumentId = DOC_ID;

    useRelayDocumentStore.getState().strandOrDemoteDeletedDoc(DOC_ID, 'someone-else');

    expect(h.demote).toHaveBeenCalledTimes(1);
    expect(h.leaveDocument).toHaveBeenCalledTimes(1);
    expect(h.warning).toHaveBeenCalledTimes(1);
    expect(h.trashStranded).not.toHaveBeenCalled();
    // The (now-local) registry entry is preserved — don't remove it.
    expect(h.removeDocument).not.toHaveBeenCalled();
    expect(useRelayDocumentStore.getState().relayDocuments[DOC_ID]).toBeUndefined();
  });

  it('preserves nothing when WE initiated the deletion', () => {
    useRelayDocumentStore.getState().strandOrDemoteDeletedDoc(DOC_ID, 'me');

    expect(h.trashStranded).not.toHaveBeenCalled();
    expect(h.demote).not.toHaveBeenCalled();
    expect(h.removeDocument).toHaveBeenCalledWith(DOC_ID);
  });

  it('routes a Deleted DocEvent through the strand path', () => {
    useRelayDocumentStore.getState().handleDocumentEvent({
      eventType: 'deleted',
      docId: DOC_ID,
      userId: 'someone-else',
    });
    expect(h.trashStranded).toHaveBeenCalledTimes(1);
  });
});
