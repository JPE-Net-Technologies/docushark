/**
 * Blob Sync Service
 *
 * HTTP-based blob synchronization for assets in relay documents. Uploads
 * referenced blobs to the relay blob store before a document save, and
 * downloads any missing blobs into local IndexedDB after a document load.
 *
 * Transport is injected (`BlobTransport`) rather than owning its own
 * `fetch` + JWT: the connected `RelayClient` already satisfies the
 * interface, so blob traffic rides the same bearer token, 401 → refresh
 * path, and base URL as document CRUD (see `collaborationStore` wiring).
 * This service keeps the orchestration on top: check-then-act batching,
 * retry with backoff, progress reporting, and `BlobStorage` integration.
 *
 * Phase 17.5 Collaboration Support; transport seam added for JP-118.
 */

import type { DiagramDocument } from '../types/Document';
import { BlobStorage } from '../storage/BlobStorage';
import { collectBlobReferences } from '../storage/AssetBundler';

// ============ Types ============

/** Progress state for blob sync operations */
export interface BlobSyncProgress {
  /** Current phase of sync */
  phase: 'checking' | 'uploading' | 'downloading';
  /** Current item being processed */
  current: number;
  /** Total items to process */
  total: number;
  /** Hash of current blob being processed */
  currentBlobHash?: string;
  /** Bytes transferred so far for current blob */
  bytesTransferred?: number;
  /** Total bytes of current blob */
  bytesTotal?: number;
}

/**
 * Low-level blob transport. The connected `RelayClient` implements this
 * directly (`uploadBlob`/`downloadBlob`/`blobExists`), so auth + refresh
 * are handled there; this service never touches tokens.
 */
export interface BlobTransport {
  blobExists(hash: string): Promise<boolean>;
  uploadBlob(hash: string, data: Uint8Array): Promise<void>;
  downloadBlob(hash: string): Promise<Uint8Array>;
}

/** Options for BlobSyncService */
export interface BlobSyncServiceOptions {
  /** Blob transport (typically the connected RelayClient). */
  transport: BlobTransport;
  /** Progress callback */
  onProgress?: ((progress: BlobSyncProgress) => void) | undefined;
  /** Max retry attempts (default: 5) */
  maxRetries?: number | undefined;
  /** Initial retry delay in ms (default: 1000) */
  initialRetryDelay?: number | undefined;
  /** Max retry delay in ms (default: 30000) */
  maxRetryDelay?: number | undefined;
  /** Override the BlobStorage instance (defaults to the singleton; for tests). */
  blobStorage?: BlobStorage | undefined;
}

/** Result of a batch sync operation */
export interface BlobSyncResult {
  /** Total blobs processed */
  total: number;
  /** Blobs successfully synced (uploaded + already-present) */
  success: number;
  /**
   * Blobs actually transferred over the wire — a subset of `success`. On
   * upload, the rest were already on the relay (HEAD-gate skip); on download,
   * the rest were already in local storage. Lets callers report honestly
   * instead of claiming everything was (re)uploaded.
   */
  uploaded: number;
  /** Blobs that failed */
  failed: number;
  /** Error messages for failed blobs */
  errors: Map<string, string>;
}

// ============ BlobSyncService ============

/**
 * Service for synchronizing blobs between client and relay over HTTP.
 *
 * Usage:
 * ```typescript
 * const service = new BlobSyncService({ transport: relayClient });
 * await service.ensureBlobsUploaded(hashes); // before doc save
 * await service.downloadMissingBlobs(hashes); // after doc load
 * ```
 */
export class BlobSyncService {
  private transport: BlobTransport;
  private onProgress: ((progress: BlobSyncProgress) => void) | undefined;
  private maxRetries: number;
  private initialRetryDelay: number;
  private maxRetryDelay: number;
  private blobStorage: BlobStorage;

  constructor(options: BlobSyncServiceOptions) {
    this.transport = options.transport;
    this.onProgress = options.onProgress ?? undefined;
    this.maxRetries = options.maxRetries ?? 5;
    this.initialRetryDelay = options.initialRetryDelay ?? 1000;
    this.maxRetryDelay = options.maxRetryDelay ?? 30000;
    this.blobStorage = options.blobStorage ?? BlobStorage.getInstance();
  }

  /**
   * Check if a blob exists on the relay.
   */
  async checkBlobExists(hash: string): Promise<boolean> {
    return this.withRetry(() => this.transport.blobExists(hash));
  }

  /**
   * Upload a blob to the relay.
   */
  async uploadBlob(hash: string, blob: Blob): Promise<void> {
    const data = new Uint8Array(await blob.arrayBuffer());
    await this.withRetry(() => this.transport.uploadBlob(hash, data));
  }

  /**
   * Download a blob from the relay. The relay does not round-trip a
   * reliable MIME type (uploads are stored as octet-stream), so we sniff
   * the common image/PDF signatures from the bytes to give the cached
   * blob a sensible `type` for rendering and re-export.
   */
  async downloadBlob(hash: string): Promise<Blob> {
    const data = await this.withRetry(() => this.transport.downloadBlob(hash));
    const type = sniffMimeType(data);
    // Copy into a fresh ArrayBuffer so the body is unambiguously a BlobPart
    // (strict TS lib defs reject `Uint8Array<ArrayBufferLike>` directly).
    const buffer = new ArrayBuffer(data.byteLength);
    new Uint8Array(buffer).set(data);
    return type ? new Blob([buffer], { type }) : new Blob([buffer]);
  }

  /**
   * Ensure all blobs referenced by a document are uploaded to the relay.
   *
   * Call this before saving a relay document: a doc that references blobs
   * the relay doesn't have would render broken for collaborators.
   */
  async ensureBlobsUploaded(hashes: string[]): Promise<BlobSyncResult> {
    const result: BlobSyncResult = {
      total: hashes.length,
      success: 0,
      uploaded: 0,
      failed: 0,
      errors: new Map(),
    };

    if (hashes.length === 0) return result;

    // First, check which blobs need uploading
    this.reportProgress({ phase: 'checking', current: 0, total: hashes.length });

    const toUpload: string[] = [];
    for (let i = 0; i < hashes.length; i++) {
      const hash = hashes[i]!;
      this.reportProgress({
        phase: 'checking',
        current: i + 1,
        total: hashes.length,
        currentBlobHash: hash,
      });

      try {
        const exists = await this.checkBlobExists(hash);
        if (!exists) {
          toUpload.push(hash);
        } else {
          result.success++;
        }
      } catch {
        // If the existence check fails, try to upload anyway.
        toUpload.push(hash);
      }
    }

    // Upload missing blobs
    if (toUpload.length > 0) {
      this.reportProgress({ phase: 'uploading', current: 0, total: toUpload.length });

      for (let i = 0; i < toUpload.length; i++) {
        const hash = toUpload[i]!;
        this.reportProgress({
          phase: 'uploading',
          current: i + 1,
          total: toUpload.length,
          currentBlobHash: hash,
        });

        try {
          // Load blob from local storage
          const blob = await this.blobStorage.loadBlob(hash);
          if (!blob) {
            result.failed++;
            result.errors.set(hash, 'Blob not found in local storage');
            continue;
          }

          // Upload to relay
          await this.uploadBlob(hash, blob);
          result.success++;
          result.uploaded++;
        } catch (error) {
          result.failed++;
          result.errors.set(hash, error instanceof Error ? error.message : String(error));
        }
      }
    }

    return result;
  }

  /**
   * Download missing blobs from the relay into local storage.
   *
   * Call this after loading a relay document so blob:// references resolve
   * for rendering and the doc stays viewable offline from the IndexedDB cache.
   */
  async downloadMissingBlobs(hashes: string[]): Promise<BlobSyncResult> {
    const result: BlobSyncResult = {
      total: hashes.length,
      success: 0,
      uploaded: 0,
      failed: 0,
      errors: new Map(),
    };

    if (hashes.length === 0) return result;

    // Check which blobs are missing locally
    this.reportProgress({ phase: 'checking', current: 0, total: hashes.length });

    const toDownload: string[] = [];
    for (let i = 0; i < hashes.length; i++) {
      const hash = hashes[i]!;
      this.reportProgress({
        phase: 'checking',
        current: i + 1,
        total: hashes.length,
        currentBlobHash: hash,
      });

      const localBlob = await this.blobStorage.loadBlob(hash);
      if (!localBlob) {
        toDownload.push(hash);
      } else {
        result.success++;
      }
    }

    // Download missing blobs
    if (toDownload.length > 0) {
      this.reportProgress({ phase: 'downloading', current: 0, total: toDownload.length });

      for (let i = 0; i < toDownload.length; i++) {
        const hash = toDownload[i]!;
        this.reportProgress({
          phase: 'downloading',
          current: i + 1,
          total: toDownload.length,
          currentBlobHash: hash,
        });

        try {
          // Download from relay
          const blob = await this.downloadBlob(hash);

          // Save to local storage. BlobStorage recomputes the SHA-256 from
          // content, so the local ID matches the relay hash (content-addressed).
          await this.blobStorage.saveBlob(blob, hash);
          result.success++;
          result.uploaded++;
        } catch (error) {
          result.failed++;
          result.errors.set(hash, error instanceof Error ? error.message : String(error));
        }
      }
    }

    return result;
  }

  /**
   * Sync all blobs for a document: upload local-only blobs to the relay,
   * then download any the relay has but the client is missing.
   */
  async syncBlobsForDocument(document: DiagramDocument): Promise<BlobSyncResult> {
    const blobHashes = collectBlobReferences(document);

    if (blobHashes.length === 0) {
      return { total: 0, success: 0, uploaded: 0, failed: 0, errors: new Map() };
    }

    const uploadResult = await this.ensureBlobsUploaded(blobHashes);
    const downloadResult = await this.downloadMissingBlobs(blobHashes);

    return {
      total: blobHashes.length,
      success: Math.max(uploadResult.success, downloadResult.success),
      uploaded: uploadResult.uploaded + downloadResult.uploaded,
      failed: Math.min(uploadResult.failed, downloadResult.failed),
      errors: new Map([...uploadResult.errors, ...downloadResult.errors]),
    };
  }

  /**
   * Report progress to callback.
   */
  private reportProgress(progress: BlobSyncProgress): void {
    this.onProgress?.(progress);
  }

  /**
   * Run a transport call with retry + exponential backoff. Retries on
   * network errors and on transport errors carrying a 5xx / 429 `status`
   * (duck-typed off `RelayError`); 4xx (other than 429) fail fast.
   */
  private async withRetry<T>(fn: () => Promise<T>, attempt = 0): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (this.shouldRetry(error) && attempt < this.maxRetries) {
        await this.delay(this.getRetryDelay(attempt));
        return this.withRetry(fn, attempt + 1);
      }
      throw error;
    }
  }

  /** Retry transient failures only: network errors and 5xx / 429 responses. */
  private shouldRetry(error: unknown): boolean {
    const status = (error as { status?: unknown })?.status;
    if (typeof status === 'number') {
      return status >= 500 || status === 429;
    }
    // No status -> treat as a network/transport error and retry.
    return true;
  }

  /**
   * Calculate retry delay with exponential backoff and jitter.
   */
  private getRetryDelay(attempt: number): number {
    const exponentialDelay = this.initialRetryDelay * Math.pow(2, attempt);
    const cappedDelay = Math.min(exponentialDelay, this.maxRetryDelay);
    // Add ±10% jitter
    const jitter = cappedDelay * 0.1 * (Math.random() * 2 - 1);
    return Math.floor(cappedDelay + jitter);
  }

  /**
   * Delay helper.
   */
  private delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}

/**
 * Best-effort MIME sniff from leading magic bytes for the asset types the
 * editor handles. Returns `undefined` when unknown (the blob is then stored
 * untyped; `<img>` object URLs still decode by content). Kept tiny on
 * purpose — full content-type round-tripping is out of scope for JP-118.
 */
function sniffMimeType(data: Uint8Array): string | undefined {
  if (data.length >= 8 &&
      data[0] === 0x89 && data[1] === 0x50 && data[2] === 0x4e && data[3] === 0x47) {
    return 'image/png';
  }
  if (data.length >= 3 && data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff) {
    return 'image/jpeg';
  }
  if (data.length >= 6 && data[0] === 0x47 && data[1] === 0x49 && data[2] === 0x46) {
    return 'image/gif';
  }
  if (data.length >= 12 &&
      data[0] === 0x52 && data[1] === 0x49 && data[2] === 0x46 && data[3] === 0x46 &&
      data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) {
    return 'image/webp';
  }
  if (data.length >= 5 &&
      data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) {
    return 'application/pdf';
  }
  return undefined;
}
