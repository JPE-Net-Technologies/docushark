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
  retentionMs: number = DEFAULT_RETENTION_MS
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
    };

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
