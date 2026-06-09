import type { BlobStorage } from './BlobStorage';
import type { BlobMetadata, GCStats } from './BlobTypes';
import { usePersistenceStore } from '../store/persistenceStore';
import { loadDocumentFromStorage } from '../store/persistenceStore';
import { getTrashedBlobReferences } from './TrashStorage';

/**
 * Options for garbage collection.
 */
export interface GCOptions {
  /** Include icons (SVG files) in garbage collection. Default: false */
  includeIcons?: boolean;
}

/**
 * Extended options for incremental garbage collection.
 */
export interface IncrementalGCOptions extends GCOptions {
  /**
   * Progress callback invoked during GC.
   * @param phase - Current phase ('scanning' | 'deleting')
   * @param current - Current item index (0-based)
   * @param total - Total items in this phase
   */
  onProgress?: (phase: 'scanning' | 'deleting', current: number, total: number) => void;

  /** Batch size for deletions. Default: 10 */
  deleteBatchSize?: number;
}

/**
 * Cached reference data for a document, keyed by document ID.
 */
interface CachedDocumentRefs {
  /** Blob IDs referenced by this document */
  blobIds: string[];
  /** Document modifiedAt timestamp when cache was built */
  modifiedAt: number;
}

/**
 * Check if a blob is an icon (SVG file).
 */
function isIconBlob(blob: BlobMetadata): boolean {
  return blob.type === 'image/svg+xml';
}

/**
 * Garbage collector for orphaned blobs.
 *
 * Identifies and deletes blobs that are no longer referenced by any document.
 * Uses mark-and-sweep algorithm:
 * 1. Scan all documents and collect referenced blob IDs (mark)
 * 2. Find blobs not in the reference set (orphans)
 * 3. Delete orphaned blobs (sweep)
 *
 * Supports incremental mode with a reference cache that skips unchanged
 * documents based on their modifiedAt timestamp, reducing O(n*m) to O(k*m)
 * where k is the number of changed documents.
 *
 * By default, icons (SVG files) are preserved to avoid accidentally deleting
 * user-uploaded icons. Use `includeIcons: true` to also clean up unused icons.
 *
 * Usage:
 * ```typescript
 * // Clean images only (default)
 * const stats = await blobGC.collectGarbage();
 *
 * // Clean both images and icons
 * const stats = await blobGC.collectGarbage({ includeIcons: true });
 *
 * // Incremental GC with progress reporting
 * const stats = await blobGC.collectGarbageIncremental({
 *   onProgress: (phase, current, total) => console.log(`${phase}: ${current}/${total}`),
 * });
 * ```
 */
export class BlobGarbageCollector {
  /** Cache of document references, keyed by document ID */
  private refCache = new Map<string, CachedDocumentRefs>();

  constructor(private storage: BlobStorage) {}

  /**
   * Collect garbage blobs not referenced by any document.
   *
   * This is a potentially expensive operation that scans all documents.
   * Run during idle time or when user explicitly requests cleanup.
   *
   * @param options - GC options (includeIcons defaults to false)
   * @returns Statistics about the cleanup operation
   */
  async collectGarbage(options: GCOptions = {}): Promise<GCStats> {
    const { includeIcons = false } = options;
    const startTime = Date.now();

    // Get all document references
    const referencedBlobIds = await this.getAllDocumentReferences();

    // Get all blobs in storage
    const allBlobs = await this.storage.listAllBlobs();

    // Find orphans (optionally excluding icons)
    const orphans = allBlobs.filter((blob) => {
      if (!referencedBlobIds.has(blob.id)) {
        // If not including icons, skip SVG files
        if (!includeIcons && isIconBlob(blob)) {
          return false;
        }
        return true;
      }
      return false;
    });

    // Delete orphans
    let bytesFreed = 0;
    for (const orphan of orphans) {
      try {
        await this.storage.deleteBlob(orphan.id);
        bytesFreed += orphan.size;
      } catch (error) {
        console.error('Failed to delete orphaned blob:', orphan.id, error);
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      blobsDeleted: orphans.length,
      bytesFreed,
      durationMs,
    };
  }

  /**
   * Incremental garbage collection that caches document references.
   *
   * Only re-scans documents that have changed since the last GC run,
   * making repeated runs much faster for large document stores.
   * Also supports progress reporting and batched deletions.
   *
   * @param options - Incremental GC options
   * @returns Statistics about the cleanup operation
   */
  async collectGarbageIncremental(options: IncrementalGCOptions = {}): Promise<GCStats> {
    const { includeIcons = false, onProgress, deleteBatchSize = 10 } = options;
    const startTime = Date.now();

    // Get all document references using incremental cache
    const referencedBlobIds = await this.getAllDocumentReferencesIncremental(onProgress);

    // Get all blobs in storage
    const allBlobs = await this.storage.listAllBlobs();

    // Find orphans
    const orphans = allBlobs.filter((blob) => {
      if (!referencedBlobIds.has(blob.id)) {
        if (!includeIcons && isIconBlob(blob)) {
          return false;
        }
        return true;
      }
      return false;
    });

    // Delete orphans in batches
    let bytesFreed = 0;
    for (let i = 0; i < orphans.length; i += deleteBatchSize) {
      const batch = orphans.slice(i, i + deleteBatchSize);
      const deletePromises = batch.map(async (orphan) => {
        try {
          await this.storage.deleteBlob(orphan.id);
          return orphan.size;
        } catch (error) {
          console.error('Failed to delete orphaned blob:', orphan.id, error);
          return 0;
        }
      });

      const freed = await Promise.all(deletePromises);
      bytesFreed += freed.reduce((sum, b) => sum + b, 0);

      if (onProgress) {
        onProgress('deleting', Math.min(i + deleteBatchSize, orphans.length), orphans.length);
      }
    }

    const durationMs = Date.now() - startTime;

    return {
      blobsDeleted: orphans.length,
      bytesFreed,
      durationMs,
    };
  }

  /**
   * Get list of orphaned blobs without deleting them.
   *
   * Useful for showing preview in Storage Manager UI before cleanup.
   *
   * @param options - GC options (includeIcons defaults to false)
   * @returns Array of orphaned blob metadata
   */
  async getOrphanedBlobs(options: GCOptions = {}): Promise<BlobMetadata[]> {
    const { includeIcons = false } = options;
    const referencedBlobIds = await this.getAllDocumentReferences();
    const allBlobs = await this.storage.listAllBlobs();

    return allBlobs.filter((blob) => {
      if (!referencedBlobIds.has(blob.id)) {
        if (!includeIcons && isIconBlob(blob)) {
          return false;
        }
        return true;
      }
      return false;
    });
  }

  /**
   * Get total size of orphaned blobs in bytes.
   *
   * @param options - GC options (includeIcons defaults to false)
   * @returns Total bytes that can be freed
   */
  async getOrphanedSize(options: GCOptions = {}): Promise<number> {
    const orphans = await this.getOrphanedBlobs(options);
    return orphans.reduce((total, blob) => total + blob.size, 0);
  }

  /**
   * Clear the internal reference cache.
   * Call this when you want to force a full rescan.
   */
  clearCache(): void {
    this.refCache.clear();
  }

  /**
   * Get the number of cached document entries.
   * Useful for diagnostics.
   */
  getCacheSize(): number {
    return this.refCache.size;
  }

  /**
   * Scan all documents and collect blob references.
   *
   * This reads all documents from localStorage and extracts their blobReferences arrays.
   *
   * @returns Set of all referenced blob IDs
   */
  private async getAllDocumentReferences(): Promise<Set<string>> {
    const references = new Set<string>();

    try {
      // Get all document IDs from persistence store
      const persistenceStore = usePersistenceStore.getState();
      const allDocuments = persistenceStore.getDocumentList();

      // Load each document and collect blob references
      for (const docMeta of allDocuments) {
        try {
          const doc = loadDocumentFromStorage(docMeta.id);
          if (doc?.blobReferences) {
            doc.blobReferences.forEach((id) => references.add(id));
          }
        } catch (error) {
          console.error('Failed to load document for GC:', docMeta.id, error);
          // Continue with other documents
        }
      }

      // Trashed documents still hold their blobs (JP-291). Union them into the
      // mark-set so the sweep doesn't reclaim blobs out from under the trash.
      getTrashedBlobReferences().forEach((id) => references.add(id));
    } catch (error) {
      console.error('Failed to get document references:', error);
    }

    return references;
  }

  /**
   * Incremental document reference scanning.
   *
   * Uses a cache keyed by document ID and modifiedAt timestamp.
   * Only re-loads documents whose modifiedAt has changed.
   * Removes cache entries for deleted documents.
   *
   * @param onProgress - Optional progress callback
   * @returns Set of all referenced blob IDs
   */
  private async getAllDocumentReferencesIncremental(
    onProgress?: (phase: 'scanning' | 'deleting', current: number, total: number) => void
  ): Promise<Set<string>> {
    const references = new Set<string>();

    try {
      const persistenceStore = usePersistenceStore.getState();
      const allDocuments = persistenceStore.getDocumentList();
      const currentDocIds = new Set<string>();

      for (let i = 0; i < allDocuments.length; i++) {
        const docMeta = allDocuments[i]!;
        currentDocIds.add(docMeta.id);

        // Check if cache is still valid
        const cached = this.refCache.get(docMeta.id);
        if (cached && cached.modifiedAt === docMeta.modifiedAt) {
          // Cache hit — use cached references
          cached.blobIds.forEach((id) => references.add(id));
        } else {
          // Cache miss — load and scan document
          try {
            const doc = loadDocumentFromStorage(docMeta.id);
            const blobIds = doc?.blobReferences ?? [];

            // Update cache
            this.refCache.set(docMeta.id, {
              blobIds: [...blobIds],
              modifiedAt: docMeta.modifiedAt,
            });

            blobIds.forEach((id) => references.add(id));
          } catch (error) {
            console.error('Failed to load document for GC:', docMeta.id, error);
          }
        }

        if (onProgress) {
          onProgress('scanning', i + 1, allDocuments.length);
        }
      }

      // Evict cache entries for deleted documents
      for (const cachedId of this.refCache.keys()) {
        if (!currentDocIds.has(cachedId)) {
          this.refCache.delete(cachedId);
        }
      }

      // Trashed documents still hold their blobs (JP-291). Unioned in fresh each
      // run (trash is bounded + reads snapshotted refs, so no per-doc caching
      // needed) so the sweep never reclaims blobs a trashed doc still references.
      getTrashedBlobReferences().forEach((id) => references.add(id));
    } catch (error) {
      console.error('Failed to get document references:', error);
    }

    return references;
  }
}
