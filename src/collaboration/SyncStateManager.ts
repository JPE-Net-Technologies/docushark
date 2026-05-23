/**
 * Sync State Manager
 *
 * Coordinates synchronization between offline queue, persistent storage,
 * and the connection provider. Handles:
 *
 * - Loading queued operations on startup
 * - Persisting new operations to storage
 * - Processing queue when connection is restored
 * - Updating document registry sync states
 *
 * Phase 14.1.3 Collaboration Overhaul
 */

import {
  OfflineQueue,
  getOfflineQueue,
  type QueuedOperation,
  type ProcessResult,
} from './OfflineQueue';
import {
  SyncQueueStorage,
  getSyncQueueStorage,
} from '../storage/SyncQueueStorage';
import { useDocumentRegistry } from '../store/documentRegistry';
import { useConnectionStore, type ConnectionStatus } from '../store/connectionStore';
import type { DiagramDocument } from '../types/Document';

/**
 * Minimal provider surface this manager needs. Any object implementing
 * save+delete works — historically `UnifiedSyncProvider`, now (20.3
 * Slice E.2) the REST adapter.
 */
export interface SyncStateProvider {
  saveDocument(document: DiagramDocument, expectedVersion?: number): Promise<unknown>;
  deleteDocument(docId: string): Promise<unknown>;
  /** True when the provider can dispatch requests right now. */
  isReady(): boolean;
}

// ============ Types ============

/** Sync state manager options */
export interface SyncStateManagerOptions {
  /** Maximum retry attempts for failed operations */
  maxRetries?: number;
  /** Auto-process queue on reconnection (default: true) */
  autoProcessOnReconnect?: boolean;
  /** Callback when sync starts processing */
  onSyncStart?: () => void;
  /** Callback when sync completes */
  onSyncComplete?: (results: ProcessResult[]) => void;
  /** Callback when operation is queued */
  onOperationQueued?: (operation: QueuedOperation) => void;
  /** Callback when error occurs */
  onError?: (error: string) => void;
}

/** Sync manager state */
export interface SyncManagerState {
  /** Whether manager is initialized */
  initialized: boolean;
  /** Whether currently syncing */
  syncing: boolean;
  /** Number of pending operations */
  pendingCount: number;
  /** Last sync timestamp */
  lastSyncAt: number | null;
  /** Last error message */
  lastError: string | null;
}

// ============ SyncStateManager ============

/**
 * SyncStateManager coordinates offline-first synchronization.
 *
 * Usage:
 * ```typescript
 * const manager = new SyncStateManager({
 *   autoProcessOnReconnect: true,
 *   onSyncComplete: (results) => console.log('Synced:', results.length)
 * });
 *
 * // Initialize on app startup
 * await manager.initialize();
 *
 * // Set provider when connected
 * manager.setProvider(unifiedSyncProvider);
 *
 * // Queue operations when offline
 * manager.queueSave(document, relayId);
 *
 * // Process queue manually
 * await manager.processQueue();
 * ```
 */
export class SyncStateManager {
  private queue: OfflineQueue;
  private storage: SyncQueueStorage;
  private provider: SyncStateProvider | null = null;
  private options: Required<SyncStateManagerOptions>;
  private state: SyncManagerState;

  private unsubscribeConnection: (() => void) | null = null;
  private unsubscribeQueue: (() => void) | null = null;

  constructor(options: SyncStateManagerOptions = {}) {
    this.queue = getOfflineQueue();
    this.storage = getSyncQueueStorage();

    this.options = {
      maxRetries: options.maxRetries ?? 3,
      autoProcessOnReconnect: options.autoProcessOnReconnect ?? true,
      onSyncStart: options.onSyncStart ?? (() => {}),
      onSyncComplete: options.onSyncComplete ?? (() => {}),
      onOperationQueued: options.onOperationQueued ?? (() => {}),
      onError: options.onError ?? (() => {}),
    };

    this.state = {
      initialized: false,
      syncing: false,
      pendingCount: 0,
      lastSyncAt: null,
      lastError: null,
    };
  }

  // ============ Lifecycle ============

  /**
   * Initialize the sync manager.
   * Loads persisted queue and sets up listeners.
   */
  async initialize(): Promise<void> {
    if (this.state.initialized) {
      console.log('[SyncStateManager] Already initialized');
      return;
    }

    console.log('[SyncStateManager] Initializing...');

    // Load persisted operations
    const result = await this.storage.loadAll();
    if (result.success && result.data) {
      this.queue.fromJSON(result.data);
      this.state.pendingCount = result.data.length;
      console.log('[SyncStateManager] Loaded', result.data.length, 'queued operations');
    }

    // Subscribe to queue changes for persistence
    this.unsubscribeQueue = this.queue.onChange(() => {
      this.persistQueue();
      this.state.pendingCount = this.queue.getAll().length;
    });

    // Subscribe to connection state changes
    let prevStatus = useConnectionStore.getState().status;
    this.unsubscribeConnection = useConnectionStore.subscribe((state) => {
      const status = state.status;
      if (status !== prevStatus) {
        this.handleConnectionChange(status, prevStatus);
        prevStatus = status;
      }
    });

    this.state.initialized = true;
    console.log('[SyncStateManager] Initialized');
  }

  /**
   * Destroy the sync manager and clean up.
   */
  destroy(): void {
    if (this.unsubscribeConnection) {
      this.unsubscribeConnection();
      this.unsubscribeConnection = null;
    }

    if (this.unsubscribeQueue) {
      this.unsubscribeQueue();
      this.unsubscribeQueue = null;
    }

    this.provider = null;
    this.state.initialized = false;
  }

  // ============ Provider Management ============

  /**
   * Set the sync provider for processing operations.
   */
  setProvider(provider: SyncStateProvider | null): void {
    this.provider = provider;
  }

  /**
   * Get the current provider.
   */
  getProvider(): SyncStateProvider | null {
    return this.provider;
  }

  // ============ Queue Operations ============

  /**
   * Queue a document save operation.
   * Updates document registry sync state.
   */
  queueSave(document: DiagramDocument, relayId: string): QueuedOperation {
    const operation = this.queue.enqueueSave(document, relayId);

    // Update registry sync state
    const registry = useDocumentRegistry.getState();
    if (registry.hasDocument(document.id)) {
      registry.setSyncState(document.id, 'pending');
    }

    // Update cached document state
    if (registry.hasDocument(document.id) && registry.isRemoteDocument(document.id)) {
      registry.incrementPendingChanges(document.id);
    }

    this.options.onOperationQueued(operation);
    return operation;
  }

  /**
   * Queue a document delete operation.
   */
  queueDelete(documentId: string, relayId: string): QueuedOperation {
    const operation = this.queue.enqueueDelete(documentId, relayId);

    this.options.onOperationQueued(operation);
    return operation;
  }

  /**
   * Check if there are pending operations for a document.
   */
  hasPendingChanges(documentId: string): boolean {
    return this.queue.hasPendingOperations(documentId);
  }

  /**
   * Get pending operation count.
   */
  getPendingCount(): number {
    return this.state.pendingCount;
  }

  /**
   * Get current state.
   */
  getState(): SyncManagerState {
    return { ...this.state };
  }

  // ============ Sync Processing ============

  /**
   * Process all queued operations.
   */
  async processQueue(): Promise<ProcessResult[]> {
    if (!this.provider || !this.provider.isReady()) {
      console.log('[SyncStateManager] Cannot process queue: not connected');
      return [];
    }

    if (this.state.syncing) {
      console.log('[SyncStateManager] Already syncing');
      return [];
    }

    this.state.syncing = true;
    this.state.lastError = null;
    this.options.onSyncStart();

    console.log('[SyncStateManager] Processing queue...');

    try {
      const results = await this.queue.processAll(
        async (operation) => {
          await this.processOperation(operation);
        },
        this.options.maxRetries
      );

      // Update registry states for processed documents
      const registry = useDocumentRegistry.getState();
      for (const result of results) {
        if (result.success) {
          if (result.operation.type === 'save') {
            registry.setSyncState(result.operation.documentId, 'synced');
            registry.resetPendingChanges(result.operation.documentId);
          }
        } else {
          registry.setSyncState(result.operation.documentId, 'error');
        }
      }

      this.state.lastSyncAt = Date.now();
      this.state.syncing = false;

      console.log('[SyncStateManager] Processed', results.length, 'operations');
      this.options.onSyncComplete(results);

      return results;
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Sync failed';
      this.state.lastError = error;
      this.state.syncing = false;
      this.options.onError(error);

      console.error('[SyncStateManager] Sync error:', error);
      return [];
    }
  }

  /**
   * Process queued operations for a specific host.
   */
  async processQueueForHost(relayId: string): Promise<ProcessResult[]> {
    if (!this.provider || !this.provider.isReady()) {
      console.log('[SyncStateManager] Cannot process queue: not connected');
      return [];
    }

    if (this.state.syncing) {
      console.log('[SyncStateManager] Already syncing');
      return [];
    }

    this.state.syncing = true;
    this.state.lastError = null;
    this.options.onSyncStart();

    console.log('[SyncStateManager] Processing queue for host:', relayId);

    try {
      const results = await this.queue.processForHost(
        relayId,
        async (operation) => {
          await this.processOperation(operation);
        },
        this.options.maxRetries
      );

      // Update registry states
      const registry = useDocumentRegistry.getState();
      for (const result of results) {
        if (result.success) {
          if (result.operation.type === 'save') {
            registry.setSyncState(result.operation.documentId, 'synced');
            registry.resetPendingChanges(result.operation.documentId);
          }
        } else {
          registry.setSyncState(result.operation.documentId, 'error');
        }
      }

      this.state.lastSyncAt = Date.now();
      this.state.syncing = false;

      console.log('[SyncStateManager] Processed', results.length, 'operations for host');
      this.options.onSyncComplete(results);

      return results;
    } catch (e) {
      const error = e instanceof Error ? e.message : 'Sync failed';
      this.state.lastError = error;
      this.state.syncing = false;
      this.options.onError(error);

      console.error('[SyncStateManager] Sync error:', error);
      return [];
    }
  }

  /**
   * Process a single operation via the provider.
   */
  private async processOperation(operation: QueuedOperation): Promise<void> {
    if (!this.provider) {
      throw new Error('No provider available');
    }

    if (operation.type === 'save') {
      await this.provider.saveDocument(operation.document);
    } else if (operation.type === 'delete') {
      await this.provider.deleteDocument(operation.documentId);
    }
  }

  // ============ Connection Handling ============

  /**
   * Handle connection status changes.
   */
  private handleConnectionChange(status: ConnectionStatus, prevStatus: ConnectionStatus): void {
    console.log('[SyncStateManager] Connection changed:', prevStatus, '->', status);

    if (status === 'authenticated' && prevStatus !== 'authenticated') {
      // Connection restored
      if (this.options.autoProcessOnReconnect && !this.queue.isEmpty()) {
        console.log('[SyncStateManager] Connection restored, processing queue...');
        this.processQueue().catch((e) => {
          console.error('[SyncStateManager] Auto-process failed:', e);
        });
      }
    }

    if (status === 'disconnected' && prevStatus === 'authenticated') {
      // Connection lost - convert remote documents to cached
      this.handleDisconnection();
    }
  }

  /**
   * Handle disconnection - convert remote docs to cached state.
   */
  private handleDisconnection(): void {
    const registry = useDocumentRegistry.getState();
    const relayId = useConnectionStore.getState().host?.address;

    if (!relayId) return;

    // Get all remote documents for this host
    const remoteDocs = registry.getRemoteDocuments(relayId);

    // Convert to cached state
    for (const doc of remoteDocs) {
      registry.convertToCached(doc.id);
    }

    console.log('[SyncStateManager] Converted', remoteDocs.length, 'documents to cached state');
  }

  // ============ Persistence ============

  /**
   * Persist current queue to storage.
   */
  private async persistQueue(): Promise<void> {
    const operations = this.queue.toJSON();

    // Save all operations
    const result = await this.storage.saveAll(operations);
    if (!result.success) {
      console.error('[SyncStateManager] Failed to persist queue:', result.error);
    }
  }

  /**
   * Clear persisted queue.
   */
  async clearPersistedQueue(): Promise<void> {
    await this.storage.clearAll();
  }
}

// ============ Singleton Instance ============

/** Global sync state manager instance */
let managerInstance: SyncStateManager | null = null;

/**
 * Get the global sync state manager instance.
 */
export function getSyncStateManager(options?: SyncStateManagerOptions): SyncStateManager {
  if (!managerInstance) {
    managerInstance = new SyncStateManager(options);
  }
  return managerInstance;
}

/**
 * Reset the manager instance (for testing).
 */
export function resetSyncStateManager(): void {
  if (managerInstance) {
    managerInstance.destroy();
  }
  managerInstance = null;
}

export default SyncStateManager;
