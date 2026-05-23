/**
 * Version Conflict Detection and Resolution
 *
 * Implements optimistic locking for document saves to prevent
 * silent data overwrites when multiple clients edit the same document.
 *
 * Phase 14.9.2 - Data Integrity Improvements
 */

import type { DiagramDocument } from './Document';

// ============ Types ============

/**
 * Version information for a document.
 * Tracks both local edits and server-confirmed versions.
 */
export interface DocumentVersion {
  /** Server-confirmed version number (increments on successful remote save) */
  serverVersion: number;
  /** Local version for optimistic updates (increments on local save) */
  localVersion: number;
  /** ETag or hash for content-based versioning (optional) */
  etag?: string;
  /** Timestamp of last successful sync with server */
  lastSyncedAt?: number;
}

/**
 * Version conflict information when a save fails due to stale data.
 */
export interface VersionConflict {
  /** Document ID that has a conflict */
  documentId: string;
  /** The local document state being saved */
  localDocument: DiagramDocument;
  /** The server's current document state */
  serverDocument: DiagramDocument;
  /** Local version at time of save attempt */
  localVersion: number;
  /** Server version that caused the conflict */
  serverVersion: number;
  /** When the conflict was detected */
  detectedAt: number;
}

/**
 * Resolution strategy chosen by the user.
 */
export type ConflictResolution =
  | 'overwrite'    // Force save local version, discarding server changes
  | 'reload'       // Discard local changes, reload from server
  | 'merge'        // Attempt automatic merge (if possible)
  | 'save-as-copy' // Save local version as a new document
  | 'cancel';      // Cancel the operation, keep editing

/**
 * Result of a version-checked save operation.
 */
export type VersionedSaveResult =
  | { success: true; newVersion: number }
  | { success: false; conflict: VersionConflict };

// ============ Error Classes ============

/**
 * Error thrown when attempting to save a document with a stale version.
 */
export class VersionConflictError extends Error {
  public readonly conflict: VersionConflict;

  constructor(conflict: VersionConflict) {
    super(
      `Version conflict for document "${conflict.documentId}": ` +
      `local version ${conflict.localVersion} vs server version ${conflict.serverVersion}`
    );
    this.name = 'VersionConflictError';
    this.conflict = conflict;
  }
}

/**
 * Error thrown when document version is missing or invalid.
 */
export class InvalidVersionError extends Error {
  constructor(documentId: string, reason: string) {
    super(`Invalid version for document "${documentId}": ${reason}`);
    this.name = 'InvalidVersionError';
  }
}

// ============ Version Tracking Store ============

/**
 * In-memory store for tracking document versions.
 * Separate from document content to allow lightweight version checks.
 */
const versionStore = new Map<string, DocumentVersion>();

/**
 * Get the tracked version for a document.
 */
export function getDocumentVersion(documentId: string): DocumentVersion | undefined {
  return versionStore.get(documentId);
}

/**
 * Set or update the tracked version for a document.
 */
export function setDocumentVersion(documentId: string, version: DocumentVersion): void {
  versionStore.set(documentId, version);
}

/**
 * Initialize version tracking for a document.
 * Call when loading a document from storage or server.
 */
export function initializeVersion(
  documentId: string,
  serverVersion: number,
  etag?: string
): DocumentVersion {
  const version: DocumentVersion = {
    serverVersion,
    localVersion: serverVersion,
    lastSyncedAt: Date.now(),
    ...(etag !== undefined ? { etag } : {}),
  };
  versionStore.set(documentId, version);
  return version;
}

/**
 * Increment local version after a local edit.
 * Does not change server version until save is confirmed.
 */
export function incrementLocalVersion(documentId: string): number {
  const version = versionStore.get(documentId);
  if (!version) {
    // Initialize with version 1 if not tracked
    const newVersion = initializeVersion(documentId, 0);
    newVersion.localVersion = 1;
    return 1;
  }
  version.localVersion++;
  return version.localVersion;
}

/**
 * Confirm a successful save by updating server version.
 */
export function confirmSave(
  documentId: string,
  newServerVersion: number,
  etag?: string
): void {
  const version = versionStore.get(documentId);
  if (version) {
    version.serverVersion = newServerVersion;
    version.localVersion = newServerVersion;
    version.lastSyncedAt = Date.now();
    if (etag !== undefined) {
      version.etag = etag;
    }
  } else {
    initializeVersion(documentId, newServerVersion, etag);
  }
}

/**
 * Check if a document has unsaved local changes.
 */
export function hasUnsavedChanges(documentId: string): boolean {
  const version = versionStore.get(documentId);
  if (!version) return false;
  return version.localVersion > version.serverVersion;
}

/**
 * Check if the local version is stale compared to a server version.
 */
export function isVersionStale(documentId: string, serverVersion: number): boolean {
  const version = versionStore.get(documentId);
  if (!version) return false;
  return version.serverVersion < serverVersion;
}

/**
 * Clear version tracking for a document (e.g., on delete or close).
 */
export function clearDocumentVersion(documentId: string): void {
  versionStore.delete(documentId);
}

/**
 * Clear all version tracking (for testing or reset).
 */
export function clearAllVersions(): void {
  versionStore.clear();
}

// ============ Version Check Utilities ============

/**
 * Create a version conflict object for UI handling.
 */
export function createVersionConflict(
  localDocument: DiagramDocument,
  serverDocument: DiagramDocument,
  localVersion: number,
  serverVersion: number
): VersionConflict {
  return {
    documentId: localDocument.id,
    localDocument,
    serverDocument,
    localVersion,
    serverVersion,
    detectedAt: Date.now(),
  };
}

/**
 * Check if save should proceed based on versions.
 * Returns true if safe to save, false if conflict detected.
 */
export function canSaveWithVersion(
  documentId: string,
  expectedServerVersion: number
): boolean {
  const version = versionStore.get(documentId);
  if (!version) {
    // No version tracking - allow save (first save)
    return true;
  }
  // Safe to save if our known server version matches expected
  return version.serverVersion === expectedServerVersion;
}

/**
 * Get a summary of version state for debugging.
 */
export function getVersionSummary(documentId: string): string {
  const version = versionStore.get(documentId);
  if (!version) {
    return `Document ${documentId}: not tracked`;
  }
  const dirty = version.localVersion > version.serverVersion ? ' (dirty)' : '';
  const lastSync = version.lastSyncedAt
    ? ` synced ${Math.round((Date.now() - version.lastSyncedAt) / 1000)}s ago`
    : '';
  return `Document ${documentId}: local=${version.localVersion} server=${version.serverVersion}${dirty}${lastSync}`;
}

// ============ Conflict Resolution Helpers ============

/**
 * Describe what will happen with each resolution option.
 */
export function getResolutionDescription(resolution: ConflictResolution): string {
  switch (resolution) {
    case 'overwrite':
      return 'Replace server version with your changes. Other users\' changes will be lost.';
    case 'reload':
      return 'Discard your changes and load the latest version from server.';
    case 'merge':
      return 'Attempt to combine your changes with the server version.';
    case 'save-as-copy':
      return 'Save your version as a new document, keeping both versions.';
    case 'cancel':
      return 'Cancel and continue editing. You can try saving again later.';
  }
}

/**
 * Check if automatic merge is possible for a conflict.
 * Currently returns false - merge logic would need shape-level diff.
 */
export function canAutoMerge(_conflict: VersionConflict): boolean {
  // TODO(JP-15): Implement shape-level diffing for smart merge
  // For now, automatic merge is not supported
  return false;
}
