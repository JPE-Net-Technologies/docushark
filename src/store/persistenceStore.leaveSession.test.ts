/**
 * DSK-192: `newDocument()` and `saveDocumentAs()` made a LOCAL document the
 * open one without leaving the previous relay document's collab session. The
 * session stayed bound, so page-list, field and metadata writes from the new
 * document landed in the previous document: live for its collaborators, and
 * persisted by the relay. `loadDocument` already left on the relay→local exit
 * (JP-188); all three paths now share that exit.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

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

import { usePersistenceStore } from './persistenceStore';
import { useRichTextPagesStore } from './richTextPagesStore';
import { useCollaborationStore } from '../collaboration';
import { readOpenDocumentId } from '../collaboration/openDocumentSource';

describe('DSK-192: local transitions leave the relay session', () => {
  const realLeave = useCollaborationStore.getState().leaveDocument;
  let leaveDocument: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    leaveDocument = vi.fn();
    useCollaborationStore.setState({ isActive: true, leaveDocument });
  });

  afterEach(() => {
    useCollaborationStore.setState({ isActive: false, leaveDocument: realLeave });
  });

  it('newDocument() leaves an active session', () => {
    usePersistenceStore.getState().newDocument();
    expect(leaveDocument).toHaveBeenCalledTimes(1);
  });

  it('newDocument() leaves BEFORE resetting the stores, so no reset can reach the old Y.Doc', () => {
    const oldPage = useRichTextPagesStore.getState().createPage('Page of the relay document');
    let orderAtLeave: string[] | null = null;
    leaveDocument.mockImplementation(() => {
      orderAtLeave = [...useRichTextPagesStore.getState().pageOrder];
    });

    usePersistenceStore.getState().newDocument();

    expect(orderAtLeave).toContain(oldPage);
    expect(useRichTextPagesStore.getState().pageOrder).not.toContain(oldPage);
  });

  it('saveDocumentAs() leaves an active session before the copy becomes the open document', () => {
    usePersistenceStore.setState({ currentDocumentId: 'doc-relay-original' });
    let openDocAtLeave: string | null | undefined;
    leaveDocument.mockImplementation(() => {
      openDocAtLeave = usePersistenceStore.getState().currentDocumentId;
    });

    usePersistenceStore.getState().saveDocumentAs('A local copy');

    expect(leaveDocument).toHaveBeenCalledTimes(1);
    expect(openDocAtLeave).toBe('doc-relay-original');
    expect(usePersistenceStore.getState().currentDocumentId).not.toBe('doc-relay-original');
  });

  it('leaves nothing when no session is active', () => {
    useCollaborationStore.setState({ isActive: false });
    usePersistenceStore.getState().newDocument();
    expect(leaveDocument).not.toHaveBeenCalled();
  });

  it('registers the open document as the collab sync guard source', () => {
    usePersistenceStore.setState({ currentDocumentId: 'doc-open' });
    expect(readOpenDocumentId()).toBe('doc-open');
  });
});
