import type { BlobMetadata, StorageStats } from './BlobTypes';
import { QuotaExceededError, BlobStorageError } from './BlobTypes';
import type { CustomShapeItem } from './ShapeLibraryTypes';

/**
 * IndexedDB database name and version.
 */
const DB_NAME = 'diagrammer-blobs';
const DB_VERSION = 2; // Bumped for shape_library_items store

/**
 * Object store names.
 */
const STORE_BLOBS = 'blobs';
const STORE_METADATA = 'blob_metadata';
const STORE_SHAPE_ITEMS = 'shape_library_items';

/**
 * Blob storage implementation using IndexedDB.
 *
 * Features:
 * - Content-addressed storage (SHA-256 hash as ID)
 * - Automatic deduplication
 * - Reference counting for garbage collection
 * - Efficient metadata querying
 *
 * Usage:
 * ```typescript
 * const id = await blobStorage.saveBlob(blob, 'image.png');
 * const loaded = await blobStorage.loadBlob(id);
 * ```
 */
export class BlobStorage {
  private static instance: BlobStorage;
  private db: IDBDatabase | null = null;
  private initPromise: Promise<void> | null = null;

  private constructor() {
    // Private constructor for singleton
  }

  /**
   * Get the singleton instance of BlobStorage.
   */
  static getInstance(): BlobStorage {
    if (!BlobStorage.instance) {
      BlobStorage.instance = new BlobStorage();
    }
    return BlobStorage.instance;
  }

  /**
   * Save a blob to storage.
   *
   * Automatically handles:
   * - Content hashing (SHA-256)
   * - Deduplication (same content = same ID)
   * - Reference counting
   * - Proactive quota checking
   *
   * @param blob - Blob to save
   * @param name - Original filename
   * @returns Blob ID (SHA-256 hash)
   * @throws QuotaExceededError if storage quota is exceeded
   * @throws BlobStorageError if save operation fails
   */
  async saveBlob(blob: Blob, name: string): Promise<string> {
    await this.ensureDB();

    try {
      // Compute content hash
      const id = await this.computeHash(blob);

      // Check if blob already exists
      const existing = await this.getBlobMetadata(id);
      if (existing) {
        // Increment usage count
        await this.incrementUsageCount(id);
        return id;
      }

      // Proactive quota check before saving new blob
      await this.checkQuotaBeforeSave(blob.size);

      // Save blob data
      await this.saveBlobData(id, blob);

      // Save metadata
      const metadata: BlobMetadata = {
        id,
        type: blob.type,
        size: blob.size,
        name,
        createdAt: Date.now(),
        usageCount: 1,
      };
      await this.saveBlobMetadata(metadata);

      return id;
    } catch (error) {
      if (error instanceof Error && error.name === 'QuotaExceededError') {
        throw new QuotaExceededError('Storage quota exceeded. Please delete unused images.');
      }
      throw new BlobStorageError('Failed to save blob', error as Error);
    }
  }

  /**
   * Check storage quota before saving a blob.
   * Throws QuotaExceededError if there's not enough space.
   */
  private async checkQuotaBeforeSave(blobSize: number): Promise<void> {
    const stats = await this.getStorageStats();

    // Calculate what percentage would be used after adding this blob
    const newUsed = stats.used + blobSize;
    const newPercentUsed = stats.available > 0 ? (newUsed / stats.available) * 100 : 100;

    // Reject if this would exceed 98% of quota (leave 2% buffer)
    if (newPercentUsed >= 98) {
      throw new QuotaExceededError(
        `Not enough storage space. Need ${this.formatBytes(blobSize)}, only ${this.formatBytes(stats.available - stats.used)} available.`
      );
    }
  }

  /**
   * Format bytes as human-readable string.
   */
  private formatBytes(bytes: number): string {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
  }

  /**
   * Load a blob from storage.
   *
   * @param id - Blob ID (SHA-256 hash)
   * @returns Blob or null if not found
   * @throws BlobStorageError if load operation fails
   */
  async loadBlob(id: string): Promise<Blob | null> {
    await this.ensureDB();

    try {
      const blob = await new Promise<Blob | null>((resolve, reject) => {
        const transaction = this.db!.transaction([STORE_BLOBS], 'readonly');
        const store = transaction.objectStore(STORE_BLOBS);
        const request = store.get(id);

        request.onsuccess = () => {
          const record = request.result;
          resolve(record ? record.data : null);
        };

        request.onerror = () => reject(request.error);
      });

      if (!blob) return null;

      // Reconstruct blob with correct MIME type from metadata if lost during
      // IndexedDB serialization (common in Tauri/WebKitGTK environments)
      if (!blob.type || blob.type === 'application/octet-stream') {
        try {
          const metadata = await this.getBlobMetadata(id);
          if (metadata?.type && metadata.type !== 'application/octet-stream') {
            return new Blob([blob], { type: metadata.type });
          }
        } catch {
          // Metadata lookup failure is non-fatal
        }
      }

      return blob;
    } catch (error) {
      console.error('Failed to load blob:', id, error);
      return null; // Graceful degradation
    }
  }

  /**
   * Delete a blob from storage.
   *
   * WARNING: Does NOT check reference count. Use with caution.
   * Typically called by garbage collector, not directly.
   *
   * @param id - Blob ID to delete
   * @throws BlobStorageError if delete operation fails
   */
  async deleteBlob(id: string): Promise<void> {
    await this.ensureDB();

    try {
      // Delete blob data
      await new Promise<void>((resolve, reject) => {
        const transaction = this.db!.transaction([STORE_BLOBS], 'readwrite');
        const store = transaction.objectStore(STORE_BLOBS);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });

      // Delete metadata
      await new Promise<void>((resolve, reject) => {
        const transaction = this.db!.transaction([STORE_METADATA], 'readwrite');
        const store = transaction.objectStore(STORE_METADATA);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      throw new BlobStorageError(`Failed to delete blob: ${id}`, error as Error);
    }
  }

  /**
   * Get metadata for a blob without loading blob data.
   * Useful for listing blobs and checking existence.
   *
   * @param id - Blob ID
   * @returns Metadata or null if not found
   */
  async getBlobMetadata(id: string): Promise<BlobMetadata | null> {
    await this.ensureDB();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_METADATA], 'readonly');
      const store = transaction.objectStore(STORE_METADATA);
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * List all blob metadata.
   * Does not load blob data (efficient for large collections).
   *
   * @returns Array of all blob metadata
   */
  async listAllBlobs(): Promise<BlobMetadata[]> {
    await this.ensureDB();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_METADATA], 'readonly');
      const store = transaction.objectStore(STORE_METADATA);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Get storage usage statistics.
   *
   * Note: On Linux (WebKitGTK), navigator.storage.estimate() may return 0 for quota.
   * In this case, we fall back to a reasonable default (5GB) for desktop apps.
   *
   * @returns Storage stats with used/available bytes and percentage
   */
  async getStorageStats(): Promise<StorageStats> {
    // Default fallback for desktop apps when web API doesn't work (e.g., WebKitGTK on Linux)
    const DEFAULT_QUOTA_FALLBACK = 5 * 1024 * 1024 * 1024; // 5GB

    if (!navigator.storage || !navigator.storage.estimate) {
      // API not available - use fallback for desktop
      const isDesktop = '__TAURI__' in window || '__TAURI_INTERNALS__' in window;
      return {
        used: 0,
        available: isDesktop ? DEFAULT_QUOTA_FALLBACK : 0,
        percentUsed: 0,
      };
    }

    try {
      const estimate = await navigator.storage.estimate();
      const used = estimate.usage || 0;
      let available = estimate.quota || 0;

      // WebKitGTK on Linux returns 0 for quota - use fallback
      if (available === 0) {
        const isDesktop = '__TAURI__' in window || '__TAURI_INTERNALS__' in window;
        if (isDesktop) {
          available = DEFAULT_QUOTA_FALLBACK;
        }
      }

      const percentUsed = available > 0 ? (used / available) * 100 : 0;

      return { used, available, percentUsed };
    } catch (error) {
      console.error('Failed to get storage stats:', error);
      const isDesktop = '__TAURI__' in window || '__TAURI_INTERNALS__' in window;
      return {
        used: 0,
        available: isDesktop ? DEFAULT_QUOTA_FALLBACK : 0,
        percentUsed: 0,
      };
    }
  }

  /**
   * Increment usage count for a blob.
   * Called when the same blob is uploaded multiple times.
   *
   * @param id - Blob ID
   */
  async incrementUsageCount(id: string): Promise<void> {
    const metadata = await this.getBlobMetadata(id);
    if (!metadata) return;

    metadata.usageCount++;
    await this.saveBlobMetadata(metadata);
  }

  /**
   * Decrement usage count for a blob.
   * Called when a document referencing the blob is deleted.
   *
   * @param id - Blob ID
   */
  async decrementUsageCount(id: string): Promise<void> {
    const metadata = await this.getBlobMetadata(id);
    if (!metadata) return;

    metadata.usageCount = Math.max(0, metadata.usageCount - 1);
    await this.saveBlobMetadata(metadata);
  }

  /**
   * Set usage count for a blob directly.
   * Used by recalculate function to set accurate counts.
   *
   * @param id - Blob ID
   * @param count - New usage count
   */
  async setUsageCount(id: string, count: number): Promise<void> {
    const metadata = await this.getBlobMetadata(id);
    if (!metadata) return;

    metadata.usageCount = Math.max(0, count);
    await this.saveBlobMetadata(metadata);
  }

  /**
   * Check if IndexedDB is supported in the current browser.
   *
   * @returns true if IndexedDB is available
   */
  static isSupported(): boolean {
    return typeof window !== 'undefined' && 'indexedDB' in window && window.indexedDB !== null;
  }

  // Shape Library Item Methods

  /**
   * Save a custom shape item to storage.
   *
   * @param item - Shape item to save
   * @returns Item ID
   * @throws BlobStorageError if save operation fails
   */
  async saveShapeItem(item: CustomShapeItem): Promise<string> {
    await this.ensureDB();

    try {
      return new Promise((resolve, reject) => {
        const transaction = this.db!.transaction([STORE_SHAPE_ITEMS], 'readwrite');
        const store = transaction.objectStore(STORE_SHAPE_ITEMS);
        const request = store.put(item);

        request.onsuccess = () => resolve(item.id);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      throw new BlobStorageError('Failed to save shape item', error as Error);
    }
  }

  /**
   * Load a shape item from storage.
   *
   * @param id - Shape item ID
   * @returns Shape item or null if not found
   */
  async loadShapeItem(id: string): Promise<CustomShapeItem | null> {
    await this.ensureDB();

    try {
      return new Promise((resolve, reject) => {
        const transaction = this.db!.transaction([STORE_SHAPE_ITEMS], 'readonly');
        const store = transaction.objectStore(STORE_SHAPE_ITEMS);
        const request = store.get(id);

        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      console.error('Failed to load shape item:', id, error);
      return null;
    }
  }

  /**
   * Delete a shape item from storage.
   *
   * @param id - Shape item ID to delete
   * @throws BlobStorageError if delete operation fails
   */
  async deleteShapeItem(id: string): Promise<void> {
    await this.ensureDB();

    try {
      return new Promise((resolve, reject) => {
        const transaction = this.db!.transaction([STORE_SHAPE_ITEMS], 'readwrite');
        const store = transaction.objectStore(STORE_SHAPE_ITEMS);
        const request = store.delete(id);

        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
      });
    } catch (error) {
      throw new BlobStorageError(`Failed to delete shape item: ${id}`, error as Error);
    }
  }

  /**
   * List all shape items in a specific library.
   *
   * @param libraryId - Library ID to filter by
   * @returns Array of shape items in the library
   */
  async listShapeItemsByLibrary(libraryId: string): Promise<CustomShapeItem[]> {
    await this.ensureDB();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_SHAPE_ITEMS], 'readonly');
      const store = transaction.objectStore(STORE_SHAPE_ITEMS);
      const index = store.index('libraryId');
      const request = index.getAll(libraryId);

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * List all shape items in storage.
   *
   * @returns Array of all shape items
   */
  async listAllShapeItems(): Promise<CustomShapeItem[]> {
    await this.ensureDB();

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_SHAPE_ITEMS], 'readonly');
      const store = transaction.objectStore(STORE_SHAPE_ITEMS);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Delete all shape items for a specific library.
   *
   * @param libraryId - Library ID to delete items for
   */
  async deleteShapeItemsByLibrary(libraryId: string): Promise<void> {
    const items = await this.listShapeItemsByLibrary(libraryId);
    for (const item of items) {
      await this.deleteShapeItem(item.id);
    }
  }

  // Private methods

  /**
   * Ensure database is initialized.
   * Uses singleton pattern to avoid multiple initialization.
   */
  private async ensureDB(): Promise<void> {
    if (this.db) return;

    // If initialization is in progress, wait for it
    if (this.initPromise) {
      return this.initPromise;
    }

    // Start initialization
    this.initPromise = this.initDB();
    await this.initPromise;
    this.initPromise = null;
  }

  /**
   * Initialize IndexedDB database.
   * Creates object stores and indexes on first run.
   */
  private async initDB(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create blobs object store
        if (!db.objectStoreNames.contains(STORE_BLOBS)) {
          db.createObjectStore(STORE_BLOBS, { keyPath: 'id' });
        }

        // Create blob_metadata object store with indexes
        if (!db.objectStoreNames.contains(STORE_METADATA)) {
          const metadataStore = db.createObjectStore(STORE_METADATA, { keyPath: 'id' });
          metadataStore.createIndex('createdAt', 'createdAt', { unique: false });
          metadataStore.createIndex('usageCount', 'usageCount', { unique: false });
        }

        // Create shape_library_items object store with indexes (v2)
        if (!db.objectStoreNames.contains(STORE_SHAPE_ITEMS)) {
          const shapeStore = db.createObjectStore(STORE_SHAPE_ITEMS, { keyPath: 'id' });
          shapeStore.createIndex('libraryId', 'libraryId', { unique: false });
          shapeStore.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };

      request.onsuccess = () => {
        this.db = request.result;

        // Handle database errors
        this.db.onerror = (event) => {
          console.error('IndexedDB error:', event);
        };

        resolve();
      };

      request.onerror = () => {
        reject(new BlobStorageError('Failed to open IndexedDB', request.error as Error));
      };

      request.onblocked = () => {
        console.warn('IndexedDB blocked - close other tabs using this app');
      };
    });
  }

  /**
   * Compute SHA-256 hash of blob content.
   * Used as content-addressed ID for deduplication.
   *
   * @param blob - Blob to hash
   * @returns Hex-encoded SHA-256 hash
   */
  private async computeHash(blob: Blob): Promise<string> {
    const buffer = await blob.arrayBuffer();
    const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  /**
   * Save blob data to IndexedDB.
   *
   * @param id - Blob ID
   * @param blob - Blob data
   */
  private async saveBlobData(id: string, blob: Blob): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_BLOBS], 'readwrite');
      const store = transaction.objectStore(STORE_BLOBS);
      const request = store.put({ id, data: blob });

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  /**
   * Save blob metadata to IndexedDB.
   *
   * @param metadata - Blob metadata
   */
  private async saveBlobMetadata(metadata: BlobMetadata): Promise<void> {
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_METADATA], 'readwrite');
      const store = transaction.objectStore(STORE_METADATA);
      const request = store.put(metadata);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }
}

/**
 * Singleton instance of BlobStorage.
 * Use this instance throughout the application.
 */
export const blobStorage = BlobStorage.getInstance();
