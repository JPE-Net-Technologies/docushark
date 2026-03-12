/**
 * Shared type definitions for the archive system.
 *
 * Used by both the full application backup (Phase 16.7) and
 * the future per-document archive export (Phase 16.8).
 */

// ---------------------------------------------------------------------------
// Archive Manifest
// ---------------------------------------------------------------------------

/**
 * Archive types supported by the system.
 * - 'diagrammer-backup': Full application backup (all documents, blobs, settings)
 * - 'diagrammer-document-archive': Single document with its referenced blobs
 */
export type ArchiveType = 'diagrammer-backup' | 'diagrammer-document-archive';

/**
 * Manifest embedded in every archive ZIP as `manifest.json`.
 * Describes the archive contents and provides integrity checksums.
 */
export interface ArchiveManifest {
  /** Schema version for the manifest format itself. */
  version: 1;
  /** Distinguishes full backup from per-document archive. */
  type: ArchiveType;
  /** When the archive was created (epoch ms). */
  createdAt: number;
  /** Application version that created the archive (from package.json). */
  appVersion: string;
  /** Summary of what the archive contains. */
  contents: ArchiveContents;
  /** filename → SHA-256 hex hash for integrity verification. */
  checksums: Record<string, string>;
}

export interface ArchiveContents {
  documentCount: number;
  documentIds: string[];
  blobCount: number;
  blobTotalSize: number;
  shapeLibraryCount: number;
  shapeLibraryItemCount: number;
  styleProfileCount: number;
  hasSettings: boolean;
  hasColorPalette: boolean;
  hasIconLibrary: boolean;
  hasUiPreferences: boolean;
  hasIconPresets: boolean;
}

// ---------------------------------------------------------------------------
// Archive Entry (internal representation of a file inside the ZIP)
// ---------------------------------------------------------------------------

export interface ArchiveEntry {
  /** Path inside the ZIP (e.g. "documents/abc123.json", "blobs/sha256.bin"). */
  path: string;
  /** Raw bytes. */
  data: Uint8Array;
}

// ---------------------------------------------------------------------------
// Backup Export Options
// ---------------------------------------------------------------------------

/** Which data categories to include in a full backup. */
export interface BackupOptions {
  includeDocuments: boolean;
  includeBlobs: boolean;
  includeSettings: boolean;
  includeStyleProfiles: boolean;
  includeColorPalette: boolean;
  includeShapeLibraries: boolean;
  includeIconLibrary: boolean;
  includeUiPreferences: boolean;
  includeIconPresets: boolean;
}

/** All categories enabled. */
export const DEFAULT_BACKUP_OPTIONS: BackupOptions = {
  includeDocuments: true,
  includeBlobs: true,
  includeSettings: true,
  includeStyleProfiles: true,
  includeColorPalette: true,
  includeShapeLibraries: true,
  includeIconLibrary: true,
  includeUiPreferences: true,
  includeIconPresets: true,
};

// ---------------------------------------------------------------------------
// Backup Size Estimate
// ---------------------------------------------------------------------------

export interface BackupSizeEstimate {
  /** Estimated uncompressed size in bytes. */
  uncompressedBytes: number;
  /** Breakdown by category. */
  breakdown: {
    documents: number;
    blobs: number;
    settings: number;
    styleProfiles: number;
    colorPalette: number;
    shapeLibraries: number;
    iconLibrary: number;
    uiPreferences: number;
    iconPresets: number;
  };
}

// ---------------------------------------------------------------------------
// Restore Options
// ---------------------------------------------------------------------------

export type RestoreMode = 'merge' | 'replace';

export interface RestoreOptions {
  /** 'merge' adds to existing data; 'replace' wipes and restores. */
  mode: RestoreMode;
  /** Per-conflict resolution choices (keyed by conflict id). */
  conflictResolutions: Record<string, ConflictResolution>;
  /** Which categories to restore (defaults to everything in the archive). */
  categories?: Partial<BackupOptions>;
}

// ---------------------------------------------------------------------------
// Conflict Detection & Resolution
// ---------------------------------------------------------------------------

export type ConflictResolution = 'keep-existing' | 'replace' | 'keep-both';

export interface RestoreConflict {
  /** Unique id for this conflict (e.g. "doc:abc123" or "profile:xyz"). */
  id: string;
  type: 'document' | 'style-profile' | 'shape-library';
  /** Name of the existing item. */
  existingName: string;
  /** Name of the incoming item. */
  incomingName: string;
  /** Last modified date of existing item. */
  existingModifiedAt: number;
  /** Last modified date of incoming item. */
  incomingModifiedAt: number;
}

// ---------------------------------------------------------------------------
// Progress Reporting
// ---------------------------------------------------------------------------

export type ArchivePhase =
  | 'collecting'
  | 'compressing'
  | 'writing'
  | 'reading'
  | 'validating'
  | 'restoring-blobs'
  | 'restoring-documents'
  | 'restoring-settings'
  | 'done';

export interface ArchiveProgress {
  phase: ArchivePhase;
  current: number;
  total: number;
  /** Optional human-readable detail (e.g. "Compressing blob 12/48"). */
  detail?: string;
}

export type ArchiveProgressCallback = (progress: ArchiveProgress) => void;

// ---------------------------------------------------------------------------
// Validation Result
// ---------------------------------------------------------------------------

export interface ArchiveValidationResult {
  valid: boolean;
  manifest: ArchiveManifest | null;
  errors: string[];
  warnings: string[];
  /** Conflicts detected against current application state. */
  conflicts: RestoreConflict[];
}

// ---------------------------------------------------------------------------
// Restore Result
// ---------------------------------------------------------------------------

export interface RestoreResult {
  success: boolean;
  /** Counts of items restored per category. */
  restored: {
    documents: number;
    blobs: number;
    settings: boolean;
    styleProfiles: number;
    colorPalette: boolean;
    shapeLibraries: number;
    shapeLibraryItems: number;
    iconLibrary: boolean;
    uiPreferences: boolean;
    iconPresets: boolean;
  };
  /** Any non-fatal warnings during restore. */
  warnings: string[];
  /** Duration in milliseconds. */
  durationMs: number;
}
