/**
 * blobResolver — the single owner of the client's `blob://<hash> → objectURL`
 * lifecycle.
 *
 * Consolidates three previously-independent caches (the file-viewer
 * `FileContentCache`, the `FileShape` canvas-thumbnail cache, and
 * `TiptapEditor`'s rich-text image cache) behind one content-addressed store,
 * and adds **download-on-miss**: when a blob isn't in local IndexedDB it asks a
 * registered downloader (the relay document store) to pull it from the
 * relay/R2. That's what lets an embedded file open on any client that can reach
 * the relay — not just the one that uploaded it (JP-129). Before this, the open
 * path was local-IndexedDB-only and made no network request on a miss.
 *
 * Cache policy:
 * - Object URLs are content-addressed (keyed by SHA-256 hash), so one URL is
 *   valid for a hash across every shape/doc that references it.
 * - Entries are *pinned* (canvas thumbnails + rich-text images, which must stay
 *   valid for as long as the doc is open) or *transient* (the file viewer's
 *   full-file blobs, which can be LRU-evicted under memory pressure). Eviction
 *   never revokes a pinned URL out from under a live `<img>`/`<canvas>`.
 * - `resetBlobCache()` (called on document switch) revokes and clears everything.
 */

import { blobStorage } from './BlobStorage';

/** DocuShark's custom blob reference scheme (NOT the browser's native `blob:`). */
const BLOB_PREFIX = 'blob://';

/** Default LRU budget for transient (file-viewer) object URLs: 100 MB. */
const DEFAULT_MAX_TRANSIENT_BYTES = 100 * 1024 * 1024;

interface CacheEntry {
  objectUrl: string;
  size: number;
  lastAccessed: number;
  /** Pinned entries are never LRU-evicted (cleared only by resetBlobCache). */
  pinned: boolean;
}

const cache = new Map<string, CacheEntry>();
/** Running total of *transient* (non-pinned) bytes for LRU accounting. */
let transientBytes = 0;
let maxTransientBytes = DEFAULT_MAX_TRANSIENT_BYTES;

/** Hashes with an in-flight resolve, to dedupe concurrent callers. */
const inFlight = new Map<string, Promise<string | null>>();

/** blobRef -> known availability (true = present, false = missing). */
const availability = new Map<string, boolean>();

/** Listeners notified when a blob finishes resolving (or fails). */
const loadCallbacks = new Set<() => void>();

// ---------------------------------------------------------------------------
// Downloader seam (avoids a storage -> store import cycle)
// ---------------------------------------------------------------------------

type BlobDownloader = (hash: string) => Promise<boolean>;
let downloader: BlobDownloader | null = null;
const downloadsInFlight = new Map<string, Promise<boolean>>();

/**
 * Register the function the resolver uses to fetch a blob missing locally. The
 * relay document store registers one that calls `docProvider.downloadBlobs`.
 * Resolves to true when the blob is now in local storage. Pass `null` to clear.
 */
export function registerBlobDownloader(fn: BlobDownloader | null): void {
  downloader = fn;
}

function ensureDownloaded(hash: string): Promise<boolean> {
  if (!downloader) return Promise.resolve(false);
  const existing = downloadsInFlight.get(hash);
  if (existing) return existing;
  const p = downloader(hash)
    .catch(() => false)
    .finally(() => {
      downloadsInFlight.delete(hash);
      notifyBlobLoad(); // download finished — refresh the sync-activity indicator
    });
  downloadsInFlight.set(hash, p);
  notifyBlobLoad(); // download started — surface it in the sync-activity indicator
  return p;
}

/**
 * Number of blob downloads currently in flight. Drives the sync-activity
 * indicator's "downloading…" state — subscribe via {@link onBlobLoad}, which
 * fires when a download starts and finishes.
 */
export function inFlightDownloadCount(): number {
  return downloadsInFlight.size;
}

// ---------------------------------------------------------------------------
// Availability tracking (drives the FileShape missing-blob overlay)
// ---------------------------------------------------------------------------

/** Mark a blob as present in storage. */
export function markBlobAvailable(blobRef: string): void {
  availability.set(blobRef, true);
}

/** Mark a blob as missing from storage. */
export function markBlobMissing(blobRef: string): void {
  availability.set(blobRef, false);
}

/** Whether a blob is known-missing. `undefined` when its status is unknown. */
export function isBlobMissing(blobRef: string): boolean | undefined {
  const status = availability.get(blobRef);
  if (status === undefined) return undefined;
  return !status;
}

// ---------------------------------------------------------------------------
// Load notification (canvas redraw hook — mirrors iconCache.onIconLoad)
// ---------------------------------------------------------------------------

/** Subscribe to "a blob finished resolving" events. Returns an unsubscribe fn. */
export function onBlobLoad(callback: () => void): () => void {
  loadCallbacks.add(callback);
  return () => loadCallbacks.delete(callback);
}

/** Notify listeners that a blob resolved (or failed) so the canvas can redraw. */
export function notifyBlobLoad(): void {
  for (const cb of loadCallbacks) cb();
}

// ---------------------------------------------------------------------------
// Cache internals
// ---------------------------------------------------------------------------

function hasEvictableEntry(): boolean {
  for (const entry of cache.values()) if (!entry.pinned) return true;
  return false;
}

function evict(hash: string): void {
  const entry = cache.get(hash);
  if (!entry) return;
  URL.revokeObjectURL(entry.objectUrl);
  if (!entry.pinned) transientBytes -= entry.size;
  cache.delete(hash);
}

function evictLRU(): void {
  let oldestKey: string | null = null;
  let oldest = Infinity;
  for (const [key, entry] of cache) {
    if (entry.pinned) continue;
    if (entry.lastAccessed < oldest) {
      oldest = entry.lastAccessed;
      oldestKey = key;
    }
  }
  if (oldestKey) evict(oldestKey);
}

function store(hash: string, blob: Blob, pinned: boolean): string {
  const existing = cache.get(hash);
  if (existing) {
    existing.lastAccessed = Date.now();
    // Promote a transient entry to pinned if a display consumer now needs it.
    if (pinned && !existing.pinned) {
      transientBytes -= existing.size;
      existing.pinned = true;
    }
    return existing.objectUrl;
  }

  const objectUrl = URL.createObjectURL(blob);
  if (!pinned) {
    // Stay within the transient budget. Never evicts pinned entries; if the
    // blob alone exceeds the budget we still cache it (the doc-switch reset
    // reclaims it) rather than refuse to display a large file.
    while (transientBytes + blob.size > maxTransientBytes && hasEvictableEntry()) {
      evictLRU();
    }
    transientBytes += blob.size;
  }
  cache.set(hash, { objectUrl, size: blob.size, lastAccessed: Date.now(), pinned });
  return objectUrl;
}

/**
 * Sniff a blob's real MIME from its leading bytes. The local content-addressed
 * store keeps bytes untyped (`application/octet-stream`), and while browsers
 * content-sniff raster images in an `<img>`, they deliberately do **not** sniff
 * SVG (a security rule) — so an untyped object URL renders a PNG fine but leaves
 * an SVG blank. Re-typing the object URL from a sniff fixes SVG and makes the
 * raster/PDF cases correct for non-sniffing consumers (downloads) too. Returns
 * `null` when unrecognized (leaves the blob as-is). Only called when the stored
 * type is missing/generic.
 */
export function sniffMimeFromBytes(b: Uint8Array): string | null {
  if (b.length === 0) return null;
  // Binary magic numbers.
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38) return 'image/gif';
  if (b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46) return 'application/pdf';
  if (
    b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 &&
    b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50
  ) {
    return 'image/webp';
  }
  // SVG is XML text — skip a BOM + leading whitespace, then look for an `<svg`
  // root (optionally behind an `<?xml …?>` / comment prolog).
  const text = new TextDecoder('utf-8', { fatal: false })
    .decode(b)
    .replace(/^﻿/, '')
    .trimStart()
    .toLowerCase();
  if (text.startsWith('<svg') || ((text.startsWith('<?xml') || text.startsWith('<!--')) && text.includes('<svg'))) {
    return 'image/svg+xml';
  }
  return null;
}

async function sniffBlobType(blob: Blob): Promise<string | null> {
  return sniffMimeFromBytes(new Uint8Array(await blob.slice(0, 512).arrayBuffer()));
}

/** True when a blob carries no usable MIME (so the object URL must be sniffed). */
function hasGenericType(blob: Blob): boolean {
  return !blob.type || blob.type === 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// Public resolve surface
// ---------------------------------------------------------------------------

/** Strip the `blob://` scheme, or null for a directly-loadable URL. */
export function blobHashFromRef(ref: string | undefined): string | null {
  if (!ref || !ref.startsWith(BLOB_PREFIX)) return null;
  return ref.slice(BLOB_PREFIX.length);
}

/** Synchronous cache peek for the canvas render path (no I/O). */
export function peekBlobObjectUrl(hash: string): string | undefined {
  const entry = cache.get(hash);
  if (!entry) return undefined;
  entry.lastAccessed = Date.now();
  return entry.objectUrl;
}

export interface ResolveOptions {
  /** Pull from the relay when missing locally (default true). */
  allowDownload?: boolean;
  /** Keep the URL valid until resetBlobCache (display surfaces); default false. */
  pinned?: boolean;
}

/**
 * Resolve a raw content hash to a displayable object URL: cache → IndexedDB →
 * (on miss, if `allowDownload`) relay download → IndexedDB. Returns null only
 * when the blob is genuinely unavailable. Concurrent calls for the same hash
 * share one resolve, and the outcome updates the availability cache + notifies
 * load listeners.
 */
export function resolveBlobObjectUrl(
  hash: string,
  { allowDownload = true, pinned = false }: ResolveOptions = {},
): Promise<string | null> {
  const cached = peekBlobObjectUrl(hash);
  if (cached) {
    markBlobAvailable(hash);
    return Promise.resolve(cached);
  }

  const existing = inFlight.get(hash);
  if (existing) return existing;

  const p = (async (): Promise<string | null> => {
    try {
      let blob = await blobStorage.loadBlob(hash);
      if (!blob && allowDownload) {
        const ok = await ensureDownloaded(hash);
        if (ok) blob = await blobStorage.loadBlob(hash);
      }
      if (!blob) {
        markBlobMissing(hash);
        return null;
      }
      // Re-type the object URL when the stored blob is untyped — otherwise an
      // SVG (which browsers won't content-sniff) renders blank.
      if (hasGenericType(blob)) {
        const sniffed = await sniffBlobType(blob);
        if (sniffed) blob = blob.slice(0, blob.size, sniffed);
      }
      const url = store(hash, blob, pinned);
      markBlobAvailable(hash);
      return url;
    } catch {
      markBlobMissing(hash);
      return null;
    } finally {
      inFlight.delete(hash);
      notifyBlobLoad();
    }
  })();
  inFlight.set(hash, p);
  return p;
}

/**
 * Resolve an `<img>`-style source that may be a `blob://<hash>` ref or a
 * directly-loadable URL (`data:` / `http(s):`). Direct URLs pass through
 * unchanged; blob refs resolve to a pinned object URL via
 * {@link resolveBlobObjectUrl}. Used for rich-text images.
 */
export function resolveBlobUrl(ref: string, opts: ResolveOptions = {}): Promise<string | null> {
  const hash = blobHashFromRef(ref);
  if (hash === null) return Promise.resolve(ref);
  return resolveBlobObjectUrl(hash, { pinned: true, ...opts });
}

/**
 * Fire-and-forget resolve for the canvas thumbnail path: kicks off a resolve
 * and notifies listeners when done so the renderer redraws; the synchronous
 * {@link peekBlobObjectUrl} returns the URL once ready. Defaults to
 * `allowDownload: false` — thumbnails are embedded in the doc, so the canvas
 * shouldn't trigger a fan-out of network fetches on doc open.
 */
export function requestBlobThumbnail(
  hash: string,
  { allowDownload = false }: { allowDownload?: boolean } = {},
): void {
  if (cache.has(hash) || inFlight.has(hash)) return;
  void resolveBlobObjectUrl(hash, { allowDownload, pinned: true });
}

/** Evict a single hash (e.g. when a file is replaced) and forget its status. */
export function evictBlob(hash: string): void {
  evict(hash);
  availability.delete(hash);
}

/** Revoke every object URL and clear all caches. Called on document switch. */
export function resetBlobCache(): void {
  for (const entry of cache.values()) URL.revokeObjectURL(entry.objectUrl);
  cache.clear();
  transientBytes = 0;
  inFlight.clear();
  downloadsInFlight.clear();
  availability.clear();
}

/** Tune the transient LRU budget (mainly for tests). */
export function setMaxTransientBytes(bytes: number): void {
  maxTransientBytes = bytes;
  while (transientBytes > maxTransientBytes && hasEvictableEntry()) evictLRU();
}
