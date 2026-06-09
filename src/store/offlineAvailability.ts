/**
 * offlineAvailability — per-document "is this safe offline?" status plus the
 * "Make available offline" prefetch action (JP-281).
 *
 * Blob caching is otherwise *view-driven*: only assets the user actually renders
 * get pulled down (blobResolver's download-on-miss), so an unviewed file in a
 * relay/collab document is missing when offline. This module computes a
 * document's offline-ready status (body cached + every referenced blob present)
 * and lets the user proactively pull a whole document's asset set into the local
 * IndexedDB cache. Enumeration is reliable because the relay snapshot now
 * derives `blobReferences` (JP-278), so `collectBlobReferences` sees the full
 * asset set client-side.
 *
 * Status computation is offline-safe — it reads only local caches and never
 * hits the network — so it's cheap to call passively for every visible card.
 */

import { collectBlobReferences } from '../storage/AssetBundler';
import { blobStorage } from '../storage/BlobStorage';
import { RelayDocumentCache } from '../storage/RelayDocumentCache';
import type { DiagramDocument } from '../types/Document';
import type { DocumentRecord } from '../types/DocumentRegistry';
import { useDocumentRegistry } from './documentRegistry';
import { getDocProvider, useRelayDocumentStore } from './relayDocumentStore';

/** Max blob downloads in flight at once during a prefetch. */
const OFFLINE_PREFETCH_CONCURRENCY = 4;

export type OfflineState = 'ready' | 'partial' | 'online-only';

export interface OfflineStatus {
  state: OfflineState;
  /** Referenced blobs whose bytes are present in local storage. */
  present: number;
  /** Total blobs the document references. */
  total: number;
  /** Whether the document body itself is cached locally. */
  bodyCached: boolean;
}

/** Progress of an in-flight {@link makeAvailableOffline} prefetch. */
export interface OfflineProgress {
  done: number;
  total: number;
}

/**
 * Pure mapping from cache facts to an offline state. Exported for testing.
 * - body not cached → the doc can't open offline at all ('online-only')
 * - body cached, no blobs or all present → 'ready'
 * - body cached but some blobs missing → 'partial'
 */
export function deriveOfflineState(
  bodyCached: boolean,
  present: number,
  total: number,
): OfflineState {
  if (!bodyCached) return 'online-only';
  if (total === 0 || present >= total) return 'ready';
  return 'partial';
}

/**
 * Resolve a relay/cached document's body from offline-safe caches only (no
 * network): in-memory store cache → registry content → the persistent offline
 * cache. Returns null when the body isn't cached anywhere locally.
 */
async function loadCachedBody(record: DocumentRecord): Promise<DiagramDocument | null> {
  const relay = useRelayDocumentStore.getState();
  const inMemory = relay.getCachedDocument(record.id);
  if (inMemory) return inMemory;
  const registryDoc = useDocumentRegistry.getState().getDocumentContent(record.id);
  if (registryDoc) return registryDoc;
  return RelayDocumentCache.get(record.id);
}

/** Count how many of `hashes` have their bytes present in local storage. */
async function countPresent(hashes: string[]): Promise<number> {
  const presence = await Promise.all(hashes.map((h) => blobStorage.hasBlob(h)));
  return presence.filter(Boolean).length;
}

/**
 * Compute a document's offline-ready status from local caches only. Local
 * documents are inherently offline-ready (body + blobs already live in local
 * storage); relay/cached documents are inspected for body + blob presence.
 */
export async function computeOfflineStatus(record: DocumentRecord): Promise<OfflineStatus> {
  if (record.type === 'local') {
    return { state: 'ready', present: 0, total: 0, bodyCached: true };
  }

  const body = await loadCachedBody(record);
  if (!body) {
    return { state: 'online-only', present: 0, total: 0, bodyCached: false };
  }

  const refs = collectBlobReferences(body);
  const present = await countPresent(refs);
  return {
    state: deriveOfflineState(true, present, refs.length),
    present,
    total: refs.length,
    bodyCached: true,
  };
}

/** Run `task` over `items` with at most `limit` in flight at a time. */
async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      await task(items[index]!);
    }
  });
  await Promise.all(workers);
}

/**
 * Proactively cache a relay/cached document for offline use: ensure its body is
 * in the offline cache, then download every referenced blob missing locally.
 * Reports progress as blobs are processed and resolves to the final offline
 * status. No-op for local documents (already offline-ready). Best-effort: a blob
 * that fails to download just leaves the document 'partial'.
 */
export async function makeAvailableOffline(
  record: DocumentRecord,
  onProgress?: (progress: OfflineProgress) => void,
): Promise<OfflineStatus> {
  if (record.type === 'local') {
    return { state: 'ready', present: 0, total: 0, bodyCached: true };
  }

  // loadRelayDocument serves (or fetches) the body and writes it to the
  // persistent offline cache as a side effect — that satisfies "body cached".
  const body = await useRelayDocumentStore.getState().loadRelayDocument(record.id);
  const refs = collectBlobReferences(body);
  const total = refs.length;

  const presence = await Promise.all(refs.map((h) => blobStorage.hasBlob(h)));
  const missing = refs.filter((_, i) => !presence[i]);

  let done = total - missing.length;
  onProgress?.({ done, total });

  const provider = getDocProvider();
  if (missing.length > 0 && provider?.downloadBlobs) {
    const downloadBlobs = provider.downloadBlobs.bind(provider);
    await runWithConcurrency(missing, OFFLINE_PREFETCH_CONCURRENCY, async (hash) => {
      try {
        await downloadBlobs([hash]);
      } catch {
        // Best-effort — a failed blob leaves the doc 'partial' on recompute.
      } finally {
        done += 1;
        onProgress?.({ done, total });
      }
    });
  }

  return computeOfflineStatus(record);
}

/**
 * Ensure every blob an already-loaded document references is present in local
 * storage, downloading any that are missing. Resolves to `true` only when *all*
 * referenced blobs are local afterwards.
 *
 * This is the data-safety gate for a relay→personal move: the relay copy (and
 * its blobs) must not be deleted until the bytes are safely local, or the
 * personal doc is left with `blob://` refs whose bytes existed only on the relay
 * — an irreversible loss (the blobResolver can never fetch them again).
 */
export async function ensureDocBlobsLocal(doc: DiagramDocument): Promise<boolean> {
  const refs = collectBlobReferences(doc);
  if (refs.length === 0) return true;

  const presence = await Promise.all(refs.map((h) => blobStorage.hasBlob(h)));
  const missing = refs.filter((_, i) => !presence[i]);

  if (missing.length > 0) {
    const provider = getDocProvider();
    if (provider?.downloadBlobs) {
      const downloadBlobs = provider.downloadBlobs.bind(provider);
      await runWithConcurrency(missing, OFFLINE_PREFETCH_CONCURRENCY, async (hash) => {
        try {
          await downloadBlobs([hash]);
        } catch {
          // Best-effort — the final presence check below decides success.
        }
      });
    }
  }

  const finalPresence = await Promise.all(refs.map((h) => blobStorage.hasBlob(h)));
  return finalPresence.every(Boolean);
}
