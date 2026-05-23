/**
 * Document Cache Manager
 *
 * Provides intelligent caching for relay documents with TTL-based invalidation,
 * window focus refresh, and server event integration.
 *
 * Features:
 * - TTL (time-to-live) for cached entries
 * - Automatic refresh on window focus/visibility
 * - Targeted invalidation by document ID
 * - Batch invalidation for groups of documents
 * - Server event subscription for real-time updates
 * - Memory-efficient LRU-style eviction
 *
 * Phase 14.9.2 - Data Integrity Improvements
 */

import type { DocumentMetadata } from '../types/Document';

// ============ Types ============

/** Cache entry with TTL metadata */
export interface CacheEntry<T> {
  /** Cached value */
  value: T;
  /** Timestamp when entry was cached */
  cachedAt: number;
  /** Time-to-live in milliseconds */
  ttl: number;
  /** Optional ETag for conditional requests */
  etag?: string;
}

/** Cache configuration */
export interface CacheConfig {
  /** Default TTL for document list (ms, default: 5 minutes) */
  listTtl: number;
  /** Default TTL for individual documents (ms, default: 1 minute) */
  documentTtl: number;
  /** Whether to refresh on window focus (default: true) */
  refreshOnFocus: boolean;
  /** Maximum number of entries before eviction (default: 100) */
  maxEntries: number;
  /** Minimum time between refreshes (ms, default: 10 seconds) */
  minRefreshInterval: number;
}

/** Cache statistics */
export interface CacheStats {
  /** Number of cache hits */
  hits: number;
  /** Number of cache misses */
  misses: number;
  /** Number of entries currently cached */
  entries: number;
  /** Number of entries evicted */
  evictions: number;
  /** Number of forced invalidations */
  invalidations: number;
  /** Number of window focus refreshes */
  focusRefreshes: number;
}

/** Cache event types */
export type CacheEventType = 
  | 'hit'
  | 'miss'
  | 'set'
  | 'invalidate'
  | 'evict'
  | 'refresh'
  | 'expired';

/** Cache event callback */
export type CacheEventCallback = (
  event: CacheEventType,
  key: string,
  value?: unknown
) => void;

// ============ Constants ============

const DEFAULT_CONFIG: CacheConfig = {
  listTtl: 5 * 60 * 1000, // 5 minutes
  documentTtl: 1 * 60 * 1000, // 1 minute
  refreshOnFocus: true,
  maxEntries: 100,
  minRefreshInterval: 10 * 1000, // 10 seconds
};

// Special keys
const DOCUMENT_LIST_KEY = '__document_list__';

// ============ Cache Manager ============

/**
 * Document cache manager with TTL, LRU eviction, and window focus refresh.
 *
 * Usage:
 * ```typescript
 * const cache = new DocumentCacheManager({ listTtl: 60000 });
 *
 * // Cache document list
 * cache.setDocumentList(documents);
 * const cachedList = cache.getDocumentList();
 *
 * // Cache individual document
 * cache.setDocument('doc-123', document);
 * const doc = cache.getDocument('doc-123');
 *
 * // Check freshness
 * if (cache.isStale('doc-123')) {
 *   // Refetch from server
 * }
 *
 * // Invalidate on server event
 * cache.invalidate('doc-123');
 * ```
 */
export class DocumentCacheManager {
  private cache: Map<string, CacheEntry<unknown>> = new Map();
  private accessOrder: string[] = []; // For LRU eviction
  private config: CacheConfig;
  private stats: CacheStats;
  private eventListeners: Set<CacheEventCallback> = new Set();
  private lastFocusRefresh = 0;
  private focusHandler: (() => void) | null = null;
  private visibilityHandler: (() => void) | null = null;
  private refreshCallback: (() => void) | null = null;

  constructor(config: Partial<CacheConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.stats = {
      hits: 0,
      misses: 0,
      entries: 0,
      evictions: 0,
      invalidations: 0,
      focusRefreshes: 0,
    };

    if (this.config.refreshOnFocus && typeof window !== 'undefined') {
      this.setupFocusRefresh();
    }
  }

  // ============ Document List Methods ============

  /**
   * Cache the document list.
   */
  setDocumentList(documents: DocumentMetadata[], ttl?: number): void {
    this.set(DOCUMENT_LIST_KEY, documents, ttl ?? this.config.listTtl);
  }

  /**
   * Get cached document list, or null if not cached or expired.
   */
  getDocumentList(): DocumentMetadata[] | null {
    return this.get<DocumentMetadata[]>(DOCUMENT_LIST_KEY);
  }

  /**
   * Check if document list cache is stale.
   */
  isDocumentListStale(): boolean {
    return this.isStale(DOCUMENT_LIST_KEY);
  }

  /**
   * Get remaining TTL for document list (ms).
   */
  getDocumentListTtl(): number {
    return this.getRemainingTtl(DOCUMENT_LIST_KEY);
  }

  // ============ Individual Document Methods ============

  /**
   * Cache an individual document.
   */
  setDocument(docId: string, document: unknown, ttl?: number, etag?: string): void {
    const key = this.docKey(docId);
    this.set(key, document, ttl ?? this.config.documentTtl, etag);
  }

  /**
   * Get a cached document, or null if not cached or expired.
   */
  getDocument<T>(docId: string): T | null {
    return this.get<T>(this.docKey(docId));
  }

  /**
   * Check if a document cache is stale.
   */
  isDocumentStale(docId: string): boolean {
    return this.isStale(this.docKey(docId));
  }

  /**
   * Get ETag for conditional request.
   */
  getDocumentEtag(docId: string): string | undefined {
    const entry = this.cache.get(this.docKey(docId));
    return entry?.etag;
  }

  // ============ Invalidation Methods ============

  /**
   * Invalidate a specific document cache.
   */
  invalidateDocument(docId: string): void {
    this.invalidate(this.docKey(docId));
  }

  /**
   * Invalidate the document list cache.
   */
  invalidateDocumentList(): void {
    this.invalidate(DOCUMENT_LIST_KEY);
  }

  /**
   * Invalidate all caches.
   */
  invalidateAll(): void {
    const keys = Array.from(this.cache.keys());
    keys.forEach((key) => this.invalidate(key));
  }

  /**
   * Invalidate multiple documents by IDs.
   */
  invalidateDocuments(docIds: string[]): void {
    docIds.forEach((id) => this.invalidateDocument(id));
  }

  // ============ Focus Refresh ============

  /**
   * Set the callback to invoke when cache needs refresh.
   */
  setRefreshCallback(callback: () => void): void {
    this.refreshCallback = callback;
  }

  /**
   * Manually trigger a focus refresh (useful for testing).
   */
  triggerFocusRefresh(): void {
    const now = Date.now();
    if (now - this.lastFocusRefresh < this.config.minRefreshInterval) {
      return;
    }

    this.lastFocusRefresh = now;
    this.stats.focusRefreshes++;

    // Invalidate document list (most likely to be stale)
    this.invalidateDocumentList();

    // Invoke refresh callback
    this.refreshCallback?.();

    this.emit('refresh', DOCUMENT_LIST_KEY);
  }

  // ============ Statistics ============

  /**
   * Get cache statistics.
   */
  getStats(): Readonly<CacheStats> {
    return { ...this.stats, entries: this.cache.size };
  }

  /**
   * Reset statistics (for testing).
   */
  resetStats(): void {
    this.stats = {
      hits: 0,
      misses: 0,
      entries: this.cache.size,
      evictions: 0,
      invalidations: 0,
      focusRefreshes: 0,
    };
  }

  // ============ Event Subscription ============

  /**
   * Subscribe to cache events.
   */
  subscribe(callback: CacheEventCallback): () => void {
    this.eventListeners.add(callback);
    return () => {
      this.eventListeners.delete(callback);
    };
  }

  // ============ Cleanup ============

  /**
   * Clean up event listeners and resources.
   */
  dispose(): void {
    if (this.focusHandler && typeof window !== 'undefined') {
      window.removeEventListener('focus', this.focusHandler);
    }
    if (this.visibilityHandler && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.visibilityHandler);
    }
    this.eventListeners.clear();
    this.cache.clear();
    this.accessOrder = [];
  }

  // ============ Internal Methods ============

  private docKey(docId: string): string {
    return `doc:${docId}`;
  }

  private set<T>(key: string, value: T, ttl: number, etag?: string): void {
    const entry: CacheEntry<T> = {
      value,
      cachedAt: Date.now(),
      ttl,
    };
    if (etag !== undefined) {
      entry.etag = etag;
    }

    // Check if we need to evict
    if (!this.cache.has(key) && this.cache.size >= this.config.maxEntries) {
      this.evictOldest();
    }

    this.cache.set(key, entry);
    this.updateAccessOrder(key);
    this.emit('set', key, value);
  }

  private get<T>(key: string): T | null {
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;

    if (!entry) {
      this.stats.misses++;
      this.emit('miss', key);
      return null;
    }

    // Check if expired
    if (this.isExpired(entry)) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      this.stats.misses++;
      this.emit('expired', key);
      return null;
    }

    this.stats.hits++;
    this.updateAccessOrder(key);
    this.emit('hit', key, entry.value);
    return entry.value;
  }

  private invalidate(key: string): void {
    if (this.cache.has(key)) {
      this.cache.delete(key);
      this.removeFromAccessOrder(key);
      this.stats.invalidations++;
      this.emit('invalidate', key);
    }
  }

  private isStale(key: string): boolean {
    const entry = this.cache.get(key);
    if (!entry) return true;
    return this.isExpired(entry);
  }

  private isExpired(entry: CacheEntry<unknown>): boolean {
    return Date.now() - entry.cachedAt > entry.ttl;
  }

  private getRemainingTtl(key: string): number {
    const entry = this.cache.get(key);
    if (!entry) return 0;

    const remaining = entry.ttl - (Date.now() - entry.cachedAt);
    return Math.max(0, remaining);
  }

  private updateAccessOrder(key: string): void {
    this.removeFromAccessOrder(key);
    this.accessOrder.push(key);
  }

  private removeFromAccessOrder(key: string): void {
    const index = this.accessOrder.indexOf(key);
    if (index !== -1) {
      this.accessOrder.splice(index, 1);
    }
  }

  private evictOldest(): void {
    if (this.accessOrder.length === 0) return;

    const keyToEvict = this.accessOrder.shift()!;
    this.cache.delete(keyToEvict);
    this.stats.evictions++;
    this.emit('evict', keyToEvict);
  }

  private emit(event: CacheEventType, key: string, value?: unknown): void {
    for (const listener of this.eventListeners) {
      try {
        listener(event, key, value);
      } catch (error) {
        console.error('[CacheManager] Event listener error:', error);
      }
    }
  }

  private setupFocusRefresh(): void {
    this.focusHandler = () => {
      this.triggerFocusRefresh();
    };

    this.visibilityHandler = () => {
      if (document.visibilityState === 'visible') {
        this.triggerFocusRefresh();
      }
    };

    window.addEventListener('focus', this.focusHandler);
    document.addEventListener('visibilitychange', this.visibilityHandler);
  }
}

// ============ React Hook ============

/**
 * React hook for document cache integration.
 * 
 * Usage:
 * ```typescript
 * function DocumentList() {
 *   const { documents, isStale, refresh } = useDocumentCache();
 * 
 *   if (isStale) {
 *     // Show "refreshing" indicator
 *   }
 * 
 *   return <List items={documents} />;
 * }
 * ```
 */
export interface UseDocumentCacheOptions {
  /** Auto-fetch on mount (default: true) */
  autoFetch?: boolean;
  /** Fetch function to call when cache is stale */
  fetchFn?: () => Promise<void>;
  /** Cache instance (uses singleton if not provided) */
  cache?: DocumentCacheManager;
}

// ============ Singleton Instance ============

let cacheInstance: DocumentCacheManager | null = null;

/**
 * Get the global cache manager instance.
 */
export function getDocumentCache(): DocumentCacheManager {
  if (!cacheInstance) {
    cacheInstance = new DocumentCacheManager();
  }
  return cacheInstance;
}

/**
 * Initialize with custom configuration.
 */
export function initDocumentCache(config: Partial<CacheConfig>): DocumentCacheManager {
  if (cacheInstance) {
    cacheInstance.dispose();
  }
  cacheInstance = new DocumentCacheManager(config);
  return cacheInstance;
}

/**
 * Reset the cache instance (for testing).
 */
export function resetDocumentCache(): void {
  if (cacheInstance) {
    cacheInstance.dispose();
    cacheInstance = null;
  }
}
