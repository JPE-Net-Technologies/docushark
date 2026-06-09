import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { DiagramDocument } from '../types/Document';
import type { DocumentRecord } from '../types/DocumentRegistry';

// --- module mocks --------------------------------------------------------
vi.mock('../storage/AssetBundler', () => ({
  collectBlobReferences: vi.fn(() => [] as string[]),
}));
vi.mock('../storage/BlobStorage', () => ({
  blobStorage: { hasBlob: vi.fn(async () => false) },
}));
vi.mock('../storage/RelayDocumentCache', () => ({
  RelayDocumentCache: { get: vi.fn(async () => null) },
}));
vi.mock('./documentRegistry', () => ({
  useDocumentRegistry: {
    getState: vi.fn(() => ({ getDocumentContent: vi.fn(() => undefined) })),
  },
}));
vi.mock('./relayDocumentStore', () => ({
  useRelayDocumentStore: {
    getState: vi.fn(() => ({
      getCachedDocument: vi.fn(() => undefined),
      loadRelayDocument: vi.fn(),
    })),
  },
  getDocProvider: vi.fn(() => null),
}));

import {
  computeOfflineStatus,
  deriveOfflineState,
  makeAvailableOffline,
} from './offlineAvailability';
import { collectBlobReferences } from '../storage/AssetBundler';
import { blobStorage } from '../storage/BlobStorage';
import { useDocumentRegistry } from './documentRegistry';
import { useRelayDocumentStore, getDocProvider } from './relayDocumentStore';

const mockCollect = vi.mocked(collectBlobReferences);
const mockHasBlob = vi.mocked(blobStorage.hasBlob);
const mockRegistryState = vi.mocked(useDocumentRegistry.getState);
const mockRelayState = vi.mocked(useRelayDocumentStore.getState);
const mockGetProvider = vi.mocked(getDocProvider);

function record(type: DocumentRecord['type'], id = 'doc-1'): DocumentRecord {
  return { id, type, name: 'Doc' } as unknown as DocumentRecord;
}

const emptyDoc = { id: 'doc-1' } as unknown as DiagramDocument;

/** Wire the relay/registry/storage caches for a given body + present-blob set. */
function setCaches(opts: {
  cachedBody?: DiagramDocument | null;
  refs?: string[];
  present?: Set<string>;
}) {
  const { cachedBody = null, refs = [], present = new Set<string>() } = opts;
  mockCollect.mockReturnValue(refs);
  mockHasBlob.mockImplementation(async (h: string) => present.has(h));
  mockRelayState.mockReturnValue({
    getCachedDocument: vi.fn(() => cachedBody ?? undefined),
    loadRelayDocument: vi.fn(async () => cachedBody ?? emptyDoc),
  } as never);
  mockRegistryState.mockReturnValue({
    getDocumentContent: vi.fn(() => undefined),
  } as never);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetProvider.mockReturnValue(null);
});

describe('deriveOfflineState', () => {
  it('is online-only when the body is not cached', () => {
    expect(deriveOfflineState(false, 0, 0)).toBe('online-only');
    expect(deriveOfflineState(false, 5, 5)).toBe('online-only');
  });

  it('is ready when body cached and no blobs or all present', () => {
    expect(deriveOfflineState(true, 0, 0)).toBe('ready');
    expect(deriveOfflineState(true, 3, 3)).toBe('ready');
    expect(deriveOfflineState(true, 4, 3)).toBe('ready'); // present can exceed in edge cases
  });

  it('is partial when body cached but some blobs missing', () => {
    expect(deriveOfflineState(true, 0, 2)).toBe('partial');
    expect(deriveOfflineState(true, 1, 2)).toBe('partial');
  });
});

describe('computeOfflineStatus', () => {
  it('treats local documents as inherently ready', async () => {
    setCaches({});
    const status = await computeOfflineStatus(record('local'));
    expect(status).toEqual({ state: 'ready', present: 0, total: 0, bodyCached: true });
    // No blob/body lookups needed for local docs.
    expect(mockHasBlob).not.toHaveBeenCalled();
  });

  it('is online-only when no body is cached anywhere', async () => {
    setCaches({ cachedBody: null });
    const status = await computeOfflineStatus(record('remote'));
    expect(status).toEqual({ state: 'online-only', present: 0, total: 0, bodyCached: false });
  });

  it('is ready when body cached and every blob present', async () => {
    setCaches({
      cachedBody: emptyDoc,
      refs: ['a', 'b'],
      present: new Set(['a', 'b']),
    });
    const status = await computeOfflineStatus(record('remote'));
    expect(status).toEqual({ state: 'ready', present: 2, total: 2, bodyCached: true });
  });

  it('is partial with counts when some blobs are missing', async () => {
    setCaches({
      cachedBody: emptyDoc,
      refs: ['a', 'b', 'c'],
      present: new Set(['a']),
    });
    const status = await computeOfflineStatus(record('remote'));
    expect(status).toEqual({ state: 'partial', present: 1, total: 3, bodyCached: true });
  });
});

describe('makeAvailableOffline', () => {
  it('is a no-op for local documents', async () => {
    setCaches({});
    const status = await makeAvailableOffline(record('local'));
    expect(status.state).toBe('ready');
    expect(mockGetProvider).not.toHaveBeenCalled();
  });

  it('downloads missing blobs, reports progress, and ends ready', async () => {
    const present = new Set<string>(); // start with nothing cached
    setCaches({ cachedBody: emptyDoc, refs: ['a', 'b', 'c'], present });
    // The provider's downloadBlobs writes bytes into local storage.
    const downloadBlobs = vi.fn(async (hashes: string[]) => {
      for (const h of hashes) present.add(h);
      return { total: hashes.length, success: hashes.length, uploaded: hashes.length, failed: 0, skipped: 0, errors: [] };
    });
    mockGetProvider.mockReturnValue({ downloadBlobs } as never);

    const progress: Array<{ done: number; total: number }> = [];
    const status = await makeAvailableOffline(record('remote'), (p) => progress.push({ ...p }));

    // Every missing blob was fetched (one call per hash).
    expect(downloadBlobs).toHaveBeenCalledTimes(3);
    // Progress starts at 0/3 and ends at 3/3.
    expect(progress[0]).toEqual({ done: 0, total: 3 });
    expect(progress[progress.length - 1]).toEqual({ done: 3, total: 3 });
    // Final recompute sees all three present.
    expect(status).toEqual({ state: 'ready', present: 3, total: 3, bodyCached: true });
  });

  it('leaves the doc partial when a blob download fails', async () => {
    const present = new Set<string>(['a']);
    setCaches({ cachedBody: emptyDoc, refs: ['a', 'b'], present });
    const downloadBlobs = vi.fn(async () => {
      throw new Error('network');
    });
    mockGetProvider.mockReturnValue({ downloadBlobs } as never);

    const status = await makeAvailableOffline(record('remote'));
    expect(downloadBlobs).toHaveBeenCalledTimes(1); // only 'b' was missing
    expect(status).toEqual({ state: 'partial', present: 1, total: 2, bodyCached: true });
  });
});
