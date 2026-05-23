/**
 * Offline Queue
 *
 * Queues document operations when disconnected from the host.
 * Operations are persisted to storage and processed when reconnected.
 *
 * Supports:
 * - Document save operations
 * - Document delete operations
 * - Automatic retry on reconnection
 * - Conflict resolution via timestamps
 *
 * Phase 14.1.3 Collaboration Overhaul
 */

import type { DiagramDocument } from '../types/Document';

// ============ Types ============

/** Types of operations that can be queued */
export type QueuedOperationType = 'save' | 'delete';

/** Base queued operation */
interface BaseQueuedOperation {
  /** Unique operation ID */
  id: string;
  /** Document ID this operation affects */
  documentId: string;
  /** When the operation was queued */
  timestamp: number;
  /** Number of retry attempts */
  retryCount: number;
  /** Last error message if failed */
  lastError?: string;
  /** Host ID this operation targets */
  relayId: string;
}

/** Queued save operation */
export interface QueuedSaveOperation extends BaseQueuedOperation {
  type: 'save';
  /** Full document to save */
  document: DiagramDocument;
}

/** Queued delete operation */
export interface QueuedDeleteOperation extends BaseQueuedOperation {
  type: 'delete';
  /** Just the document ID (document data not needed) */
}

/** Union of all queued operation types */
export type QueuedOperation = QueuedSaveOperation | QueuedDeleteOperation;

/** Queue processing result */
export interface ProcessResult {
  /** Operation that was processed */
  operation: QueuedOperation;
  /** Whether the operation succeeded */
  success: boolean;
  /** Error message if failed */
  error?: string;
}

/** Queue statistics */
export interface QueueStats {
  /** Total operations in queue */
  total: number;
  /** Save operations count */
  saves: number;
  /** Delete operations count */
  deletes: number;
  /** Oldest operation timestamp */
  oldestTimestamp: number | null;
}

// ============ OfflineQueue ============

/**
 * OfflineQueue manages queued operations for offline-first editing.
 *
 * Usage:
 * ```typescript
 * const queue = new OfflineQueue();
 *
 * // Queue a save operation when offline
 * await queue.enqueueSave(document, relayId);
 *
 * // Process queue when reconnected
 * const results = await queue.processAll(async (op) => {
 *   if (op.type === 'save') {
 *     await provider.saveDocument(op.document);
 *   } else {
 *     await provider.deleteDocument(op.documentId);
 *   }
 * });
 * ```
 */
export class OfflineQueue {
  private queue: Map<string, QueuedOperation> = new Map();
  private processing = false;
  private onChangeCallbacks: Set<() => void> = new Set();

  // ============ Queue Operations ============

  /**
   * Queue a document save operation.
   * If a save for this document already exists, it's replaced (last-write-wins).
   */
  enqueueSave(document: DiagramDocument, relayId: string): QueuedOperation {
    // Remove any existing operation for this document (last-write-wins)
    this.removeByDocumentId(document.id);

    const operation: QueuedSaveOperation = {
      id: this.generateId(),
      type: 'save',
      documentId: document.id,
      document,
      timestamp: Date.now(),
      retryCount: 0,
      relayId,
    };

    this.queue.set(operation.id, operation);
    this.notifyChange();

    console.log('[OfflineQueue] Enqueued save:', document.id);
    return operation;
  }

  /**
   * Queue a document delete operation.
   * Removes any pending save for this document since it will be deleted.
   */
  enqueueDelete(documentId: string, relayId: string): QueuedOperation {
    // Remove any existing operation for this document
    this.removeByDocumentId(documentId);

    const operation: QueuedDeleteOperation = {
      id: this.generateId(),
      type: 'delete',
      documentId,
      timestamp: Date.now(),
      retryCount: 0,
      relayId,
    };

    this.queue.set(operation.id, operation);
    this.notifyChange();

    console.log('[OfflineQueue] Enqueued delete:', documentId);
    return operation;
  }

  /**
   * Remove all operations for a specific document.
   */
  removeByDocumentId(documentId: string): void {
    const toRemove: string[] = [];

    this.queue.forEach((op, id) => {
      if (op.documentId === documentId) {
        toRemove.push(id);
      }
    });

    toRemove.forEach((id) => this.queue.delete(id));

    if (toRemove.length > 0) {
      this.notifyChange();
    }
  }

  /**
   * Remove a specific operation by ID.
   */
  remove(operationId: string): boolean {
    const removed = this.queue.delete(operationId);
    if (removed) {
      this.notifyChange();
    }
    return removed;
  }

  /**
   * Clear all operations from the queue.
   */
  clear(): void {
    this.queue.clear();
    this.notifyChange();
  }

  /**
   * Clear all operations for a specific host.
   */
  clearByHost(relayId: string): void {
    const toRemove: string[] = [];

    this.queue.forEach((op, id) => {
      if (op.relayId === relayId) {
        toRemove.push(id);
      }
    });

    toRemove.forEach((id) => this.queue.delete(id));

    if (toRemove.length > 0) {
      this.notifyChange();
    }
  }

  // ============ Queue Processing ============

  /**
   * Process all operations in the queue.
   * Operations are processed in order of timestamp (oldest first).
   *
   * @param processor - Function that executes each operation
   * @param maxRetries - Maximum retry attempts per operation (default: 3)
   * @returns Results of all processed operations
   */
  async processAll(
    processor: (operation: QueuedOperation) => Promise<void>,
    maxRetries = 3
  ): Promise<ProcessResult[]> {
    if (this.processing) {
      console.log('[OfflineQueue] Already processing, skipping');
      return [];
    }

    this.processing = true;
    const results: ProcessResult[] = [];

    try {
      // Get operations sorted by timestamp (oldest first)
      const operations = this.getOperationsSorted();

      for (const operation of operations) {
        const result = await this.processOperation(operation, processor, maxRetries);
        results.push(result);

        if (result.success) {
          this.queue.delete(operation.id);
        }
      }

      this.notifyChange();
    } finally {
      this.processing = false;
    }

    return results;
  }

  /**
   * Process operations for a specific host only.
   */
  async processForHost(
    relayId: string,
    processor: (operation: QueuedOperation) => Promise<void>,
    maxRetries = 3
  ): Promise<ProcessResult[]> {
    if (this.processing) {
      console.log('[OfflineQueue] Already processing, skipping');
      return [];
    }

    this.processing = true;
    const results: ProcessResult[] = [];

    try {
      // Get operations for this host, sorted by timestamp
      const operations = this.getOperationsSorted().filter((op) => op.relayId === relayId);

      for (const operation of operations) {
        const result = await this.processOperation(operation, processor, maxRetries);
        results.push(result);

        if (result.success) {
          this.queue.delete(operation.id);
        }
      }

      this.notifyChange();
    } finally {
      this.processing = false;
    }

    return results;
  }

  /**
   * Process a single operation with retry logic.
   */
  private async processOperation(
    operation: QueuedOperation,
    processor: (operation: QueuedOperation) => Promise<void>,
    maxRetries: number
  ): Promise<ProcessResult> {
    try {
      await processor(operation);
      console.log('[OfflineQueue] Processed:', operation.type, operation.documentId);
      return { operation, success: true };
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Unknown error';

      // Update retry count
      operation.retryCount++;
      operation.lastError = error;

      if (operation.retryCount >= maxRetries) {
        console.error(
          '[OfflineQueue] Max retries reached for:',
          operation.type,
          operation.documentId,
          error
        );
        return { operation, success: false, error };
      }

      console.warn(
        '[OfflineQueue] Retry',
        operation.retryCount,
        'for:',
        operation.type,
        operation.documentId
      );
      return { operation, success: false, error };
    }
  }

  // ============ Queue Queries ============

  /**
   * Get all operations in the queue.
   */
  getAll(): QueuedOperation[] {
    return Array.from(this.queue.values());
  }

  /**
   * Get operations sorted by timestamp (oldest first).
   */
  getOperationsSorted(): QueuedOperation[] {
    return this.getAll().sort((a, b) => a.timestamp - b.timestamp);
  }

  /**
   * Get operations for a specific document.
   */
  getByDocumentId(documentId: string): QueuedOperation | undefined {
    return this.getAll().find((op) => op.documentId === documentId);
  }

  /**
   * Get operations for a specific host.
   */
  getByHost(relayId: string): QueuedOperation[] {
    return this.getAll().filter((op) => op.relayId === relayId);
  }

  /**
   * Check if there are pending operations for a document.
   */
  hasPendingOperations(documentId: string): boolean {
    return this.getByDocumentId(documentId) !== undefined;
  }

  /**
   * Get queue statistics.
   */
  getStats(): QueueStats {
    const operations = this.getAll();
    let saves = 0;
    let deletes = 0;
    let oldestTimestamp: number | null = null;

    for (const op of operations) {
      if (op.type === 'save') saves++;
      if (op.type === 'delete') deletes++;

      if (oldestTimestamp === null || op.timestamp < oldestTimestamp) {
        oldestTimestamp = op.timestamp;
      }
    }

    return {
      total: operations.length,
      saves,
      deletes,
      oldestTimestamp,
    };
  }

  /**
   * Check if queue is empty.
   */
  isEmpty(): boolean {
    return this.queue.size === 0;
  }

  /**
   * Check if currently processing.
   */
  isProcessing(): boolean {
    return this.processing;
  }

  // ============ Change Notifications ============

  /**
   * Subscribe to queue changes.
   */
  onChange(callback: () => void): () => void {
    this.onChangeCallbacks.add(callback);
    return () => this.onChangeCallbacks.delete(callback);
  }

  private notifyChange(): void {
    this.onChangeCallbacks.forEach((cb) => cb());
  }

  // ============ Serialization ============

  /**
   * Serialize queue to JSON for persistence.
   */
  toJSON(): QueuedOperation[] {
    return this.getAll();
  }

  /**
   * Load queue from serialized JSON.
   */
  fromJSON(operations: QueuedOperation[]): void {
    this.queue.clear();
    for (const op of operations) {
      this.queue.set(op.id, op);
    }
    this.notifyChange();
  }

  // ============ Utilities ============

  private generateId(): string {
    return `op_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;
  }
}

// ============ Singleton Instance ============

/** Global offline queue instance */
let offlineQueueInstance: OfflineQueue | null = null;

/**
 * Get the global offline queue instance.
 */
export function getOfflineQueue(): OfflineQueue {
  if (!offlineQueueInstance) {
    offlineQueueInstance = new OfflineQueue();
  }
  return offlineQueueInstance;
}

/**
 * Reset the offline queue (for testing).
 */
export function resetOfflineQueue(): void {
  offlineQueueInstance = null;
}

export default OfflineQueue;
