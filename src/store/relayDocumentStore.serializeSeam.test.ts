/**
 * JP-423 — the `saveToHost` wire seam applies `serializeDocForRest`.
 *
 * The withhold happens at the wire ONLY: the provider receives the blanked
 * body while the store's caches keep the FULL body (a pending page must still
 * open offline with its content).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const cacheMock = vi.hoisted(() => ({
  get: vi.fn(async () => null as unknown),
  put: vi.fn(async (..._args: unknown[]) => {}),
  getCachedIdsForHost: vi.fn(() => [] as string[]),
  getMeta: vi.fn(() => null),
  remove: vi.fn(async () => {}),
}));

vi.mock('../storage/RelayDocumentCache', () => ({ RelayDocumentCache: cacheMock }));
vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => ({ hasPendingChanges: () => false }),
}));

import { useRelayDocumentStore, type DocumentProvider } from './relayDocumentStore';
import { usePendingSyncPages } from './pendingSyncPages';
import type { DiagramDocument } from '../types/Document';

function makeDoc(): DiagramDocument {
  return {
    id: 'doc-1',
    name: 'Doc',
    pages: {},
    pageOrder: [],
    activePageId: '',
    createdAt: 0,
    modifiedAt: 0,
    version: 1,
    blobReferences: [],
    richTextPages: {
      pages: {
        'rt-pending': {
          id: 'rt-pending',
          name: 'Pending',
          content: '<p>offline-created</p>',
          createdAt: 0,
          modifiedAt: 0,
        },
        'rt-normal': {
          id: 'rt-normal',
          name: 'Normal',
          content: '<p>synced</p>',
          createdAt: 0,
          modifiedAt: 0,
        },
      },
      pageOrder: ['rt-pending', 'rt-normal'],
      activePageId: 'rt-pending',
    },
  } as unknown as DiagramDocument;
}

describe('saveToHost wire seam (JP-423)', () => {
  beforeEach(() => {
    usePendingSyncPages.setState({ pending: {} });
    useRelayDocumentStore.getState().setProvider(null);
    cacheMock.put.mockClear();
  });

  it('sends the withheld body over the wire but caches the full body', async () => {
    usePendingSyncPages.getState().markPending('rt-pending', 'doc-1');
    const saveDocument = vi.fn(async (_doc: DiagramDocument) => ({ newVersion: 2 }));
    useRelayDocumentStore
      .getState()
      .setProvider({ saveDocument } as unknown as DocumentProvider);

    const doc = makeDoc();
    await useRelayDocumentStore.getState().saveToHost(doc);

    // Wire body: pending page blanked, others intact.
    const sent = saveDocument.mock.calls[0]![0];
    expect(sent.richTextPages?.pages['rt-pending']?.content).toBe('');
    expect(sent.richTextPages?.pages['rt-normal']?.content).toBe('<p>synced</p>');

    // Input untouched; caches keep the FULL body.
    expect(doc.richTextPages?.pages['rt-pending']?.content).toBe('<p>offline-created</p>');
    const inMemory = useRelayDocumentStore.getState().documentCache['doc-1'];
    expect(inMemory?.richTextPages?.pages['rt-pending']?.content).toBe('<p>offline-created</p>');
    const persisted = cacheMock.put.mock.calls[0]![0] as unknown as DiagramDocument;
    expect(persisted.richTextPages?.pages['rt-pending']?.content).toBe('<p>offline-created</p>');
  });

  it('sends the body unchanged when nothing is pending', async () => {
    const saveDocument = vi.fn(async (_doc: DiagramDocument) => ({ newVersion: 2 }));
    useRelayDocumentStore
      .getState()
      .setProvider({ saveDocument } as unknown as DocumentProvider);

    await useRelayDocumentStore.getState().saveToHost(makeDoc());

    const sent = saveDocument.mock.calls[0]![0];
    expect(sent.richTextPages?.pages['rt-pending']?.content).toBe('<p>offline-created</p>');
  });
});
