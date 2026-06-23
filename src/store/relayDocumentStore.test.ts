/**
 * relayDocumentStore — JP-234 collab blob upload.
 *
 * `uploadCollabBlobs` pushes a doc's referenced blob bytes to the relay
 * WITHOUT a doc save, so files added during a collab session (where the REST
 * `saveToHost` is suppressed — relay sole writer, JP-108) still reach the relay
 * instead of living only in the browser's local cache.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useRelayDocumentStore, type DocumentProvider } from './relayDocumentStore';
import type { DiagramDocument } from '../types/Document';
import type { BlobSyncResult } from '../collaboration/BlobSyncService';

function makeDoc(blobReferences: string[]): DiagramDocument {
  return {
    id: 'doc-1',
    name: 'Doc',
    pages: {},
    pageOrder: [],
    blobReferences,
  } as unknown as DiagramDocument;
}

function okResult(n: number): BlobSyncResult {
  return { total: n, success: n, uploaded: n, failed: 0, skipped: 0, errors: new Map() };
}

function makeProvider(overrides: Partial<DocumentProvider> = {}) {
  const uploadBlobs = vi.fn(async (hashes: string[]) => okResult(hashes.length));
  const saveDocument = vi.fn(async () => ({ newVersion: 1 }));
  const provider = { uploadBlobs, saveDocument, ...overrides } as unknown as DocumentProvider;
  return { provider, uploadBlobs, saveDocument };
}

describe('relayDocumentStore.uploadCollabBlobs (JP-234)', () => {
  beforeEach(() => {
    useRelayDocumentStore.getState().setProvider(null);
  });

  it('uploads referenced blob bytes without saving the document', async () => {
    const { provider, uploadBlobs, saveDocument } = makeProvider();
    useRelayDocumentStore.getState().setProvider(provider);

    const result = await useRelayDocumentStore
      .getState()
      .uploadCollabBlobs(makeDoc(['hash-a', 'hash-b']));

    expect(uploadBlobs).toHaveBeenCalledTimes(1);
    const hashes = uploadBlobs.mock.calls[0]![0] as string[];
    expect(new Set(hashes)).toEqual(new Set(['hash-a', 'hash-b']));
    // Invariant: the collab path never does a doc save (relay is sole writer).
    expect(saveDocument).not.toHaveBeenCalled();
    expect(result?.uploaded).toBe(2);
  });

  it('no-ops when the document references no blobs', async () => {
    const { provider, uploadBlobs } = makeProvider();
    useRelayDocumentStore.getState().setProvider(provider);

    const result = await useRelayDocumentStore.getState().uploadCollabBlobs(makeDoc([]));

    expect(result).toBeUndefined();
    expect(uploadBlobs).not.toHaveBeenCalled();
  });

  it('no-ops on a filesystem-backed provider (no uploadBlobs)', async () => {
    const provider = { saveDocument: vi.fn() } as unknown as DocumentProvider;
    useRelayDocumentStore.getState().setProvider(provider);

    const result = await useRelayDocumentStore.getState().uploadCollabBlobs(makeDoc(['hash-a']));

    expect(result).toBeUndefined();
  });

  it('propagates a transport error (caller decides how to surface it)', async () => {
    const { provider } = makeProvider({
      uploadBlobs: vi.fn(async () => {
        throw new Error('storage quota exceeded');
      }) as NonNullable<DocumentProvider['uploadBlobs']>,
    });
    useRelayDocumentStore.getState().setProvider(provider);

    await expect(
      useRelayDocumentStore.getState().uploadCollabBlobs(makeDoc(['hash-a'])),
    ).rejects.toThrow('storage quota exceeded');
  });
});

describe('relayDocumentStore.refreshDocumentList (JP-324 #10)', () => {
  beforeEach(() => {
    useRelayDocumentStore.getState().setProvider(null);
    useRelayDocumentStore.setState({ authenticated: false });
  });

  it('no-ops when no provider is set', () => {
    useRelayDocumentStore.setState({ authenticated: true });
    // No provider → no throw, no fetch attempt.
    expect(() => useRelayDocumentStore.getState().refreshDocumentList()).not.toThrow();
  });

  it('no-ops when not authenticated even with a provider', () => {
    const listDocuments = vi.fn(async () => []);
    const provider = { listDocuments } as unknown as DocumentProvider;
    useRelayDocumentStore.getState().setProvider(provider);

    useRelayDocumentStore.getState().refreshDocumentList();

    expect(listDocuments).not.toHaveBeenCalled();
  });

  it('fetches the list when authenticated with a live provider', () => {
    const listDocuments = vi.fn(async () => []);
    const provider = { listDocuments } as unknown as DocumentProvider;
    useRelayDocumentStore.getState().setProvider(provider);
    useRelayDocumentStore.setState({ authenticated: true });

    useRelayDocumentStore.getState().refreshDocumentList();

    expect(listDocuments).toHaveBeenCalledTimes(1);
  });
});

describe('relayDocumentStore.setAuthenticated skipFetch (transfer no-op fix)', () => {
  beforeEach(() => {
    useRelayDocumentStore.getState().setProvider(null);
    useRelayDocumentStore.setState({ authenticated: false });
  });

  it('sets authenticated AND eagerly fetches the list by default', () => {
    const listDocuments = vi.fn(async () => []);
    useRelayDocumentStore.getState().setProvider({ listDocuments } as unknown as DocumentProvider);

    useRelayDocumentStore.getState().setAuthenticated(true);

    expect(useRelayDocumentStore.getState().authenticated).toBe(true);
    expect(listDocuments).toHaveBeenCalledTimes(1);
  });

  it('sets authenticated WITHOUT fetching when skipFetch is true (relay-doc boot)', () => {
    const listDocuments = vi.fn(async () => []);
    useRelayDocumentStore.getState().setProvider({ listDocuments } as unknown as DocumentProvider);

    useRelayDocumentStore.getState().setAuthenticated(true, { skipFetch: true });

    // authenticated flips (so isCloudSignedIn() is true → transfer works) but the
    // WS handshake will do the single fetch, not this call.
    expect(useRelayDocumentStore.getState().authenticated).toBe(true);
    expect(listDocuments).not.toHaveBeenCalled();
  });
});
