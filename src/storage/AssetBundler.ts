/**
 * AssetBundler - Utilities for bundling and extracting assets in documents.
 *
 * When documents are shared over a host connection, blob:// references need
 * to be resolved because each client has its own local IndexedDB storage.
 * This module provides functions to:
 * 1. Bundle: Replace blob:// references with embedded base64 data
 * 2. Extract: Parse embedded data back to local blob storage
 */

import { blobStorage } from './BlobStorage';
import type { DiagramDocument } from '../types/Document';

/**
 * Prefix used for embedded asset data URLs.
 */
const EMBEDDED_PREFIX = 'data:';

/**
 * Prefix used for blob references.
 */
const BLOB_PREFIX = 'blob://';

/**
 * Result of bundling a document with assets.
 */
export interface BundleResult {
  document: DiagramDocument;
  /** Number of assets bundled */
  assetCount: number;
  /** Total size of embedded assets in bytes */
  totalSize: number;
}

/**
 * Options for bundling documents.
 */
export interface BundleOptions {
  /**
   * Bundling mode:
   * - 'embed': Convert blob refs to base64 data URLs (for export/offline)
   * - 'reference': Keep blob refs as-is (for collaboration via HTTP blob sync)
   */
  mode?: 'embed' | 'reference' | undefined;
  /**
   * In 'reference' mode, optionally embed small files under this size (bytes).
   * Default: 0 (don't embed anything in reference mode)
   */
  maxEmbedSize?: number | undefined;
}

/**
 * Result of extracting assets from a bundled document.
 */
export interface ExtractResult {
  document: DiagramDocument;
  /** Number of assets extracted */
  assetCount: number;
  /** Mapping of original embedded URLs to new blob IDs */
  assetMap: Map<string, string>;
}

/**
 * Convert a Blob to a base64 data URL.
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read blob'));
    reader.readAsDataURL(blob);
  });
}

/**
 * Convert a base64 data URL to a Blob.
 */
function dataUrlToBlob(dataUrl: string): Blob {
  const [header, base64] = dataUrl.split(',');
  if (!header || !base64) {
    throw new Error('Invalid data URL format');
  }

  const mimeMatch = header.match(/data:([^;]+)/);
  const mimeType = mimeMatch?.[1] ?? 'application/octet-stream';

  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }

  return new Blob([bytes], { type: mimeType });
}

/**
 * Recursively find and replace blob:// references in an object.
 * Also detects FileShape blobRef fields (raw hashes without blob:// prefix).
 * Returns the modified object and a set of blob IDs found.
 */
function findBlobReferences(obj: unknown, blobIds: Set<string>, parentKey?: string): void {
  if (obj === null || obj === undefined) return;

  if (typeof obj === 'string') {
    if (obj.startsWith(BLOB_PREFIX)) {
      const blobId = obj.slice(BLOB_PREFIX.length);
      blobIds.add(blobId);
    } else if (parentKey === 'blobRef' && obj.length > 0) {
      // FileShape stores blobRef as a raw SHA-256 hash
      blobIds.add(obj);
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
    for (const [key, value] of Object.entries(obj)) {
      findBlobReferences(value, blobIds, key);
    }
  }
}

/**
 * Recursively replace blob:// references with data URLs in an object.
 * Also handles FileShape blobRef fields (raw hashes without blob:// prefix).
 */
function replaceReferences(
  obj: unknown,
  replacements: Map<string, string>,
  parentKey?: string
): unknown {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    if (obj.startsWith(BLOB_PREFIX)) {
      const blobId = obj.slice(BLOB_PREFIX.length);
      const replacement = replacements.get(blobId);
      return replacement ?? obj;
    }
    // FileShape blobRef: replace raw hash with data URL
    if (parentKey === 'blobRef' && obj.length > 0) {
      const replacement = replacements.get(obj);
      return replacement ?? obj;
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => replaceReferences(item, replacements));
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = replaceReferences(value, replacements, key);
    }
    return result;
  }

  return obj;
}

/**
 * Recursively find and extract embedded data URLs, storing them as blobs.
 * Also handles FileShape blobRef fields containing embedded data URLs.
 */
async function extractEmbeddedAssets(
  obj: unknown,
  assetMap: Map<string, string>,
  parentKey?: string
): Promise<unknown> {
  if (obj === null || obj === undefined) return obj;

  if (typeof obj === 'string') {
    if (obj.startsWith(EMBEDDED_PREFIX) && obj.includes('base64,')) {
      // Check if we've already processed this data URL
      const existing = assetMap.get(obj);
      if (existing) {
        // FileShape blobRef stores raw hash, not blob:// prefixed
        return parentKey === 'blobRef' ? existing : BLOB_PREFIX + existing;
      }

      try {
        const blob = dataUrlToBlob(obj);
        // Generate a filename from the mime type
        const mimeMatch = obj.match(/data:([^;]+)/);
        const mimeType = mimeMatch?.[1] ?? 'application/octet-stream';
        const ext = mimeType.split('/')[1] ?? 'bin';
        const filename = `embedded-asset.${ext}`;

        const blobId = await blobStorage.saveBlob(blob, filename);
        assetMap.set(obj, blobId);
        // FileShape blobRef stores raw hash, not blob:// prefixed
        return parentKey === 'blobRef' ? blobId : BLOB_PREFIX + blobId;
      } catch (error) {
        console.error('Failed to extract embedded asset:', error);
        return obj; // Keep original on failure
      }
    }
    return obj;
  }

  if (Array.isArray(obj)) {
    const result: unknown[] = [];
    for (const item of obj) {
      result.push(await extractEmbeddedAssets(item, assetMap));
    }
    return result;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = await extractEmbeddedAssets(value, assetMap, key);
    }
    return result;
  }

  return obj;
}

/**
 * Bundle a document with its assets embedded as base64 data URLs.
 *
 * This converts all blob:// references to data: URLs so the document
 * can be transmitted over the network and assets will be available
 * to other clients.
 *
 * @param document - The document to bundle
 * @param options - Bundling options
 * @returns Bundled document with embedded assets
 */
export async function bundleDocumentWithAssets(
  document: DiagramDocument,
  options: BundleOptions = {}
): Promise<BundleResult> {
  const mode = options.mode ?? 'embed';
  const maxEmbedSize = options.maxEmbedSize ?? 0;

  // In reference mode, skip embedding (blobs are synced via HTTP)
  if (mode === 'reference') {
    // Find all blob references to report count
    const blobIds = new Set<string>();
    findBlobReferences(document, blobIds);

    if (document.blobReferences) {
      for (const id of document.blobReferences) {
        blobIds.add(id);
      }
    }

    // If maxEmbedSize is set, embed only small files
    if (maxEmbedSize > 0) {
      const replacements = new Map<string, string>();
      let totalSize = 0;

      for (const blobId of blobIds) {
        try {
          const metadata = await blobStorage.getBlobMetadata(blobId);
          if (metadata && metadata.size <= maxEmbedSize) {
            const blob = await blobStorage.loadBlob(blobId);
            if (blob) {
              const dataUrl = await blobToDataUrl(blob);
              replacements.set(blobId, dataUrl);
              totalSize += blob.size;
            }
          }
        } catch (error) {
          // Skip this blob
        }
      }

      if (replacements.size > 0) {
        const bundledDoc = replaceReferences(document, replacements) as DiagramDocument;
        return {
          document: bundledDoc,
          assetCount: replacements.size,
          totalSize,
        };
      }
    }

    // Return document unchanged - blob refs stay as-is for HTTP sync
    return {
      document,
      assetCount: 0,
      totalSize: 0,
    };
  }

  // Embed mode: Convert all blob refs to data URLs

  // Find all blob references in the document
  const blobIds = new Set<string>();
  findBlobReferences(document, blobIds);

  // Also check explicitly listed blob references
  if (document.blobReferences) {
    for (const id of document.blobReferences) {
      blobIds.add(id);
    }
  }

  // Load and convert each blob to a data URL
  const replacements = new Map<string, string>();
  let totalSize = 0;

  for (const blobId of blobIds) {
    try {
      const blob = await blobStorage.loadBlob(blobId);
      if (blob) {
        const dataUrl = await blobToDataUrl(blob);
        replacements.set(blobId, dataUrl);
        totalSize += blob.size;
      }
    } catch (error) {
      console.error(`Failed to load blob ${blobId}:`, error);
      // Skip this blob, reference will remain as blob://
    }
  }

  // Replace all references in the document
  const bundledDoc = replaceReferences(document, replacements) as DiagramDocument;

  // Clear blobReferences since they're now embedded
  bundledDoc.blobReferences = [];

  return {
    document: bundledDoc,
    assetCount: replacements.size,
    totalSize,
  };
}

/**
 * Extract embedded assets from a bundled document and store them locally.
 *
 * This converts all data: URLs back to blob:// references after storing
 * the assets in local IndexedDB.
 *
 * @param document - The bundled document with embedded assets
 * @returns Document with local blob references
 */
export async function extractAssetsFromBundle(
  document: DiagramDocument
): Promise<ExtractResult> {
  const assetMap = new Map<string, string>();

  // Recursively extract embedded assets
  const extractedDoc = await extractEmbeddedAssets(document, assetMap) as DiagramDocument;

  // Update blobReferences with the new blob IDs
  extractedDoc.blobReferences = Array.from(assetMap.values());

  return {
    document: extractedDoc,
    assetCount: assetMap.size,
    assetMap,
  };
}

/**
 * Check if a document has any embedded assets (data URLs).
 */
export function hasEmbeddedAssets(document: DiagramDocument): boolean {
  const json = JSON.stringify(document);
  return json.includes('"data:') && json.includes('base64,');
}

/**
 * Check if a document has any blob references.
 */
export function hasBlobReferences(document: DiagramDocument): boolean {
  const json = JSON.stringify(document);
  return json.includes('"blob://');
}

/**
 * Collect every blob hash a document references, walking the whole tree.
 *
 * This is the canonical extractor: it catches both rich-text image `src`
 * (`blob://<hash>`) and `FileShape.blobRef` (raw hash, no prefix), then
 * unions in the document's explicit `blobReferences` GC list. Use it to
 * build the upload set on save and the download set on load — it sees
 * strictly more than `hasBlobReferences` (which misses raw `blobRef`s).
 */
export function collectBlobReferences(document: DiagramDocument): string[] {
  const blobIds = new Set<string>();
  findBlobReferences(document, blobIds);

  if (document.blobReferences) {
    for (const id of document.blobReferences) {
      blobIds.add(id);
    }
  }

  return Array.from(blobIds);
}
