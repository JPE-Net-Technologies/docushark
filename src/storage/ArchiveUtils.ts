/**
 * Reusable archive utilities for ZIP creation, extraction, checksum
 * validation, and blob collection.
 *
 * This module is intentionally decoupled from any specific archive use case
 * so it can serve both the full application backup (Phase 16.7) and the
 * future per-document archive export (Phase 16.8).
 */

import { zipSync, unzipSync, strToU8, strFromU8 } from 'fflate';
import type {
  ArchiveManifest,
  ArchiveEntry,
  ArchiveType,
  ArchiveContents,
} from './ArchiveTypes';
import { loadDocumentFromStorage } from '../store/persistenceStore';

// Re-export for consumers
export type { ArchiveEntry };

const BLOB_PREFIX = 'blob://';

// ---------------------------------------------------------------------------
// ZIP helpers
// ---------------------------------------------------------------------------

/**
 * Create a ZIP archive from a list of entries.
 * Returns the raw ZIP bytes.
 */
export function createArchiveZip(entries: ArchiveEntry[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  for (const entry of entries) {
    // Ensure data is a native Uint8Array (fflate may use a different realm's
    // Uint8Array in bundled environments, causing zipSync to misinterpret it)
    files[entry.path] = new Uint8Array(entry.data);
  }
  return zipSync(files, { level: 6 });
}

/**
 * Extract all entries from a ZIP archive.
 * Filters out directory entries (paths ending with `/`).
 */
export function readArchiveZip(data: Uint8Array): ArchiveEntry[] {
  const files = unzipSync(data);
  const entries: ArchiveEntry[] = [];
  for (const [path, fileData] of Object.entries(files)) {
    // Skip directory entries
    if (path.endsWith('/')) continue;
    entries.push({ path, data: fileData });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Checksum (SHA-256)
// ---------------------------------------------------------------------------

/**
 * Compute a SHA-256 hex digest for the given data.
 */
export async function computeChecksum(data: Uint8Array): Promise<string> {
  const hashBuffer = await crypto.subtle.digest('SHA-256', data as unknown as ArrayBuffer);
  const hashArray = new Uint8Array(hashBuffer);
  return Array.from(hashArray)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Verify that every filename→hash pair in `checksums` matches the actual
 * entry data. Returns a list of mismatched filenames (empty = all good).
 */
export async function validateChecksums(
  entries: ArchiveEntry[],
  checksums: Record<string, string>
): Promise<string[]> {
  const entryMap = new Map(entries.map((e) => [e.path, e.data]));
  const mismatches: string[] = [];

  for (const [filename, expectedHash] of Object.entries(checksums)) {
    const data = entryMap.get(filename);
    if (!data) {
      mismatches.push(filename);
      continue;
    }
    const actual = await computeChecksum(data);
    if (actual !== expectedHash) {
      mismatches.push(filename);
    }
  }

  return mismatches;
}

// ---------------------------------------------------------------------------
// Manifest helpers
// ---------------------------------------------------------------------------

/**
 * Type-guard that validates a parsed JSON object as an ArchiveManifest.
 * Returns the manifest if valid, or throws with a descriptive message.
 */
export function validateManifest(raw: unknown): ArchiveManifest {
  if (!raw || typeof raw !== 'object') {
    throw new Error('Manifest is not an object');
  }

  const obj = raw as Record<string, unknown>;

  if (obj['version'] !== 1) {
    throw new Error(`Unsupported manifest version: ${String(obj['version'])}`);
  }

  const validTypes: ArchiveType[] = ['diagrammer-backup', 'diagrammer-document-archive'];
  if (!validTypes.includes(obj['type'] as ArchiveType)) {
    throw new Error(`Unknown archive type: ${String(obj['type'])}`);
  }

  if (typeof obj['createdAt'] !== 'number') {
    throw new Error('Missing or invalid createdAt timestamp');
  }

  if (typeof obj['appVersion'] !== 'string') {
    throw new Error('Missing or invalid appVersion');
  }

  if (!obj['contents'] || typeof obj['contents'] !== 'object') {
    throw new Error('Missing or invalid contents');
  }

  if (!obj['checksums'] || typeof obj['checksums'] !== 'object') {
    throw new Error('Missing or invalid checksums');
  }

  return raw as ArchiveManifest;
}

/**
 * Build an ArchiveContents summary from the collected data.
 */
export function buildContents(opts: {
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
}): ArchiveContents {
  return {
    documentCount: opts.documentIds.length,
    documentIds: opts.documentIds,
    blobCount: opts.blobCount,
    blobTotalSize: opts.blobTotalSize,
    shapeLibraryCount: opts.shapeLibraryCount,
    shapeLibraryItemCount: opts.shapeLibraryItemCount,
    styleProfileCount: opts.styleProfileCount,
    hasSettings: opts.hasSettings,
    hasColorPalette: opts.hasColorPalette,
    hasIconLibrary: opts.hasIconLibrary,
    hasUiPreferences: opts.hasUiPreferences,
    hasIconPresets: opts.hasIconPresets,
  };
}

// ---------------------------------------------------------------------------
// Blob reference collection
// ---------------------------------------------------------------------------

/**
 * Recursively find all `blob://` references in an arbitrary object.
 * This mirrors the approach used by AssetBundler.findBlobReferences().
 */
function findBlobReferences(obj: unknown, blobIds: Set<string>): void {
  if (obj === null || obj === undefined) return;

  if (typeof obj === 'string') {
    if (obj.startsWith(BLOB_PREFIX)) {
      blobIds.add(obj.slice(BLOB_PREFIX.length));
    }
    return;
  }

  if (Array.isArray(obj)) {
    for (const item of obj) {
      findBlobReferences(item, blobIds);
    }
    return;
  }

  if (typeof obj === 'object') {
    for (const value of Object.values(obj as Record<string, unknown>)) {
      findBlobReferences(value, blobIds);
    }
  }
}

/**
 * Collect all blob IDs referenced by the given documents.
 *
 * Scans:
 * 1. `document.blobReferences[]` (canonical list)
 * 2. Full recursive scan of the document for `blob://` strings
 *    (catches rich text images, shape iconId, etc.)
 *
 * This function loads documents from storage by ID.
 */
export function collectBlobsForDocuments(documentIds: string[]): Set<string> {
  const blobIds = new Set<string>();

  for (const docId of documentIds) {
    const doc = loadDocumentFromStorage(docId);
    if (!doc) continue;

    // Canonical list
    if (doc.blobReferences) {
      for (const id of doc.blobReferences) {
        blobIds.add(id);
      }
    }

    // Deep scan the entire document for blob:// strings
    findBlobReferences(doc, blobIds);
  }

  return blobIds;
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

/** Encode a string to UTF-8 bytes for inclusion in a ZIP entry. */
export function encodeJSON(value: unknown): Uint8Array {
  return strToU8(JSON.stringify(value, null, 2));
}

/** Decode UTF-8 bytes back to a parsed JSON value. */
export function decodeJSON<T = unknown>(data: Uint8Array): T {
  return JSON.parse(strFromU8(data)) as T;
}

// ---------------------------------------------------------------------------
// Download trigger
// ---------------------------------------------------------------------------

/**
 * Trigger a browser file download for the given Blob.
 */
export function triggerDownload(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

// ---------------------------------------------------------------------------
// File reading
// ---------------------------------------------------------------------------

/**
 * Read a File/Blob as Uint8Array. Uses `arrayBuffer()` when available,
 * falls back to FileReader for environments that lack it (e.g. jsdom).
 */
export async function readFileAsUint8Array(file: Blob): Promise<Uint8Array> {
  if (typeof file.arrayBuffer === 'function') {
    return new Uint8Array(await file.arrayBuffer());
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer));
    reader.onerror = reject;
    reader.readAsArrayBuffer(file);
  });
}

// ---------------------------------------------------------------------------
// App version
// ---------------------------------------------------------------------------

/** Read the application version from package.json (injected by Vite). */
export function getAppVersion(): string {
  // __APP_VERSION__ is defined in vite.config.ts via define
  // Falls back to a safe default if not available
  try {
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    return (typeof __APP_VERSION__ !== 'undefined') ? __APP_VERSION__ : 'unknown';
  } catch {
    return 'unknown';
  }
}

// Vite global declaration
declare const __APP_VERSION__: string;
