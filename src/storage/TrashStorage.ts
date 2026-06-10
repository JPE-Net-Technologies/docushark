/**
 * Soft delete and document recovery utilities.
 *
 * Provides a "trash" system for documents, allowing recovery
 * of recently deleted items. Uses localStorage for tracking
 * deleted documents with metadata.
 */

import type { DiagramDocument, DocumentMetadata } from '../types/Document';

// ============ Storage Keys ============

/** Storage key for trash metadata */
const TRASH_KEY = 'docushark-trash';

/** Storage prefix for trashed documents */
const TRASH_PREFIX = 'docushark-trash-doc-';

// ============ Configuration ============

/** Default retention period in milliseconds (7 days) */
const DEFAULT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

/** Maximum number of items in trash */
const MAX_TRASH_ITEMS = 50;

// ============ Types ============

/**
 * Why a document is in the trash.
 *
 * - `local`    — a personal document the user soft-deleted (category 2).
 * - `stranded` — a relay document hard-deleted out from under us; we kept the
 *   last local copy here rather than wiping it (category 3, JP-175).
 *
 * A future `relay-soft` kind (category 1, a relay-side soft-delete that's still
 * restorable on the server) is intentionally NOT stored here — it lives on the
 * relay and is unioned into the trash view by its own source. See JP-294.
 */
export type TrashKind = 'local' | 'stranded';

/**
 * Provenance for a stranded relay document, so the trash UI can show where it
 * came from (and a future restore-to-relay path has what it needs).
 */
export interface TrashOrigin {
  relayId: string;
  ownerId?: string;
  /** Last time we were in sync with the relay before it was deleted. */
  lastSyncedAt?: number;
}

/**
 * Metadata for a trashed document.
 */
export interface TrashItem {
  /** Original document ID */
  id: string;
  /** Document name */
  name: string;
  /** When the document was deleted */
  deletedAt: number;
  /** When the document will be permanently deleted */
  expiresAt: number;
  /** Original document metadata */
  originalMetadata: DocumentMetadata;
  /**
   * Why this document is in the trash. Optional for backward-compat with items
   * written before JP-291; absent is treated as `'local'`.
   */
  kind?: TrashKind;
  /** Origin of a stranded relay document (kind === 'stranded'). */
  origin?: TrashOrigin;
  /**
   * Blob hashes this document references, snapshotted at trash time. Lets the
   * blob GC keep these blobs alive while the doc sits in trash WITHOUT loading
   * the full document on every sweep (JP-291). Optional for backward-compat;
   * absent falls back to reading the stored document.
   */
  blobReferences?: string[];
}

/** Options for {@link moveToTrash} beyond the legacy `retentionMs` positional. */
export interface MoveToTrashOptions {
  kind?: TrashKind;
  origin?: TrashOrigin;
  /**
   * Blob hashes the document references. When omitted, falls back to the
   * document's own `blobReferences` array. Callers that have the canonical
   * whole-document walk (`collectBlobReferences`) should pass it explicitly.
   */
  blobReferences?: string[];
}

/**
 * Result of a recovery attempt.
 */
export interface RecoveryResult {
  success: boolean;
  document?: DiagramDocument;
  error?: string;
}

// ============ Trash Management ============

/**
 * Get list of items currently in trash.
 */
export function getTrashItems(): TrashItem[] {
  try {
    const json = localStorage.getItem(TRASH_KEY);
    if (!json) return [];

    const items = JSON.parse(json) as TrashItem[];

    // Filter out expired items on read
    const now = Date.now();
    return items.filter((item) => item.expiresAt > now);
  } catch (error) {
    console.error('[Trash] Failed to read trash items:', error);
    return [];
  }
}

/**
 * Get raw trash items without filtering (for cleanup operations).
 */
function getRawTrashItems(): TrashItem[] {
  try {
    const json = localStorage.getItem(TRASH_KEY);
    if (!json) return [];
    return JSON.parse(json) as TrashItem[];
  } catch (error) {
    console.error('[Trash] Failed to read raw trash items:', error);
    return [];
  }
}

/**
 * Save trash items list.
 */
function saveTrashItems(items: TrashItem[]): void {
  try {
    localStorage.setItem(TRASH_KEY, JSON.stringify(items));
  } catch (error) {
    console.error('[Trash] Failed to save trash items:', error);
  }
}

/**
 * Move a document to trash (soft delete).
 *
 * @param doc The document to trash
 * @param metadata The document's metadata
 * @param retentionMs How long to keep in trash (default: 7 days)
 * @returns True if successful
 */
export function moveToTrash(
  doc: DiagramDocument,
  metadata: DocumentMetadata,
  retentionMs: number = DEFAULT_RETENTION_MS,
  options: MoveToTrashOptions = {}
): boolean {
  try {
    const now = Date.now();

    // Save document to trash storage
    const trashKey = `${TRASH_PREFIX}${doc.id}`;
    localStorage.setItem(trashKey, JSON.stringify(doc));

    // Create trash item metadata
    const trashItem: TrashItem = {
      id: doc.id,
      name: doc.name,
      deletedAt: now,
      expiresAt: now + retentionMs,
      originalMetadata: metadata,
      kind: options.kind ?? 'local',
      blobReferences: options.blobReferences ?? doc.blobReferences ?? [],
    };
    if (options.origin) trashItem.origin = options.origin;

    // Add to trash list
    const items = getTrashItems();
    items.unshift(trashItem);

    // Enforce max items (remove oldest beyond limit)
    if (items.length > MAX_TRASH_ITEMS) {
      const removed = items.splice(MAX_TRASH_ITEMS);
      // Permanently delete overflow items
      for (const item of removed) {
        permanentlyDeleteTrashItem(item.id);
      }
    }

    saveTrashItems(items);
    return true;
  } catch (error) {
    console.error('[Trash] Failed to move document to trash:', error);
    return false;
  }
}

/**
 * Recover a document from trash.
 *
 * @param id The document ID to recover
 * @returns Recovery result with document if successful
 */
export function recoverFromTrash(id: string): RecoveryResult {
  try {
    // Load document from trash storage
    const trashKey = `${TRASH_PREFIX}${id}`;
    const json = localStorage.getItem(trashKey);

    if (!json) {
      return { success: false, error: 'Document not found in trash' };
    }

    const doc = JSON.parse(json) as DiagramDocument;

    // Remove from trash
    removeFromTrashList(id);
    localStorage.removeItem(trashKey);

    return { success: true, document: doc };
  } catch (error) {
    console.error('[Trash] Failed to recover document:', error);
    return { success: false, error: 'Failed to recover document' };
  }
}

/**
 * Permanently delete a document from trash.
 *
 * @param id The document ID to permanently delete
 * @returns True if successful
 */
export function permanentlyDeleteFromTrash(id: string): boolean {
  try {
    removeFromTrashList(id);
    permanentlyDeleteTrashItem(id);
    return true;
  } catch (error) {
    console.error('[Trash] Failed to permanently delete:', error);
    return false;
  }
}

/**
 * Empty the entire trash (permanent delete all).
 *
 * @returns Number of items deleted
 */
export function emptyTrash(): number {
  const items = getTrashItems();
  let deleted = 0;

  for (const item of items) {
    try {
      permanentlyDeleteTrashItem(item.id);
      deleted++;
    } catch (error) {
      console.error(`[Trash] Failed to delete ${item.id}:`, error);
    }
  }

  saveTrashItems([]);
  return deleted;
}

/**
 * Clean up expired trash items.
 * Call this periodically to free storage.
 *
 * @returns Number of items cleaned up
 */
export function cleanupExpiredTrash(): number {
  const items = getRawTrashItems(); // Use raw items to see expired ones
  const now = Date.now();
  let cleaned = 0;

  const validItems: TrashItem[] = [];

  for (const item of items) {
    if (item.expiresAt <= now) {
      // Expired - permanently delete
      try {
        permanentlyDeleteTrashItem(item.id);
        cleaned++;
      } catch (error) {
        console.error(`[Trash] Failed to cleanup ${item.id}:`, error);
      }
    } else {
      validItems.push(item);
    }
  }

  if (cleaned > 0) {
    saveTrashItems(validItems);
  }

  return cleaned;
}

/**
 * Get a single trash item by ID.
 */
export function getTrashItem(id: string): TrashItem | undefined {
  return getTrashItems().find((item) => item.id === id);
}

/**
 * Check if a document is in trash.
 */
export function isInTrash(id: string): boolean {
  return getTrashItems().some((item) => item.id === id);
}

/**
 * Get the number of items in trash.
 */
export function getTrashCount(): number {
  return getTrashItems().length;
}

/**
 * Read the full stored document for a trashed item, without recovering it
 * (leaves it in trash). Returns null if the bytes aren't present.
 */
export function getStoredTrashDocument(id: string): DiagramDocument | null {
  try {
    const json = localStorage.getItem(`${TRASH_PREFIX}${id}`);
    return json ? (JSON.parse(json) as DiagramDocument) : null;
  } catch (error) {
    console.error('[Trash] Failed to read stored trash document:', error);
    return null;
  }
}

/**
 * Collect every blob hash referenced by the documents currently in trash.
 *
 * This is the trash half of the blob GC mark-set (JP-291): the
 * `BlobGarbageCollector` is scan-based off the *active* document index, so a
 * trashed document would otherwise lose its blobs on the next sweep. Unioning
 * this into the mark-set keeps a trashed doc's blobs alive until it's purged,
 * emptied, or expires — at which point it leaves this set and the next sweep
 * reclaims them.
 *
 * Reads each item's snapshotted `blobReferences` (cheap); only falls back to
 * loading the stored document for legacy items written before JP-291.
 */
export function getTrashedBlobReferences(): Set<string> {
  const refs = new Set<string>();
  for (const item of getTrashItems()) {
    if (item.blobReferences) {
      item.blobReferences.forEach((hash) => refs.add(hash));
    } else {
      const doc = getStoredTrashDocument(item.id);
      doc?.blobReferences?.forEach((hash) => refs.add(hash));
    }
  }
  return refs;
}

// ============ Internal Helpers ============

/**
 * Remove an item from the trash list (but not storage).
 */
function removeFromTrashList(id: string): void {
  const items = getTrashItems();
  const filtered = items.filter((item) => item.id !== id);
  saveTrashItems(filtered);
}

/**
 * Permanently delete the document data from trash storage.
 */
function permanentlyDeleteTrashItem(id: string): void {
  const trashKey = `${TRASH_PREFIX}${id}`;
  localStorage.removeItem(trashKey);
}
