/**
 * Sync Queue Storage
 *
 * Persists the offline queue to IndexedDB for durability across browser sessions.
 * Operations survive page refreshes and browser restarts.
 *
 * Phase 14.1.3 Collaboration Overhaul
 */

import type { QueuedOperation } from '../collaboration/OfflineQueue';

// ============ Constants ============

const DB_NAME = 'docushark-sync-queue';
const DB_VERSION = 1;
const STORE_NAME = 'operations';

// ============ Types ============

/** Storage operation result */
interface StorageResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

// ============ SyncQueueStorage ============

/**
 * SyncQueueStorage manages IndexedDB persistence for the offline queue.
 *
 * Usage:
 * ```typescript
 * const storage = new SyncQueueStorage();
 *
 * // Save an operation
 * await storage.save(operation);
 *
 * // Load all operations
 * const operations = await storage.loadAll();
 *
 * // Remove processed operations
 * await storage.remove(operationId);
 * ```
 */
export class SyncQueueStorage {
  private db: IDBDatabase | null = null;
  private dbPromise: Promise<IDBDatabase> | null = null;

  // ============ Database Setup ============

  /**
   * Open or create the IndexedDB database.
   */
  private async openDatabase(): Promise<IDBDatabase> {
    // Return existing connection
    if (this.db) {
      return this.db;
    }

    // Return pending connection
    if (this.dbPromise) {
      return this.dbPromise;
    }

    // Create new connection
    this.dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => {
        console.error('[SyncQueueStorage] Failed to open database:', request.error);
        this.dbPromise = null;
        reject(new Error('Failed to open sync queue database'));
      };

      request.onsuccess = () => {
        this.db = request.result;
        this.dbPromise = null;

        // Handle database closing
        this.db.onclose = () => {
          this.db = null;
        };

        resolve(this.db);
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;

        // Create operations store if it doesn't exist
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });

          // Indexes for efficient queries
          store.createIndex('documentId', 'documentId', { unique: false });
          store.createIndex('relayId', 'relayId', { unique: false });
          store.createIndex('timestamp', 'timestamp', { unique: false });
        }
      };
    });

    return this.dbPromise;
  }

  /**
   * Close the database connection.
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ============ CRUD Operations ============

  /**
   * Save an operation to storage.
   * Overwrites existing operation with same ID.
   */
  async save(operation: QueuedOperation): Promise<StorageResult<void>> {
    try {
      const db = await this.openDatabase();

      return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        const request = store.put(operation);

        request.onerror = () => {
          console.error('[SyncQueueStorage] Failed to save operation:', request.error);
          resolve({ success: false, error: request.error?.message ?? 'Save failed' });
        };

        request.onsuccess = () => {
          resolve({ success: true });
        };
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Database error';
      console.error('[SyncQueueStorage] Save error:', error);
      return { success: false, error };
    }
  }

  /**
   * Save multiple operations in a single transaction.
   */
  async saveAll(operations: QueuedOperation[]): Promise<StorageResult<void>> {
    if (operations.length === 0) {
      return { success: true };
    }

    try {
      const db = await this.openDatabase();

      return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        transaction.onerror = () => {
          console.error('[SyncQueueStorage] Transaction error:', transaction.error);
          resolve({ success: false, error: transaction.error?.message ?? 'Transaction failed' });
        };

        transaction.oncomplete = () => {
          resolve({ success: true });
        };

        for (const operation of operations) {
          store.put(operation);
        }
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Database error';
      console.error('[SyncQueueStorage] SaveAll error:', error);
      return { success: false, error };
    }
  }

  /**
   * Load a single operation by ID.
   */
  async load(operationId: string): Promise<StorageResult<QueuedOperation>> {
    try {
      const db = await this.openDatabase();

      return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.get(operationId);

        request.onerror = () => {
          console.error('[SyncQueueStorage] Failed to load operation:', request.error);
          resolve({ success: false, error: request.error?.message ?? 'Load failed' });
        };

        request.onsuccess = () => {
          if (request.result) {
            resolve({ success: true, data: request.result as QueuedOperation });
          } else {
            resolve({ success: false, error: 'Operation not found' });
          }
        };
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Database error';
      console.error('[SyncQueueStorage] Load error:', error);
      return { success: false, error };
    }
  }

  /**
   * Load all operations from storage.
   */
  async loadAll(): Promise<StorageResult<QueuedOperation[]>> {
    try {
      const db = await this.openDatabase();

      return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        request.onerror = () => {
          console.error('[SyncQueueStorage] Failed to load operations:', request.error);
          resolve({ success: false, error: request.error?.message ?? 'Load failed' });
        };

        request.onsuccess = () => {
          resolve({ success: true, data: request.result as QueuedOperation[] });
        };
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Database error';
      console.error('[SyncQueueStorage] LoadAll error:', error);
      return { success: false, error };
    }
  }

  /**
   * Load operations for a specific host.
   */
  async loadByHost(relayId: string): Promise<StorageResult<QueuedOperation[]>> {
    try {
      const db = await this.openDatabase();

      return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('relayId');
        const request = index.getAll(relayId);

        request.onerror = () => {
          console.error('[SyncQueueStorage] Failed to load by host:', request.error);
          resolve({ success: false, error: request.error?.message ?? 'Load failed' });
        };

        request.onsuccess = () => {
          resolve({ success: true, data: request.result as QueuedOperation[] });
        };
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Database error';
      console.error('[SyncQueueStorage] LoadByHost error:', error);
      return { success: false, error };
    }
  }

  /**
   * Load operations for a specific document.
   */
  async loadByDocument(documentId: string): Promise<StorageResult<QueuedOperation[]>> {
    try {
      const db = await this.openDatabase();

      return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('documentId');
        const request = index.getAll(documentId);

        request.onerror = () => {
          console.error('[SyncQueueStorage] Failed to load by document:', request.error);
          resolve({ success: false, error: request.error?.message ?? 'Load failed' });
        };

        request.onsuccess = () => {
          resolve({ success: true, data: request.result as QueuedOperation[] });
        };
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Database error';
      console.error('[SyncQueueStorage] LoadByDocument error:', error);
      return { success: false, error };
    }
  }

  /**
   * Remove an operation by ID.
   */
  async remove(operationId: string): Promise<StorageResult<void>> {
    try {
      const db = await this.openDatabase();

      return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.delete(operationId);

        request.onerror = () => {
          console.error('[SyncQueueStorage] Failed to remove operation:', request.error);
          resolve({ success: false, error: request.error?.message ?? 'Remove failed' });
        };

        request.onsuccess = () => {
          resolve({ success: true });
        };
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Database error';
      console.error('[SyncQueueStorage] Remove error:', error);
      return { success: false, error };
    }
  }

  /**
   * Remove multiple operations by IDs.
   */
  async removeAll(operationIds: string[]): Promise<StorageResult<void>> {
    if (operationIds.length === 0) {
      return { success: true };
    }

    try {
      const db = await this.openDatabase();

      return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);

        transaction.onerror = () => {
          console.error('[SyncQueueStorage] Transaction error:', transaction.error);
          resolve({ success: false, error: transaction.error?.message ?? 'Transaction failed' });
        };

        transaction.oncomplete = () => {
          resolve({ success: true });
        };

        for (const id of operationIds) {
          store.delete(id);
        }
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Database error';
      console.error('[SyncQueueStorage] RemoveAll error:', error);
      return { success: false, error };
    }
  }

  /**
   * Remove all operations for a specific host.
   */
  async clearByHost(relayId: string): Promise<StorageResult<void>> {
    try {
      // First load all operations for this host
      const loadResult = await this.loadByHost(relayId);
      if (!loadResult.success || !loadResult.data) {
        return { success: false, error: loadResult.error ?? 'Failed to load operations' };
      }

      // Then remove them
      const ids = loadResult.data.map((op) => op.id);
      return this.removeAll(ids);
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Database error';
      console.error('[SyncQueueStorage] ClearByHost error:', error);
      return { success: false, error };
    }
  }

  /**
   * Clear all operations from storage.
   */
  async clearAll(): Promise<StorageResult<void>> {
    try {
      const db = await this.openDatabase();

      return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.clear();

        request.onerror = () => {
          console.error('[SyncQueueStorage] Failed to clear storage:', request.error);
          resolve({ success: false, error: request.error?.message ?? 'Clear failed' });
        };

        request.onsuccess = () => {
          resolve({ success: true });
        };
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Database error';
      console.error('[SyncQueueStorage] ClearAll error:', error);
      return { success: false, error };
    }
  }

  /**
   * Get the count of operations in storage.
   */
  async count(): Promise<StorageResult<number>> {
    try {
      const db = await this.openDatabase();

      return new Promise((resolve) => {
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.count();

        request.onerror = () => {
          console.error('[SyncQueueStorage] Failed to count operations:', request.error);
          resolve({ success: false, error: request.error?.message ?? 'Count failed' });
        };

        request.onsuccess = () => {
          resolve({ success: true, data: request.result });
        };
      });
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Database error';
      console.error('[SyncQueueStorage] Count error:', error);
      return { success: false, error };
    }
  }
}

// ============ Singleton Instance ============

/** Global sync queue storage instance */
let storageInstance: SyncQueueStorage | null = null;

/**
 * Get the global sync queue storage instance.
 */
export function getSyncQueueStorage(): SyncQueueStorage {
  if (!storageInstance) {
    storageInstance = new SyncQueueStorage();
  }
  return storageInstance;
}

/**
 * Reset the storage instance (for testing).
 */
export function resetSyncQueueStorage(): void {
  if (storageInstance) {
    storageInstance.close();
  }
  storageInstance = null;
}

export default SyncQueueStorage;
