/**
 * JP-118 — relay-doc asset routing through the blob store.
 *
 * Asserts the store's save/load seams use the provider's blob-sync hooks:
 *  - save uploads referenced blobs *before* the doc save, keeps blob://
 *    refs (no base64), and aborts the save if an upload fails;
 *  - load downloads referenced blobs (non-fatal on failure).
 *
 * IndexedDB-backed deps (RelayDocumentCache, SyncStateManager) are mocked
 * so the test stays in-memory; AssetBundler runs for real (reference-mode
 * bundling + hash collection are pure).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const cacheMock = vi.hoisted(() => ({
  get: vi.fn(async () => null),
  put: vi.fn(async () => {}),
  getCachedIdsForHost: vi.fn(() => [] as string[]),
  getMeta: vi.fn(() => null),
  remove: vi.fn(async () => {}),
}));

vi.mock('../storage/RelayDocumentCache', () => ({
  RelayDocumentCache: cacheMock,
}));

vi.mock('../collaboration/SyncStateManager', () => ({
  getSyncStateManager: () => ({ hasPendingChanges: () => false }),
}));

import { useRelayDocumentStore, type DocumentProvider } from './relayDocumentStore';
import { useConnectionStore } from './connectionStore';
import type { BlobSyncResult } from '../collaboration/BlobSyncService';
import type { DiagramDocument } from '../types/Document';

function ok(total: number): BlobSyncResult {
  return { total, success: total, failed: 0, errors: new Map() };
}

/** A doc that references one blob (rich-text image + GC list). */
function docWithBlob(id: string, hash: string, serverVersion?: number): DiagramDocument {
  return {
    id,
    name: id,
    pages: {
      'page-1': {
        id: 'page-1',
        name: 'Page 1',
        shapes: {},
        shapeOrder: [],
        createdAt: 0,
        modifiedAt: 0,
      },
    },
    pageOrder: ['page-1'],
    activePageId: 'page-1',
    richTextContent: `<img src="blob://${hash}">`,
    blobReferences: [hash],
    createdAt: 0,
    modifiedAt: 0,
    version: 1,
    ...(serverVersion !== undefined ? { serverVersion } : {}),
  } as unknown as DiagramDocument;
}

/** Provider with blob-sync hooks and spyable save/get. */
function makeProvider(over: Partial<DocumentProvider> = {}): DocumentProvider & {
  saveDocument: ReturnType<typeof vi.fn>;
  uploadBlobs: ReturnType<typeof vi.fn>;
  downloadBlobs: ReturnType<typeof vi.fn>;
  getDocument: ReturnType<typeof vi.fn>;
} {
  const p = {
    listDocuments: vi.fn(async () => []),
    getDocument: vi.fn(async () => {
      throw new Error('not used');
    }),
    saveDocument: vi.fn(async () => ({ newVersion: 2 })),
    deleteDocument: vi.fn(async () => {}),
    uploadBlobs: vi.fn(async (hashes: string[]) => ok(hashes.length)),
    downloadBlobs: vi.fn(async (hashes: string[]) => ok(hashes.length)),
    ...over,
  };
  return p as never;
}

describe('relayDocumentStore — JP-118 blob routing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    cacheMock.get.mockResolvedValue(null);
    useRelayDocumentStore.setState({ relayDocuments: {}, documentCache: {} });
    useConnectionStore.setState({
      host: { address: 'localhost:9876', url: 'http://localhost:9876' },
    });
  });

  it('uploads referenced blobs before the save and keeps blob:// refs (no base64)', async () => {
    const provider = makeProvider();
    useRelayDocumentStore.getState().setProvider(provider);

    await useRelayDocumentStore.getState().saveToHost(docWithBlob('doc-1', 'hashA'));

    // Uploaded the referenced blob...
    expect(provider.uploadBlobs).toHaveBeenCalledWith(['hashA']);
    // ...before the doc save (upload call ordered before save call).
    expect(provider.uploadBlobs.mock.invocationCallOrder[0]!).toBeLessThan(
      provider.saveDocument.mock.invocationCallOrder[0]!,
    );
    // The saved doc carries the blob:// ref and no embedded base64.
    const savedDoc = provider.saveDocument.mock.calls[0]![0] as DiagramDocument;
    const json = JSON.stringify(savedDoc);
    expect(json).toContain('blob://hashA');
    expect(json).not.toContain('data:');
    expect(json).not.toContain('base64');
  });

  it('aborts the save when a blob upload fails', async () => {
    const provider = makeProvider({
      uploadBlobs: vi.fn(async () => ({
        total: 1,
        success: 0,
        failed: 1,
        errors: new Map([['hashA', 'quota exceeded']]),
      })),
    });
    useRelayDocumentStore.getState().setProvider(provider);

    await expect(
      useRelayDocumentStore.getState().saveToHost(docWithBlob('doc-2', 'hashA')),
    ).rejects.toThrow(/upload .*asset/i);

    expect(provider.saveDocument).not.toHaveBeenCalled();
  });

  it('saves a doc with no assets without calling uploadBlobs', async () => {
    const provider = makeProvider();
    useRelayDocumentStore.getState().setProvider(provider);

    const bare = {
      id: 'doc-3',
      name: 'doc-3',
      pages: { 'p': { id: 'p', name: 'P', shapes: {}, shapeOrder: [], createdAt: 0, modifiedAt: 0 } },
      pageOrder: ['p'],
      activePageId: 'p',
      createdAt: 0,
      modifiedAt: 0,
      version: 1,
    } as unknown as DiagramDocument;

    await useRelayDocumentStore.getState().saveToHost(bare);

    expect(provider.uploadBlobs).not.toHaveBeenCalled();
    expect(provider.saveDocument).toHaveBeenCalledTimes(1);
  });

  it('downloads referenced blobs on load', async () => {
    const provider = makeProvider({
      getDocument: vi.fn(async () => ({
        document: docWithBlob('doc-4', 'hashB'),
        serverVersion: 5,
      })),
    });
    useRelayDocumentStore.getState().setProvider(provider);

    const doc = await useRelayDocumentStore.getState().loadRelayDocument('doc-4');

    expect(provider.downloadBlobs).toHaveBeenCalledWith(['hashB']);
    expect(doc.id).toBe('doc-4');
  });

  it('still returns the doc when a blob download fails (non-fatal)', async () => {
    const provider = makeProvider({
      getDocument: vi.fn(async () => ({ document: docWithBlob('doc-5', 'hashC') })),
      downloadBlobs: vi.fn(async () => ({
        total: 1,
        success: 0,
        failed: 1,
        errors: new Map([['hashC', 'offline']]),
      })),
    });
    useRelayDocumentStore.getState().setProvider(provider);

    const doc = await useRelayDocumentStore.getState().loadRelayDocument('doc-5');

    expect(provider.downloadBlobs).toHaveBeenCalled();
    expect(doc.id).toBe('doc-5');
  });
});
