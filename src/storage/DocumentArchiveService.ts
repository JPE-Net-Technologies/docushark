/**
 * Per-document archive export and import service.
 *
 * Bundles a single document with all its referenced blobs into a
 * `.diagrammer` archive for portable sharing. Builds on the shared
 * ArchiveUtils infrastructure from Phase 16.7.
 *
 * Archive structure:
 *   manifest.json                  — type: 'diagrammer-document-archive'
 *   documents/{docId}.json         — the document
 *   blobs/{sha256-hash}.bin        — referenced blobs
 */

import { blobStorage } from './BlobStorage';
import {
  createArchiveZip,
  readArchiveZip,
  readFileAsUint8Array,
  collectBlobsForDocuments,
  computeChecksum,
  validateChecksums,
  validateManifest,
  buildContents,
  encodeJSON,
  decodeJSON,
  getAppVersion,
  triggerDownload,
} from './ArchiveUtils';
import type { ArchiveEntry, ArchiveManifest, ArchiveProgressCallback, ArchiveValidationResult, RestoreConflict } from './ArchiveTypes';
import type { DiagramDocument } from '../types/Document';
import { getDocumentMetadata } from '../types/Document';
import {
  usePersistenceStore,
  loadDocumentFromStorage,
  saveDocumentToStorage,
} from '../store/persistenceStore';
import { useDocumentRegistry } from '../store/documentRegistry';

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Export result returned by {@link exportDocumentArchive}.
 */
export interface DocumentArchiveExportResult {
  /** The ZIP archive as a Blob. */
  blob: Blob;
  /** Number of blobs bundled into the archive. */
  blobCount: number;
  /** Total size of blob data (uncompressed) in bytes. */
  blobTotalSize: number;
}

/**
 * Bundle a single document and its referenced blobs into a `.diagrammer` archive.
 *
 * @param docId - The document ID to export.
 * @param onProgress - Optional progress callback.
 * @returns The archive Blob and stats.
 * @throws If the document cannot be found.
 */
export async function exportDocumentArchive(
  docId: string,
  onProgress?: ArchiveProgressCallback,
): Promise<DocumentArchiveExportResult> {
  const progress = onProgress ?? (() => {});

  // ── Load document ────────────────────────────────────────────────────
  progress({ phase: 'collecting', current: 0, total: 1, detail: 'Loading document' });

  const doc = loadDocumentFromStorage(docId);
  if (!doc) {
    throw new Error(`Document not found: ${docId}`);
  }

  const entries: ArchiveEntry[] = [];
  const checksums: Record<string, string> = {};

  // Add document entry
  const docPath = `documents/${docId}.json`;
  const docData = encodeJSON(doc);
  entries.push({ path: docPath, data: docData });
  checksums[docPath] = await computeChecksum(docData);

  progress({ phase: 'collecting', current: 1, total: 1, detail: `Document: ${doc.name}` });

  // ── Collect and add blobs ──────────────────────────────────────────
  const blobIds = collectBlobsForDocuments([docId]);
  const blobIdArray = Array.from(blobIds);

  let blobCount = 0;
  let blobTotalSize = 0;

  progress({ phase: 'collecting', current: 0, total: blobIdArray.length, detail: 'Collecting blobs' });

  for (let i = 0; i < blobIdArray.length; i++) {
    const blobId = blobIdArray[i]!;
    const blob = await blobStorage.loadBlob(blobId);
    if (!blob) continue;

    const data = await readFileAsUint8Array(blob);
    const path = `blobs/${blobId}.bin`;
    entries.push({ path, data });
    checksums[path] = await computeChecksum(data);

    blobCount++;
    blobTotalSize += data.byteLength;

    progress({ phase: 'collecting', current: i + 1, total: blobIdArray.length, detail: `Blob ${i + 1}/${blobIdArray.length}` });
  }

  // ── Build manifest ─────────────────────────────────────────────────
  const manifest: ArchiveManifest = {
    version: 1,
    type: 'diagrammer-document-archive',
    createdAt: Date.now(),
    appVersion: getAppVersion(),
    contents: buildContents({
      documentIds: [docId],
      blobCount,
      blobTotalSize,
      shapeLibraryCount: 0,
      shapeLibraryItemCount: 0,
      styleProfileCount: 0,
      hasSettings: false,
      hasColorPalette: false,
      hasIconLibrary: false,
      hasUiPreferences: false,
      hasIconPresets: false,
    }),
    checksums,
  };

  const manifestData = encodeJSON(manifest);
  entries.push({ path: 'manifest.json', data: manifestData });

  // ── Compress ───────────────────────────────────────────────────────
  progress({ phase: 'compressing', current: 0, total: 1, detail: 'Creating archive' });
  const zipData = createArchiveZip(entries);
  progress({ phase: 'done', current: 1, total: 1 });

  return {
    blob: new Blob([zipData as unknown as BlobPart], { type: 'application/zip' }),
    blobCount,
    blobTotalSize,
  };
}

/**
 * Export a document archive and trigger a browser download.
 *
 * @param docId - The document ID to export.
 * @param onProgress - Optional progress callback.
 */
export async function exportAndDownloadDocumentArchive(
  docId: string,
  onProgress?: ArchiveProgressCallback,
): Promise<void> {
  const doc = loadDocumentFromStorage(docId);
  const docName = doc?.name ?? 'document';

  const { blob } = await exportDocumentArchive(docId, onProgress);

  // Sanitize filename: replace characters that are problematic in filenames
  const safeName = docName.replace(/[/\\:*?"<>|]/g, '_').trim() || 'document';
  triggerDownload(blob, `${safeName}.diagrammer`);
}

// ---------------------------------------------------------------------------
// Import — Validation
// ---------------------------------------------------------------------------

/**
 * Import result returned by {@link importDocumentArchive}.
 */
export interface DocumentArchiveImportResult {
  /** Whether the import succeeded. */
  success: boolean;
  /** The new document ID (different from the original). */
  documentId: string | null;
  /** Name of the imported document. */
  documentName: string | null;
  /** Number of blobs restored. */
  blobsRestored: number;
  /** Any non-fatal warnings. */
  warnings: string[];
  /** Duration in milliseconds. */
  durationMs: number;
}

/**
 * Validate a `.diagrammer` document archive without importing it.
 *
 * @param file - The archive file to validate.
 * @returns Validation result with manifest, errors, warnings, and conflicts.
 */
export async function validateDocumentArchive(file: File): Promise<ArchiveValidationResult> {
  const errors: string[] = [];
  const warnings: string[] = [];
  const conflicts: RestoreConflict[] = [];

  let manifest: ArchiveManifest | null = null;
  let entries: ArchiveEntry[];

  // Read and parse ZIP
  try {
    const zipData = await readFileAsUint8Array(file);
    entries = readArchiveZip(zipData);
  } catch (err) {
    return {
      valid: false,
      manifest: null,
      errors: [`Failed to read archive: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
      conflicts: [],
    };
  }

  // Find and validate manifest
  const manifestEntry = entries.find((e) => e.path === 'manifest.json');
  if (!manifestEntry) {
    return {
      valid: false,
      manifest: null,
      errors: ['Archive is missing manifest.json'],
      warnings: [],
      conflicts: [],
    };
  }

  try {
    const raw = decodeJSON(manifestEntry.data);
    manifest = validateManifest(raw);
  } catch (err) {
    return {
      valid: false,
      manifest: null,
      errors: [`Invalid manifest: ${err instanceof Error ? err.message : String(err)}`],
      warnings: [],
      conflicts: [],
    };
  }

  if (manifest.type !== 'diagrammer-document-archive') {
    errors.push(`Unexpected archive type: ${manifest.type}. Expected diagrammer-document-archive.`);
  }

  // Verify checksums
  const mismatches = await validateChecksums(entries, manifest.checksums);
  if (mismatches.length > 0) {
    errors.push(`Checksum mismatch for: ${mismatches.join(', ')}`);
  }

  // Check document count (should be exactly 1 for a document archive)
  const docEntries = entries.filter((e) => e.path.startsWith('documents/') && e.path.endsWith('.json'));
  if (docEntries.length === 0) {
    errors.push('Archive does not contain any documents');
  } else if (docEntries.length > 1) {
    warnings.push(`Archive contains ${docEntries.length} documents; expected 1 for a document archive`);
  }

  // Detect name conflicts with existing documents
  const existingDocs = usePersistenceStore.getState().documents;
  for (const docId of manifest.contents.documentIds) {
    const existing = existingDocs[docId];
    if (existing) {
      const docEntry = entries.find((e) => e.path === `documents/${docId}.json`);
      let incomingModifiedAt = 0;
      let incomingName = docId;
      if (docEntry) {
        try {
          const doc = decodeJSON<DiagramDocument>(docEntry.data);
          incomingModifiedAt = doc.modifiedAt;
          incomingName = doc.name;
        } catch {
          // Use defaults
        }
      }

      conflicts.push({
        id: `doc:${docId}`,
        type: 'document',
        existingName: existing.name,
        incomingName,
        existingModifiedAt: existing.modifiedAt,
        incomingModifiedAt,
      });
    }
  }

  return {
    valid: errors.length === 0,
    manifest,
    errors,
    warnings,
    conflicts,
  };
}

// ---------------------------------------------------------------------------
// Import — Restore
// ---------------------------------------------------------------------------

/**
 * Import a `.diagrammer` document archive.
 *
 * Restores blobs first (with deduplication), then creates the document
 * with a new ID and loads it into the editor.
 *
 * @param file - The archive file to import.
 * @param onProgress - Optional progress callback.
 * @returns Import result with the new document ID and stats.
 */
export async function importDocumentArchive(
  file: File,
  onProgress?: ArchiveProgressCallback,
): Promise<DocumentArchiveImportResult> {
  const startTime = Date.now();
  const progress = onProgress ?? (() => {});
  const warnings: string[] = [];

  // ── Read archive ───────────────────────────────────────────────────
  progress({ phase: 'reading', current: 0, total: 1, detail: 'Reading archive' });

  let entries: ArchiveEntry[];
  let manifest: ArchiveManifest;

  try {
    const zipData = await readFileAsUint8Array(file);
    entries = readArchiveZip(zipData);
  } catch (err) {
    return {
      success: false,
      documentId: null,
      documentName: null,
      blobsRestored: 0,
      warnings: [`Failed to read archive: ${err instanceof Error ? err.message : String(err)}`],
      durationMs: Date.now() - startTime,
    };
  }

  const manifestEntry = entries.find((e) => e.path === 'manifest.json');
  if (!manifestEntry) {
    return {
      success: false,
      documentId: null,
      documentName: null,
      blobsRestored: 0,
      warnings: ['Archive is missing manifest.json'],
      durationMs: Date.now() - startTime,
    };
  }

  try {
    manifest = validateManifest(decodeJSON(manifestEntry.data));
  } catch (err) {
    return {
      success: false,
      documentId: null,
      documentName: null,
      blobsRestored: 0,
      warnings: [`Invalid manifest: ${err instanceof Error ? err.message : String(err)}`],
      durationMs: Date.now() - startTime,
    };
  }

  if (manifest.type !== 'diagrammer-document-archive') {
    return {
      success: false,
      documentId: null,
      documentName: null,
      blobsRestored: 0,
      warnings: [`Unexpected archive type: ${manifest.type}. Expected diagrammer-document-archive.`],
      durationMs: Date.now() - startTime,
    };
  }

  // ── Validate checksums ─────────────────────────────────────────────
  progress({ phase: 'validating', current: 0, total: 1, detail: 'Verifying integrity' });

  const mismatches = await validateChecksums(entries, manifest.checksums);
  if (mismatches.length > 0) {
    return {
      success: false,
      documentId: null,
      documentName: null,
      blobsRestored: 0,
      warnings: [`Checksum verification failed for: ${mismatches.join(', ')}`],
      durationMs: Date.now() - startTime,
    };
  }

  // ── Restore blobs ──────────────────────────────────────────────────
  const blobEntries = entries.filter((e) => e.path.startsWith('blobs/'));
  let blobsRestored = 0;

  progress({ phase: 'restoring-blobs', current: 0, total: blobEntries.length, detail: 'Restoring blobs' });

  for (let i = 0; i < blobEntries.length; i++) {
    const entry = blobEntries[i]!;
    const blobId = entry.path.replace('blobs/', '').replace('.bin', '');

    try {
      // Content-addressed deduplication: skip if blob already exists
      const existingMeta = await blobStorage.getBlobMetadata(blobId);
      if (!existingMeta) {
        const blob = new Blob([entry.data]);
        await blobStorage.saveBlob(blob, blobId);
      }
      blobsRestored++;
    } catch (err) {
      warnings.push(`Failed to restore blob ${blobId}: ${err instanceof Error ? err.message : String(err)}`);
    }

    progress({ phase: 'restoring-blobs', current: i + 1, total: blobEntries.length, detail: `Blob ${i + 1}/${blobEntries.length}` });
  }

  // ── Restore document ───────────────────────────────────────────────
  progress({ phase: 'restoring-documents', current: 0, total: 1, detail: 'Restoring document' });

  const docEntries = entries.filter((e) => e.path.startsWith('documents/') && e.path.endsWith('.json'));
  if (docEntries.length === 0) {
    return {
      success: false,
      documentId: null,
      documentName: null,
      blobsRestored,
      warnings: ['Archive does not contain any documents'],
      durationMs: Date.now() - startTime,
    };
  }

  // Import the first (and typically only) document
  const docEntry = docEntries[0]!;
  let doc: DiagramDocument;

  try {
    doc = decodeJSON<DiagramDocument>(docEntry.data);
  } catch (err) {
    return {
      success: false,
      documentId: null,
      documentName: null,
      blobsRestored,
      warnings: [`Failed to parse document: ${err instanceof Error ? err.message : String(err)}`],
      durationMs: Date.now() - startTime,
    };
  }

  // Generate new ID to avoid conflicts (consistent with importJSON behavior)
  const { nanoid } = await import('nanoid');
  const newId = nanoid();
  const originalName = doc.name;
  doc.id = newId;
  doc.modifiedAt = Date.now();

  // Save to localStorage
  saveDocumentToStorage(doc);

  // Increment blob usage counts
  if (doc.blobReferences) {
    for (const blobId of doc.blobReferences) {
      await blobStorage.incrementUsageCount(blobId).catch(() => {
        // Non-fatal: blob may not exist if it failed to restore
      });
    }
  }

  // Update persistence store metadata index
  const metadata = getDocumentMetadata(doc);
  usePersistenceStore.setState((state) => ({
    documents: {
      ...state.documents,
      [newId]: metadata,
    },
  }));

  // Register in document registry
  useDocumentRegistry.getState().registerLocal(metadata);

  progress({ phase: 'done', current: 1, total: 1 });

  // Show success notification
  import('../store/notificationStore').then(({ useNotificationStore }) => {
    useNotificationStore.getState().success(`Imported "${originalName}" with ${blobsRestored} asset(s)`);
  }).catch(() => {
    // Notification is non-critical
  });

  return {
    success: true,
    documentId: newId,
    documentName: originalName,
    blobsRestored,
    warnings,
    durationMs: Date.now() - startTime,
  };
}
