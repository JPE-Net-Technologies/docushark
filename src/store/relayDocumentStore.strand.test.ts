/**
 * JP-175 — clients react to a deleted relay document by preserving the user's
 * copy instead of silently dropping it. `strandOrDemoteDeletedDoc` decides:
 *   - any doc with a copy → snapshot into Trash (the editor leaves it if open)
 *   - open doc, no copy   → demote to local (edge-case fallback, keep the work)
 *   - self-initiated      → nothing to preserve
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mutable harness state the mocks read, so each test can vary "what's open".
const h = vi.hoisted(() => ({
  currentDocumentId: null as string | null,
  currentUserId: 'me' as string | undefined,
  demote: vi.fn(),
  newDocument: vi.fn(),
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
      newDocument: h.newDocument,
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

  it('strands the OPEN doc to Trash and resets the editor (no demote)', () => {
    h.currentDocumentId = DOC_ID;

    useRelayDocumentStore.getState().strandOrDemoteDeletedDoc(DOC_ID, 'someone-else');

    expect(h.trashStranded).toHaveBeenCalledTimes(1);
    expect(h.info).toHaveBeenCalledTimes(1); // "moved to Trash"
    expect(h.leaveDocument).toHaveBeenCalledTimes(1); // stop relay sync
    expect(h.newDocument).toHaveBeenCalledTimes(1); // editor leaves the trashed doc
    expect(h.demote).not.toHaveBeenCalled();
    expect(h.warning).not.toHaveBeenCalled();
    expect(h.removeDocument).toHaveBeenCalledWith(DOC_ID);
    expect(useRelayDocumentStore.getState().relayDocuments[DOC_ID]).toBeUndefined();
  });

  it('demotes an OPEN doc to local ONLY as a fallback when no copy can be preserved', async () => {
    h.currentDocumentId = DOC_ID;
    // No in-memory copy (registry returns undefined) and no cached copy.
    useRelayDocumentStore.setState({ documentCache: {} });
    h.cacheGet.mockResolvedValue(null);

    useRelayDocumentStore.getState().strandOrDemoteDeletedDoc(DOC_ID, 'someone-else');
    await new Promise((r) => setTimeout(r, 0)); // let the async cache lookup settle

    expect(h.trashStranded).not.toHaveBeenCalled();
    expect(h.demote).toHaveBeenCalledTimes(1);
    expect(h.warning).toHaveBeenCalledTimes(1); // "now a local document"
    expect(h.newDocument).not.toHaveBeenCalled(); // keep the user on their work
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
