/**
 * Reference import + dedup (JP-89 slice 2).
 *
 * Bridges {@link ingest} output into the per-document reference library
 * (`referenceStore`): drop items that already exist (by DOI, then by id), then
 * upsert the rest. Kept separate from `ingest.ts` so the parsers stay pure and
 * store-free; the pure `dedupeReferences` is exported for direct testing.
 */

import type { CSLItem } from '../../types/Citation';
import { useReferenceStore } from '../../store/referenceStore';

export interface DedupeResult {
  /** Incoming items not already present in `existing`. */
  unique: CSLItem[];
  /** Incoming items that duplicate an existing reference. */
  duplicates: CSLItem[];
}

export interface ImportResult {
  added: number;
  duplicates: number;
}

/** Lower-cased DOI, or `null` when absent — DOIs are case-insensitive. */
function doiKey(item: CSLItem): string | null {
  return typeof item.DOI === 'string' && item.DOI.trim() ? item.DOI.trim().toLowerCase() : null;
}

/**
 * Split `incoming` into items new to `existing` vs duplicates. An item is a
 * duplicate if it shares a DOI (case-insensitive) or an `id` with an existing
 * reference, or with an earlier-seen incoming item (so a batch dedups itself).
 */
export function dedupeReferences(existing: CSLItem[], incoming: CSLItem[]): DedupeResult {
  const seenDois = new Set<string>();
  const seenIds = new Set<string>();
  for (const item of existing) {
    const doi = doiKey(item);
    if (doi) seenDois.add(doi);
    seenIds.add(item.id);
  }

  const unique: CSLItem[] = [];
  const duplicates: CSLItem[] = [];
  for (const item of incoming) {
    const doi = doiKey(item);
    const isDup = (doi !== null && seenDois.has(doi)) || seenIds.has(item.id);
    if (isDup) {
      duplicates.push(item);
      continue;
    }
    unique.push(item);
    if (doi) seenDois.add(doi);
    seenIds.add(item.id);
  }
  return { unique, duplicates };
}

/**
 * Dedup `incoming` against the current document's library and upsert the new
 * ones into `referenceStore`. Returns how many were added vs skipped.
 */
export function importReferences(incoming: CSLItem[]): ImportResult {
  const store = useReferenceStore.getState();
  const { unique, duplicates } = dedupeReferences(store.listReferences(), incoming);
  for (const item of unique) {
    store.upsertReference(item);
  }
  return { added: unique.length, duplicates: duplicates.length };
}
