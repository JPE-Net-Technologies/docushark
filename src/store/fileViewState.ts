/**
 * fileViewState — pure reducers for per-user file reading state (last-viewed
 * page, zoom mode, page bookmarks), keyed `docId:shapeId`. Deliberately free
 * of zustand/pdf.js so ordering, eviction, and staleness reconciliation are
 * unit-testable; fileViewStateStore.ts is the thin persisted wrapper.
 *
 * Reading state is per-user and local-only — it never enters the document or
 * the CRDT (a collaborator's page turns must not sync-fight or dirty the doc).
 */

export interface PdfBookmark {
  /** 1-based page number. */
  page: number;
  /** Optional user label; absent = show "Page N". */
  label?: string;
  createdAt: number;
}

export type FileViewZoomMode = 'page-width' | 'page-fit' | 'custom';

export interface FileViewRecord {
  /** Content hash (`FileShape.blobRef`) the state was recorded against. */
  hash: string;
  /** 1-based last-viewed page. */
  lastPage: number;
  zoomMode: FileViewZoomMode;
  /** Numeric zoom (percent) when zoomMode is 'custom'. */
  zoomPercent?: number;
  bookmarks: PdfBookmark[];
  updatedAt: number;
}

/** Hard cap on stored records; oldest bookmark-less records evict first. */
export const MAX_VIEW_RECORDS = 200;

export function viewKey(docId: string, shapeId: string): string {
  return `${docId}:${shapeId}`;
}

function defaultRecord(now: number): FileViewRecord {
  return { hash: '', lastPage: 1, zoomMode: 'page-width', bookmarks: [], updatedAt: now };
}

/**
 * Merge `patch` into the record at `key` (creating it if absent), stamp
 * `updatedAt`, and evict down to `cap`. Eviction prefers records WITHOUT
 * bookmarks first (a bookmarked file is user-invested; don't silently drop it
 * before trivially-opened ones), oldest `updatedAt` first within each class.
 * The just-updated key is never evicted.
 */
export function upsertRecord(
  records: Record<string, FileViewRecord>,
  key: string,
  patch: Partial<Omit<FileViewRecord, 'updatedAt'>>,
  now: number,
  cap: number = MAX_VIEW_RECORDS,
): Record<string, FileViewRecord> {
  const existing = records[key] ?? defaultRecord(now);
  const next: Record<string, FileViewRecord> = {
    ...records,
    [key]: { ...existing, ...patch, updatedAt: now },
  };

  const keys = Object.keys(next);
  if (keys.length <= cap) return next;

  const evictable = keys
    .filter((k) => k !== key)
    .sort((a, b) => {
      const ra = next[a] as FileViewRecord;
      const rb = next[b] as FileViewRecord;
      const aHasBookmarks = ra.bookmarks.length > 0 ? 1 : 0;
      const bHasBookmarks = rb.bookmarks.length > 0 ? 1 : 0;
      if (aHasBookmarks !== bHasBookmarks) return aHasBookmarks - bHasBookmarks;
      return ra.updatedAt - rb.updatedAt;
    });

  for (const k of evictable) {
    if (Object.keys(next).length <= cap) break;
    delete next[k];
  }
  return next;
}

/** Toggle a bookmark on `page`: present → removed; absent → appended. */
export function toggleBookmark(
  bookmarks: PdfBookmark[],
  page: number,
  now: number,
): PdfBookmark[] {
  if (bookmarks.some((b) => b.page === page)) {
    return bookmarks.filter((b) => b.page !== page);
  }
  return [...bookmarks, { page, createdAt: now }].sort((a, b) => a.page - b.page);
}

/** Set (or clear, with an empty string) the label of the bookmark on `page`. */
export function renameBookmark(
  bookmarks: PdfBookmark[],
  page: number,
  label: string,
): PdfBookmark[] {
  const trimmed = label.trim();
  return bookmarks.map((b) => {
    if (b.page !== page) return b;
    if (trimmed === '') {
      const { label: _dropped, ...rest } = b;
      return rest;
    }
    return { ...b, label: trimmed };
  });
}

export function removeBookmark(bookmarks: PdfBookmark[], page: number): PdfBookmark[] {
  return bookmarks.filter((b) => b.page !== page);
}

/**
 * Reconcile a stored record against the file's current content hash and live
 * page count. When the hash differs (the file was replaced upstream), clamp
 * `lastPage` and drop bookmarks past the new end — in-range bookmarks are kept
 * as still-useful anchors even though their labels may be semantically stale —
 * and rewrite `hash` so the clamp happens once per replacement. Returns the
 * input record unchanged (same reference) when nothing needs fixing.
 */
export function reconcileRecord(
  record: FileViewRecord,
  currentHash: string,
  numPages: number,
): FileViewRecord {
  const maxPage = Math.max(1, numPages);
  if (record.hash === currentHash) {
    // Same content; still defend against a corrupt lastPage.
    if (record.lastPage <= maxPage && record.lastPage >= 1) return record;
    return { ...record, lastPage: Math.min(maxPage, Math.max(1, record.lastPage)) };
  }
  return {
    ...record,
    hash: currentHash,
    lastPage: Math.min(maxPage, Math.max(1, record.lastPage)),
    bookmarks: record.bookmarks.filter((b) => b.page <= maxPage),
  };
}
