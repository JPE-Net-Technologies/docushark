/**
 * FileContentCache — LRU cache for file content object URLs.
 *
 * Caches blob content as object URLs to avoid repeated IndexedDB lookups.
 * Implements LRU (Least Recently Used) eviction when size limit is reached.
 *
 * Memory management:
 * - Tracks size of each cached blob
 * - Evicts oldest entries when maxSize is exceeded
 * - Properly revokes object URLs on eviction
 */

interface CacheEntry {
  objectUrl: string;
  size: number;
  lastAccessed: number;
}

/** Default maximum cache size: 100MB */
const DEFAULT_MAX_SIZE = 100 * 1024 * 1024;

/**
 * LRU cache for file content with size-based eviction.
 */
class FileContentCache {
  private cache = new Map<string, CacheEntry>();
  private currentSize = 0;
  private maxSize: number;

  constructor(maxSize: number = DEFAULT_MAX_SIZE) {
    this.maxSize = maxSize;
  }

  /**
   * Get a cached object URL for a blob reference.
   * Returns null if not cached.
   * Updates last accessed time on hit.
   */
  get(blobRef: string): string | null {
    const entry = this.cache.get(blobRef);
    if (!entry) return null;

    // Update last accessed time
    entry.lastAccessed = Date.now();
    return entry.objectUrl;
  }

  /**
   * Add a blob to the cache.
   * Returns the object URL for the blob.
   * May trigger eviction if size limit is exceeded.
   *
   * @param blobRef - The blob reference (SHA-256 hash)
   * @param blob - The blob content
   * @returns The object URL
   */
  set(blobRef: string, blob: Blob): string {
    // Check if already cached
    const existing = this.cache.get(blobRef);
    if (existing) {
      existing.lastAccessed = Date.now();
      return existing.objectUrl;
    }

    // Evict entries if needed to make room
    while (this.currentSize + blob.size > this.maxSize && this.cache.size > 0) {
      this.evictLRU();
    }

    // If single blob is larger than max size, don't cache it
    if (blob.size > this.maxSize) {
      return URL.createObjectURL(blob);
    }

    // Create object URL and cache
    const objectUrl = URL.createObjectURL(blob);
    const entry: CacheEntry = {
      objectUrl,
      size: blob.size,
      lastAccessed: Date.now(),
    };

    this.cache.set(blobRef, entry);
    this.currentSize += blob.size;

    return objectUrl;
  }

  /**
   * Explicitly evict a specific entry from the cache.
   * Useful when a file is replaced or deleted.
   */
  evict(blobRef: string): void {
    const entry = this.cache.get(blobRef);
    if (!entry) return;

    URL.revokeObjectURL(entry.objectUrl);
    this.currentSize -= entry.size;
    this.cache.delete(blobRef);
  }

  /**
   * Clear the entire cache.
   * Revokes all object URLs.
   */
  clear(): void {
    for (const entry of this.cache.values()) {
      URL.revokeObjectURL(entry.objectUrl);
    }
    this.cache.clear();
    this.currentSize = 0;
  }

  /**
   * Get current cache statistics.
   */
  getStats(): { size: number; count: number; maxSize: number } {
    return {
      size: this.currentSize,
      count: this.cache.size,
      maxSize: this.maxSize,
    };
  }

  /**
   * Update the maximum cache size.
   * May trigger evictions if new size is smaller.
   */
  setMaxSize(maxSize: number): void {
    this.maxSize = maxSize;
    while (this.currentSize > this.maxSize && this.cache.size > 0) {
      this.evictLRU();
    }
  }

  /**
   * Evict the least recently used entry.
   */
  private evictLRU(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, entry] of this.cache.entries()) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.evict(oldestKey);
    }
  }
}

// Singleton instance
let instance: FileContentCache | null = null;

/**
 * Get the singleton FileContentCache instance.
 */
export function getFileContentCache(): FileContentCache {
  if (!instance) {
    instance = new FileContentCache();
  }
  return instance;
}

/**
 * Reset the cache instance (for testing).
 */
export function resetFileContentCache(): void {
  if (instance) {
    instance.clear();
    instance = null;
  }
}

export { FileContentCache };
