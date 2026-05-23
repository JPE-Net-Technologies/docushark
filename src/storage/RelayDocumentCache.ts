/**
 * Relay Document Cache
 *
 * Persistent cache for documents loaded from a relay, to enable
 * offline access. Documents loaded while online are cached locally
 * and remain accessible when the connection is lost.
 *
 * Uses IndexedDB for large documents, with localStorage fallback
 * for metadata and small documents.
 *
 * Phase 14.9.2 — Offline Reliability. Renamed from `TeamDocumentCache`
 * in Phase 20.3 Slice B (relay extraction).
 */

import type { DiagramDocument } from '../types/Document';

// ============ Types ============

/** Cache entry metadata */
interface CacheEntryMeta {
  /** Document ID */
  id: string;
  /** When the document was cached */
  cachedAt: number;
  /** Server version at time of cache (for staleness detection) */
  serverVersion?: number;
  /** Size in bytes (approximate) */
  size: number;
  /** Host address this document came from */
  relayId: string;
}

/** Full cache entry */
interface CacheEntry extends CacheEntryMeta {
  /** The cached document */
  document: DiagramDocument;
}

// ============ Constants ============

const DB_NAME = 'docushark-relay-cache';
const DB_VERSION = 1;
const STORE_NAME = 'documents';
const META_STORAGE_KEY = 'docushark-relay-cache-meta';

const MAX_CACHE_SIZE = 50 * 1024 * 1024; // 50MB max cache size
const MAX_CACHE_ENTRIES = 50; // Maximum number of cached documents

// ============ IndexedDB Helpers ============

let dbPromise: Promise<IDBDatabase> | null = null;

/**
 * Open the IndexedDB database.
 */
function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('IndexedDB not available'));
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      console.error('[RelayDocumentCache] Failed to open IndexedDB:', request.error);
      dbPromise = null;
      reject(request.error);
    };

    request.onsuccess = () => {
      resolve(request.result);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      
      // Create object store for documents
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'id' });
      }
    };
  });

  return dbPromise;
}

/**
 * Get an entry from IndexedDB.
 */
async function getFromDB(id: string): Promise<CacheEntry | null> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? null);
    });
  } catch (error) {
    console.error('[RelayDocumentCache] Failed to get from IndexedDB:', error);
    return null;
  }
}

/**
 * Put an entry in IndexedDB.
 */
async function putInDB(entry: CacheEntry): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put(entry);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    console.error('[RelayDocumentCache] Failed to put in IndexedDB:', error);
  }
}

/**
 * Delete an entry from IndexedDB.
 */
async function deleteFromDB(id: string): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    console.error('[RelayDocumentCache] Failed to delete from IndexedDB:', error);
  }
}

/**
 * Get all entries from IndexedDB.
 */
async function getAllFromDB(): Promise<CacheEntry[]> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve(request.result ?? []);
    });
  } catch (error) {
    console.error('[RelayDocumentCache] Failed to get all from IndexedDB:', error);
    return [];
  }
}

/**
 * Clear all entries from IndexedDB.
 */
async function clearDB(): Promise<void> {
  try {
    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.clear();

      request.onerror = () => reject(request.error);
      request.onsuccess = () => resolve();
    });
  } catch (error) {
    console.error('[RelayDocumentCache] Failed to clear IndexedDB:', error);
  }
}

// ============ Metadata Management ============

/**
 * Get all cache metadata from localStorage.
 */
function getCacheMeta(): CacheEntryMeta[] {
  try {
    const json = localStorage.getItem(META_STORAGE_KEY);
    if (!json) return [];
    return JSON.parse(json) as CacheEntryMeta[];
  } catch {
    return [];
  }
}

/**
 * Save cache metadata to localStorage.
 */
function saveCacheMeta(meta: CacheEntryMeta[]): void {
  try {
    localStorage.setItem(META_STORAGE_KEY, JSON.stringify(meta));
  } catch (error) {
    console.error('[RelayDocumentCache] Failed to save metadata:', error);
  }
}

/**
 * Update metadata for a single entry.
 */
function updateCacheMeta(entry: CacheEntryMeta): void {
  const meta = getCacheMeta();
  const index = meta.findIndex((m) => m.id === entry.id);
  if (index >= 0) {
    meta[index] = entry;
  } else {
    meta.push(entry);
  }
  saveCacheMeta(meta);
}

/**
 * Remove metadata for an entry.
 */
function removeCacheMeta(id: string): void {
  const meta = getCacheMeta();
  const filtered = meta.filter((m) => m.id !== id);
  saveCacheMeta(filtered);
}

// ============ Public API ============

/**
 * Relay Document Cache
 *
 * Provides persistent caching of relay-backed documents for offline access.
 *
 * Usage:
 * ```typescript
 * // Cache a document after loading from server
 * await RelayDocumentCache.put(document, 'host-123');
 *
 * // Get a cached document (works offline)
 * const doc = await RelayDocumentCache.get('doc-123');
 *
 * // Check if document is cached
 * if (RelayDocumentCache.has('doc-123')) {
 *   // Can work offline
 * }
 * ```
 */
export const RelayDocumentCache = {
  /**
   * Get a cached document by ID.
   * Returns null if not cached.
   */
  async get(docId: string): Promise<DiagramDocument | null> {
    const entry = await getFromDB(docId);
    if (!entry) return null;

    // Update access time in metadata (for LRU)
    const meta: CacheEntryMeta = {
      id: entry.id,
      cachedAt: Date.now(), // Update to track access
      size: entry.size,
      relayId: entry.relayId,
    };
    if (entry.serverVersion !== undefined) {
      meta.serverVersion = entry.serverVersion;
    }
    updateCacheMeta(meta);

    return entry.document;
  },

  /**
   * Cache a document.
   * Automatically handles size limits and eviction.
   */
  async put(document: DiagramDocument, relayId: string): Promise<void> {
    const size = JSON.stringify(document).length;

    // Check if we need to evict
    await this.ensureSpace(size);

    const entry: CacheEntry = {
      id: document.id,
      cachedAt: Date.now(),
      size,
      relayId,
      document,
    };
    if (document.serverVersion !== undefined) {
      entry.serverVersion = document.serverVersion;
    }

    await putInDB(entry);

    const meta: CacheEntryMeta = {
      id: entry.id,
      cachedAt: entry.cachedAt,
      size: entry.size,
      relayId: entry.relayId,
    };
    if (entry.serverVersion !== undefined) {
      meta.serverVersion = entry.serverVersion;
    }
    updateCacheMeta(meta);

    console.log(`[RelayDocumentCache] Cached document: ${document.id} (${Math.round(size / 1024)}KB)`);
  },

  /**
   * Remove a document from cache.
   */
  async remove(docId: string): Promise<void> {
    await deleteFromDB(docId);
    removeCacheMeta(docId);
    console.log(`[RelayDocumentCache] Removed from cache: ${docId}`);
  },

  /**
   * Check if a document is cached.
   */
  has(docId: string): boolean {
    const meta = getCacheMeta();
    return meta.some((m) => m.id === docId);
  },

  /**
   * Get metadata for a cached document.
   */
  getMeta(docId: string): CacheEntryMeta | null {
    const meta = getCacheMeta();
    return meta.find((m) => m.id === docId) ?? null;
  },

  /**
   * Get all cached document IDs.
   */
  getCachedIds(): string[] {
    return getCacheMeta().map((m) => m.id);
  },

  /**
   * Get all cached documents for a specific host.
   */
  getCachedIdsForHost(relayId: string): string[] {
    return getCacheMeta()
      .filter((m) => m.relayId === relayId)
      .map((m) => m.id);
  },

  /**
   * Clear all cached documents.
   */
  async clearAll(): Promise<void> {
    await clearDB();
    saveCacheMeta([]);
    console.log('[RelayDocumentCache] Cleared all cached documents');
  },

  /**
   * Clear cached documents for a specific host.
   */
  async clearForHost(relayId: string): Promise<void> {
    const meta = getCacheMeta();
    const toRemove = meta.filter((m) => m.relayId === relayId);

    for (const entry of toRemove) {
      await deleteFromDB(entry.id);
    }

    const remaining = meta.filter((m) => m.relayId !== relayId);
    saveCacheMeta(remaining);

    console.log(`[RelayDocumentCache] Cleared ${toRemove.length} documents for host: ${relayId}`);
  },

  /**
   * Get total cache size in bytes.
   */
  getTotalSize(): number {
    return getCacheMeta().reduce((sum, m) => sum + m.size, 0);
  },

  /**
   * Get cache statistics.
   */
  getStats(): { entries: number; totalSize: number; maxSize: number; maxEntries: number } {
    const meta = getCacheMeta();
    return {
      entries: meta.length,
      totalSize: meta.reduce((sum, m) => sum + m.size, 0),
      maxSize: MAX_CACHE_SIZE,
      maxEntries: MAX_CACHE_ENTRIES,
    };
  },

  /**
   * Ensure there's space for a new document.
   * Evicts oldest entries if necessary.
   */
  async ensureSpace(neededBytes: number): Promise<void> {
    const meta = getCacheMeta();

    // Sort by cachedAt (oldest first) for LRU eviction
    const sorted = [...meta].sort((a, b) => a.cachedAt - b.cachedAt);

    let currentSize = sorted.reduce((sum, m) => sum + m.size, 0);
    let currentCount = sorted.length;

    // Evict until we have space
    const toEvict: string[] = [];

    while (
      (currentSize + neededBytes > MAX_CACHE_SIZE || currentCount >= MAX_CACHE_ENTRIES) &&
      sorted.length > 0
    ) {
      const oldest = sorted.shift()!;
      toEvict.push(oldest.id);
      currentSize -= oldest.size;
      currentCount--;
    }

    // Perform evictions
    for (const id of toEvict) {
      await deleteFromDB(id);
      console.log(`[RelayDocumentCache] Evicted for space: ${id}`);
    }

    if (toEvict.length > 0) {
      const remaining = meta.filter((m) => !toEvict.includes(m.id));
      saveCacheMeta(remaining);
    }
  },

  /**
   * Check if a cached document is stale compared to server version.
   */
  isStale(docId: string, serverVersion: number): boolean {
    const meta = this.getMeta(docId);
    if (!meta) return true;
    if (meta.serverVersion === undefined) return true;
    return meta.serverVersion < serverVersion;
  },

  /**
   * Preload all cached documents into memory (for fast access).
   * Returns a map of docId -> document.
   */
  async preloadAll(): Promise<Map<string, DiagramDocument>> {
    const entries = await getAllFromDB();
    const map = new Map<string, DiagramDocument>();

    for (const entry of entries) {
      map.set(entry.id, entry.document);
    }

    console.log(`[RelayDocumentCache] Preloaded ${map.size} documents`);
    return map;
  },
};

// Export type for external use
export type { CacheEntryMeta };
