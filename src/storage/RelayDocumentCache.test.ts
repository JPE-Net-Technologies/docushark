/**
 * Relay Document Cache Tests
 *
 * Tests for persistent offline caching of relay-backed documents.
 * Phase 14.9.2 - Offline Reliability (renamed in Phase 20.3 Slice B).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { RelayDocumentCache } from './RelayDocumentCache';
import type { DiagramDocument } from '../types/Document';

// Mock IndexedDB
const mockIDBData: Record<string, unknown> = {};
const mockIDBRequest = () => ({
  onerror: null as ((event: unknown) => void) | null,
  onsuccess: null as ((event: unknown) => void) | null,
  result: null as unknown,
  error: null as Error | null,
});

const mockObjectStore = {
  get: vi.fn((key: string) => {
    const req = mockIDBRequest();
    setTimeout(() => {
      req.result = mockIDBData[key] ?? null;
      req.onsuccess?.({});
    }, 0);
    return req;
  }),
  put: vi.fn((value: { key: string }) => {
    const req = mockIDBRequest();
    setTimeout(() => {
      // keyPath is the composite `key` (JP-370), not the bare doc id.
      mockIDBData[value.key] = value;
      req.onsuccess?.({});
    }, 0);
    return req;
  }),
  delete: vi.fn((key: string) => {
    const req = mockIDBRequest();
    setTimeout(() => {
      delete mockIDBData[key];
      req.onsuccess?.({});
    }, 0);
    return req;
  }),
  getAll: vi.fn(() => {
    const req = mockIDBRequest();
    setTimeout(() => {
      req.result = Object.values(mockIDBData);
      req.onsuccess?.({});
    }, 0);
    return req;
  }),
  clear: vi.fn(() => {
    const req = mockIDBRequest();
    setTimeout(() => {
      for (const key of Object.keys(mockIDBData)) {
        delete mockIDBData[key];
      }
      req.onsuccess?.({});
    }, 0);
    return req;
  }),
};

const mockTransaction = {
  objectStore: vi.fn(() => mockObjectStore),
};

const mockDB = {
  transaction: vi.fn(() => mockTransaction),
  objectStoreNames: {
    contains: vi.fn(() => true),
  },
  createObjectStore: vi.fn(),
};

// Mock localStorage
const localStorageMock = (() => {
  let store: Record<string, string> = {};
  return {
    getItem: vi.fn((key: string) => store[key] ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store[key] = value;
    }),
    removeItem: vi.fn((key: string) => {
      delete store[key];
    }),
    clear: () => {
      store = {};
    },
  };
})();

// Setup mocks
Object.defineProperty(globalThis, 'localStorage', { value: localStorageMock });

Object.defineProperty(globalThis, 'indexedDB', {
  value: {
    open: vi.fn(() => {
      const req = mockIDBRequest();
      setTimeout(() => {
        req.result = mockDB;
        req.onsuccess?.({});
      }, 0);
      return req;
    }),
  },
});

// ============ Test Fixtures ============

function createTestDocument(id: string, overrides: Partial<DiagramDocument> = {}): DiagramDocument {
  return {
    id,
    name: `Test Document ${id}`,
    pages: {},
    pageOrder: ['page-1'],
    activePageId: 'page-1',
    createdAt: Date.now() - 10000,
    modifiedAt: Date.now(),
    isRelayDocument: true,
    ...overrides,
  } as DiagramDocument;
}

// ============ Tests ============

describe('RelayDocumentCache', () => {
  beforeEach(() => {
    // Clear mocks and data
    vi.clearAllMocks();
    localStorageMock.clear();
    for (const key of Object.keys(mockIDBData)) {
      delete mockIDBData[key];
    }
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // JP-370: every cache entry is scoped to a workspace.
  const WS = 'ws-alpha';
  const WS2 = 'ws-beta';

  describe('put and get', () => {
    it('caches and retrieves a document', async () => {
      const doc = createTestDocument('doc-1');

      await RelayDocumentCache.put(doc, 'host-123', WS);
      const cached = await RelayDocumentCache.get(WS, 'doc-1');

      expect(cached).toEqual(doc);
    });

    it('returns null for uncached document', async () => {
      const cached = await RelayDocumentCache.get(WS, 'non-existent');
      expect(cached).toBeNull();
    });

    it('does not re-home a doc: a later put from another relay keeps the origin (JP-117)', async () => {
      const doc = createTestDocument('doc-1');

      await RelayDocumentCache.put(doc, 'relay-a', WS);
      // Caching the same doc again while connected to a different relay must
      // NOT change its origin — origin is first-set, never clobbered.
      await RelayDocumentCache.put(doc, 'relay-b', WS);

      expect(RelayDocumentCache.getMeta(WS, 'doc-1')?.relayId).toBe('relay-a');
    });

    it('stores metadata in localStorage', async () => {
      const doc = createTestDocument('doc-1', { serverVersion: 5 });

      await RelayDocumentCache.put(doc, 'host-123', WS);

      expect(localStorageMock.setItem).toHaveBeenCalledWith(
        'docushark-relay-cache-meta',
        expect.stringContaining('doc-1')
      );

      const meta = RelayDocumentCache.getMeta(WS, 'doc-1');
      expect(meta).not.toBeNull();
      expect(meta?.id).toBe('doc-1');
      expect(meta?.workspaceId).toBe(WS);
      expect(meta?.relayId).toBe('host-123');
      expect(meta?.serverVersion).toBe(5);
    });
  });

  describe('workspace isolation (JP-370)', () => {
    it('does not collide when two workspaces cache the same doc id on one relay', async () => {
      // Same docId, same relay host — different workspaces. This is the exact
      // multi-origin contamination the workspace key prevents.
      const docA = createTestDocument('doc-x', { name: 'Alpha copy' });
      const docB = createTestDocument('doc-x', { name: 'Beta copy' });

      await RelayDocumentCache.put(docA, 'host-shared', WS);
      await RelayDocumentCache.put(docB, 'host-shared', WS2);

      // Each workspace reads back ITS OWN document — no overwrite.
      expect((await RelayDocumentCache.get(WS, 'doc-x'))?.name).toBe('Alpha copy');
      expect((await RelayDocumentCache.get(WS2, 'doc-x'))?.name).toBe('Beta copy');
    });

    it('clearForWorkspace removes only that workspace, leaving siblings intact', async () => {
      await RelayDocumentCache.put(createTestDocument('doc-x'), 'host-shared', WS);
      await RelayDocumentCache.put(createTestDocument('doc-x'), 'host-shared', WS2);

      await RelayDocumentCache.clearForWorkspace(WS);

      expect(RelayDocumentCache.has(WS, 'doc-x')).toBe(false);
      expect(RelayDocumentCache.has(WS2, 'doc-x')).toBe(true);
    });

    it('getCachedIds / preloadAll are scoped to one workspace', async () => {
      await RelayDocumentCache.put(createTestDocument('doc-1'), 'host', WS);
      await RelayDocumentCache.put(createTestDocument('doc-2'), 'host', WS);
      await RelayDocumentCache.put(createTestDocument('doc-3'), 'host', WS2);

      expect(RelayDocumentCache.getCachedIds(WS).sort()).toEqual(['doc-1', 'doc-2']);
      expect(RelayDocumentCache.getCachedIds(WS2)).toEqual(['doc-3']);

      const preloadedAlpha = await RelayDocumentCache.preloadAll(WS);
      expect(preloadedAlpha.size).toBe(2);
      expect(preloadedAlpha.has('doc-3')).toBe(false);
    });
  });

  describe('has', () => {
    it('returns true for cached document', async () => {
      const doc = createTestDocument('doc-1');
      await RelayDocumentCache.put(doc, 'host-123', WS);

      expect(RelayDocumentCache.has(WS, 'doc-1')).toBe(true);
    });

    it('returns false for uncached document', () => {
      expect(RelayDocumentCache.has(WS, 'non-existent')).toBe(false);
    });
  });

  describe('remove', () => {
    it('removes a cached document', async () => {
      const doc = createTestDocument('doc-1');
      await RelayDocumentCache.put(doc, 'host-123', WS);

      await RelayDocumentCache.remove(WS, 'doc-1');

      expect(RelayDocumentCache.has(WS, 'doc-1')).toBe(false);
      const cached = await RelayDocumentCache.get(WS, 'doc-1');
      expect(cached).toBeNull();
    });
  });

  describe('getCachedIds', () => {
    it('returns all cached document IDs for a workspace', async () => {
      await RelayDocumentCache.put(createTestDocument('doc-1'), 'host-123', WS);
      await RelayDocumentCache.put(createTestDocument('doc-2'), 'host-123', WS);
      await RelayDocumentCache.put(createTestDocument('doc-3'), 'host-456', WS);

      const ids = RelayDocumentCache.getCachedIds(WS);

      expect(ids).toContain('doc-1');
      expect(ids).toContain('doc-2');
      expect(ids).toContain('doc-3');
      expect(ids.length).toBe(3);
    });
  });

  describe('clearAll', () => {
    it('clears all cached documents (every workspace)', async () => {
      await RelayDocumentCache.put(createTestDocument('doc-1'), 'host-123', WS);
      await RelayDocumentCache.put(createTestDocument('doc-2'), 'host-456', WS2);

      await RelayDocumentCache.clearAll();

      expect(RelayDocumentCache.getCachedIds(WS).length).toBe(0);
      expect(RelayDocumentCache.getCachedIds(WS2).length).toBe(0);
    });
  });

  describe('isStale', () => {
    it('returns true for uncached document', () => {
      expect(RelayDocumentCache.isStale(WS, 'non-existent', 1)).toBe(true);
    });

    it('returns true when server version is higher', async () => {
      const doc = createTestDocument('doc-1', { serverVersion: 5 });
      await RelayDocumentCache.put(doc, 'host-123', WS);

      expect(RelayDocumentCache.isStale(WS, 'doc-1', 6)).toBe(true);
    });

    it('returns false when server version is same or lower', async () => {
      const doc = createTestDocument('doc-1', { serverVersion: 5 });
      await RelayDocumentCache.put(doc, 'host-123', WS);

      expect(RelayDocumentCache.isStale(WS, 'doc-1', 5)).toBe(false);
      expect(RelayDocumentCache.isStale(WS, 'doc-1', 4)).toBe(false);
    });

    it('returns true when cached doc has no version', async () => {
      const doc = createTestDocument('doc-1');
      delete (doc as { serverVersion?: number }).serverVersion;
      await RelayDocumentCache.put(doc, 'host-123', WS);

      expect(RelayDocumentCache.isStale(WS, 'doc-1', 1)).toBe(true);
    });
  });

  describe('getStats', () => {
    it('returns cache statistics', async () => {
      await RelayDocumentCache.put(createTestDocument('doc-1'), 'host-123', WS);
      await RelayDocumentCache.put(createTestDocument('doc-2'), 'host-123', WS);

      const stats = RelayDocumentCache.getStats();

      expect(stats.entries).toBe(2);
      expect(stats.totalSize).toBeGreaterThan(0);
      expect(stats.maxSize).toBe(50 * 1024 * 1024);
      expect(stats.maxEntries).toBe(50);
    });
  });

  describe('getTotalSize', () => {
    it('calculates total cache size', async () => {
      const doc1 = createTestDocument('doc-1');
      const doc2 = createTestDocument('doc-2');

      await RelayDocumentCache.put(doc1, 'host-123', WS);
      await RelayDocumentCache.put(doc2, 'host-123', WS);

      const totalSize = RelayDocumentCache.getTotalSize();
      const expectedSize = JSON.stringify(doc1).length + JSON.stringify(doc2).length;

      expect(totalSize).toBe(expectedSize);
    });
  });

  describe('preloadAll', () => {
    it('returns map of a workspace\'s cached documents', async () => {
      const doc1 = createTestDocument('doc-1');
      const doc2 = createTestDocument('doc-2');

      await RelayDocumentCache.put(doc1, 'host-123', WS);
      await RelayDocumentCache.put(doc2, 'host-123', WS);

      const preloaded = await RelayDocumentCache.preloadAll(WS);

      expect(preloaded.size).toBe(2);
      expect(preloaded.get('doc-1')).toEqual(doc1);
      expect(preloaded.get('doc-2')).toEqual(doc2);
    });
  });
});
