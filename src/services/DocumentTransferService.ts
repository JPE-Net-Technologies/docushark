/**
 * Document Transfer Service
 *
 * Provides atomic document transfers between personal and team storage.
 * Uses a two-phase commit pattern to prevent orphaned or inconsistent documents.
 *
 * The transfer process:
 * 1. PREPARE phase: Validate preconditions, create backup state
 * 2. EXECUTE phase: Perform the actual transfer operations
 * 3. COMMIT/ROLLBACK: Finalize or revert based on success
 *
 * This ensures that a document is never lost during transfer, even if
 * the operation is interrupted (e.g., network failure, app crash).
 *
 * Phase 14.9.2 - Data Integrity Improvements
 */

import type { DiagramDocument, DocumentMetadata } from '../types/Document';
import { getDocumentMetadata } from '../types/Document';

// ============ Types ============

/** Transfer direction */
export type TransferDirection = 'to-relay' | 'to-personal';

/** Transfer state for tracking in-progress transfers */
export type TransferState = 
  | 'idle'
  | 'preparing'
  | 'prepared'
  | 'executing'
  | 'committing'
  | 'committed'
  | 'rolling-back'
  | 'rolled-back'
  | 'failed';

/** Transfer operation record for recovery */
export interface TransferRecord {
  /** Unique transfer ID */
  id: string;
  /** Document being transferred */
  documentId: string;
  /** Direction of transfer */
  direction: TransferDirection;
  /** Current state of transfer */
  state: TransferState;
  /** Original document snapshot (for rollback) */
  originalDocument: DiagramDocument;
  /** Timestamp when transfer started */
  startedAt: number;
  /** Timestamp when transfer completed (success or failure) */
  completedAt?: number;
  /** Error message if failed */
  error?: string;
}

/** Transfer result */
export interface TransferResult {
  success: boolean;
  /** The transferred document (with updated fields) */
  document?: DiagramDocument;
  /** Error message if failed */
  error?: string;
  /** Whether rollback was performed */
  rolledBack?: boolean;
}

/** Transfer options */
export interface TransferOptions {
  /** Callback for progress updates */
  onProgress?: (state: TransferState) => void;
  /** Timeout for remote operations (ms, default: 30000) */
  timeout?: number;
  /** Skip server sync (for testing) */
  skipServerSync?: boolean;
}

/** Dependencies for transfer service */
export interface TransferServiceDeps {
  /** Load document from local storage */
  loadDocument: (id: string) => DiagramDocument | null;
  /** Save document to local storage */
  saveDocument: (doc: DiagramDocument) => void;
  /** Get current user info */
  getCurrentUser: () => { id: string; displayName: string } | null;
  /** Save to team host */
  saveToHost: (doc: DiagramDocument) => Promise<void>;
  /** Delete from team host */
  deleteFromHost: (docId: string) => Promise<void>;
  /** Check if authenticated with host */
  isAuthenticated: () => boolean;
  /** Update metadata in store */
  updateMetadata: (docId: string, metadata: DocumentMetadata) => void;
  /**
   * Ensure every blob the document references is present in local storage
   * (downloading any missing). Resolves true only when all are local. Gates the
   * relay→personal delete so the move never orphans blobs that lived only on the
   * relay. Optional: when absent the check is skipped (e.g. tests / no blob sync).
   */
  ensureBlobsAvailableLocally?: (doc: DiagramDocument) => Promise<boolean>;
}

// ============ Constants ============

const TRANSFER_STORAGE_KEY = 'docushark-pending-transfer';
const DEFAULT_TIMEOUT = 30000;

// ============ Transfer Service ============

/**
 * Service for atomic document transfers.
 *
 * Usage:
 * ```typescript
 * const service = new DocumentTransferService(deps);
 *
 * // Transfer to team
 * const result = await service.transferToTeam('doc-123');
 *
 * // Transfer to personal
 * const result = await service.transferToPersonal('doc-456');
 *
 * // Recover interrupted transfer on startup
 * await service.recoverPendingTransfer();
 * ```
 */
export class DocumentTransferService {
  private deps: TransferServiceDeps;
  private currentTransfer: TransferRecord | null = null;

  constructor(deps: TransferServiceDeps) {
    this.deps = deps;
  }

  /**
   * Transfer a personal document to team storage.
   */
  async transferToTeam(
    docId: string,
    options: TransferOptions = {}
  ): Promise<TransferResult> {
    return this.executeTransfer(docId, 'to-relay', options);
  }

  /**
   * Transfer a relay document to personal storage.
   */
  async transferToPersonal(
    docId: string,
    options: TransferOptions = {}
  ): Promise<TransferResult> {
    return this.executeTransfer(docId, 'to-personal', options);
  }

  /**
   * Check for and recover any interrupted transfers.
   * Call this on application startup.
   */
  async recoverPendingTransfer(): Promise<TransferResult | null> {
    const record = this.loadPendingTransfer();
    if (!record) {
      return null;
    }

    console.log('[TransferService] Found pending transfer:', record.id, record.state);

    // Determine recovery action based on state
    switch (record.state) {
      case 'preparing':
      case 'prepared':
        // Never started execution - just clean up
        this.clearPendingTransfer();
        return { success: true, document: record.originalDocument };

      case 'executing':
      case 'committing':
        // Was in progress - attempt rollback
        console.log('[TransferService] Rolling back interrupted transfer');
        return this.rollback(record);

      case 'rolling-back':
        // Rollback was interrupted - try again
        return this.rollback(record);

      case 'committed':
      case 'rolled-back':
      case 'failed':
        // Already completed - just clean up
        this.clearPendingTransfer();
        return null;

      default:
        this.clearPendingTransfer();
        return null;
    }
  }

  /**
   * Get the current transfer state (if any).
   */
  getCurrentTransfer(): TransferRecord | null {
    return this.currentTransfer;
  }

  /**
   * Check if a transfer is in progress.
   */
  isTransferInProgress(): boolean {
    return this.currentTransfer !== null &&
      !['idle', 'committed', 'rolled-back', 'failed'].includes(this.currentTransfer.state);
  }

  // ============ Internal Methods ============

  /**
   * Execute a transfer with two-phase commit.
   */
  private async executeTransfer(
    docId: string,
    direction: TransferDirection,
    options: TransferOptions
  ): Promise<TransferResult> {
    const { onProgress, timeout = DEFAULT_TIMEOUT, skipServerSync = false } = options;

    // Prevent concurrent transfers
    if (this.isTransferInProgress()) {
      return { success: false, error: 'Another transfer is in progress' };
    }

    // PHASE 1: PREPARE
    onProgress?.('preparing');
    
    const prepareResult = this.prepare(docId, direction);
    if (!prepareResult.success) {
      return prepareResult;
    }

    const record = this.currentTransfer!;
    onProgress?.('prepared');

    // PHASE 2: EXECUTE
    onProgress?.('executing');
    this.updateTransferState('executing');

    try {
      const executeResult = await this.execute(record, skipServerSync, timeout);
      if (!executeResult.success) {
        // Carry the reason into the record so rollback surfaces *why* (e.g. blobs
        // couldn't be secured) instead of a generic failure.
        if (executeResult.error !== undefined) record.error = executeResult.error;
        onProgress?.('rolling-back');
        return this.rollback(record);
      }

      // PHASE 3: COMMIT
      onProgress?.('committing');
      this.updateTransferState('committing');

      const commitResult = this.commit(record);
      onProgress?.('committed');

      return commitResult;
    } catch (error) {
      console.error('[TransferService] Transfer failed:', error);
      onProgress?.('rolling-back');
      return this.rollback(record);
    }
  }

  /**
   * PHASE 1: Prepare for transfer.
   * Validates preconditions and creates backup state.
   */
  private prepare(
    docId: string,
    direction: TransferDirection
  ): TransferResult {
    // Load the document
    const doc = this.deps.loadDocument(docId);
    if (!doc) {
      return { success: false, error: `Document ${docId} not found` };
    }

    // Validate direction
    if (direction === 'to-relay' && doc.isRelayDocument) {
      return { success: false, error: 'Document is already a relay document' };
    }
    if (direction === 'to-personal' && !doc.isRelayDocument) {
      return { success: false, error: 'Document is already a personal document' };
    }

    // Create transfer record with deep copy for rollback
    const record: TransferRecord = {
      id: `transfer_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      documentId: docId,
      direction,
      state: 'preparing',
      originalDocument: JSON.parse(JSON.stringify(doc)),
      startedAt: Date.now(),
    };

    // Persist for crash recovery
    this.currentTransfer = record;
    this.savePendingTransfer(record);
    this.updateTransferState('prepared');

    return { success: true };
  }

  /**
   * PHASE 2: Execute the transfer.
   * Performs the actual document updates and server sync.
   */
  private async execute(
    record: TransferRecord,
    skipServerSync: boolean,
    timeout: number
  ): Promise<TransferResult> {
    const doc = this.deps.loadDocument(record.documentId);
    if (!doc) {
      return { success: false, error: 'Document disappeared during transfer' };
    }

    if (record.direction === 'to-relay') {
      return this.executeToTeam(doc, skipServerSync, timeout);
    } else {
      return this.executeToPersonal(doc, skipServerSync, timeout);
    }
  }

  /**
   * Execute transfer to team.
   */
  private async executeToTeam(
    doc: DiagramDocument,
    skipServerSync: boolean,
    timeout: number
  ): Promise<TransferResult> {
    // Get current user for ownership
    const currentUser = this.deps.getCurrentUser();

    // Update team fields
    const updatedDoc: DiagramDocument = {
      ...doc,
      isRelayDocument: true,
      modifiedAt: Date.now(),
      ...(currentUser?.id !== undefined ? { 
        ownerId: currentUser.id,
        lastModifiedBy: currentUser.id,
      } : {}),
      ...(currentUser?.displayName !== undefined ? {
        ownerName: currentUser.displayName,
        lastModifiedByName: currentUser.displayName,
      } : {}),
    };

    // Save locally first
    this.deps.saveDocument(updatedDoc);

    // Sync to server (with timeout)
    if (!skipServerSync && this.deps.isAuthenticated()) {
      try {
        await Promise.race([
          this.deps.saveToHost(updatedDoc),
          this.timeoutPromise(timeout, 'Server sync timed out'),
        ]);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Server sync failed';
        return { success: false, error: message };
      }
    }

    return { success: true, document: updatedDoc };
  }

  /**
   * Execute transfer to personal.
   */
  private async executeToPersonal(
    doc: DiagramDocument,
    skipServerSync: boolean,
    timeout: number
  ): Promise<TransferResult> {
    // Secure the document's blobs locally BEFORE deleting the relay copy.
    // Otherwise the personal doc keeps blob:// refs whose bytes live only on the
    // relay, and the delete orphans them irreversibly. If they can't all be
    // downloaded, abort the move (no delete) so nothing is lost — the caller
    // surfaces the failure and the relay copy stays intact.
    if (!skipServerSync && this.deps.ensureBlobsAvailableLocally) {
      let blobsSecured = false;
      try {
        blobsSecured = await this.deps.ensureBlobsAvailableLocally(doc);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to download files';
        return { success: false, error: `Could not download all files locally: ${message}` };
      }
      if (!blobsSecured) {
        return {
          success: false,
          error:
            'Could not download all of this document’s files for offline use. ' +
            'Move cancelled so nothing is lost — try again while online.',
        };
      }
    }

    // Delete from server first (if authenticated)
    if (!skipServerSync && this.deps.isAuthenticated()) {
      try {
        await Promise.race([
          this.deps.deleteFromHost(doc.id),
          this.timeoutPromise(timeout, 'Server delete timed out'),
        ]);
      } catch (error) {
        // Log but continue - we still want to make it personal locally
        console.warn('[TransferService] Failed to delete from host:', error);
      }
    }

    // Clear team-specific fields
    const updatedDoc: DiagramDocument = {
      ...doc,
      isRelayDocument: false,
      modifiedAt: Date.now(),
    };
    // Remove team fields
    delete updatedDoc.ownerId;
    delete updatedDoc.ownerName;
    delete updatedDoc.lockedBy;
    delete updatedDoc.lockedByName;
    delete updatedDoc.lockedAt;
    delete updatedDoc.sharedWith;
    delete updatedDoc.lastModifiedBy;
    delete updatedDoc.lastModifiedByName;

    // Save locally
    this.deps.saveDocument(updatedDoc);

    return { success: true, document: updatedDoc };
  }

  /**
   * PHASE 3: Commit the transfer.
   * Finalizes the transfer and updates metadata.
   */
  private commit(record: TransferRecord): TransferResult {
    const doc = this.deps.loadDocument(record.documentId);
    if (!doc) {
      return { success: false, error: 'Document disappeared during commit' };
    }

    // Update metadata in store
    const metadata = getDocumentMetadata(doc);
    this.deps.updateMetadata(record.documentId, metadata);

    // Mark complete
    record.state = 'committed';
    record.completedAt = Date.now();
    this.clearPendingTransfer();
    this.currentTransfer = null;

    console.log('[TransferService] Transfer committed:', record.id);

    return { success: true, document: doc };
  }

  /**
   * Rollback a failed or interrupted transfer.
   */
  private async rollback(record: TransferRecord): Promise<TransferResult> {
    this.updateTransferState('rolling-back');

    try {
      // Restore original document
      this.deps.saveDocument(record.originalDocument);

      // Update metadata
      const metadata = getDocumentMetadata(record.originalDocument);
      this.deps.updateMetadata(record.documentId, metadata);

      // If we were transferring to team and synced, try to delete from server
      if (record.direction === 'to-relay' && this.deps.isAuthenticated()) {
        try {
          await this.deps.deleteFromHost(record.documentId);
        } catch {
          // Ignore - best effort cleanup
        }
      }

      record.state = 'rolled-back';
      record.completedAt = Date.now();
      this.clearPendingTransfer();
      this.currentTransfer = null;

      console.log('[TransferService] Transfer rolled back:', record.id);

      return {
        success: false,
        error: `${record.error ?? 'Transfer failed'} (rolled back)`,
        document: record.originalDocument,
        rolledBack: true,
      };
    } catch (error) {
      record.state = 'failed';
      record.error = error instanceof Error ? error.message : 'Rollback failed';
      record.completedAt = Date.now();
      this.clearPendingTransfer();
      this.currentTransfer = null;

      console.error('[TransferService] Rollback failed:', error);

      return {
        success: false,
        error: `Transfer and rollback both failed: ${record.error}`,
        rolledBack: false,
      };
    }
  }

  // ============ Helper Methods ============

  private updateTransferState(state: TransferState): void {
    if (this.currentTransfer) {
      this.currentTransfer.state = state;
      this.savePendingTransfer(this.currentTransfer);
    }
  }

  private savePendingTransfer(record: TransferRecord): void {
    try {
      localStorage.setItem(TRANSFER_STORAGE_KEY, JSON.stringify(record));
    } catch (error) {
      console.error('[TransferService] Failed to save transfer state:', error);
    }
  }

  private loadPendingTransfer(): TransferRecord | null {
    try {
      const json = localStorage.getItem(TRANSFER_STORAGE_KEY);
      if (!json) return null;
      return JSON.parse(json) as TransferRecord;
    } catch {
      return null;
    }
  }

  private clearPendingTransfer(): void {
    try {
      localStorage.removeItem(TRANSFER_STORAGE_KEY);
    } catch {
      // Ignore
    }
  }

  private timeoutPromise(ms: number, message: string): Promise<never> {
    return new Promise((_, reject) => {
      setTimeout(() => reject(new Error(message)), ms);
    });
  }
}

// ============ Singleton Instance ============

let serviceInstance: DocumentTransferService | null = null;

/**
 * Get the global transfer service instance.
 * Must be initialized with dependencies first.
 */
export function getTransferService(): DocumentTransferService | null {
  return serviceInstance;
}

/**
 * Initialize the transfer service with dependencies.
 */
export function initTransferService(deps: TransferServiceDeps): DocumentTransferService {
  serviceInstance = new DocumentTransferService(deps);
  return serviceInstance;
}

/**
 * Reset the transfer service (for testing).
 */
export function resetTransferService(): void {
  serviceInstance = null;
}
