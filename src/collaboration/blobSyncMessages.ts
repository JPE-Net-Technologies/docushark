/**
 * Pure message formatting for the blob-sync progress toast + integrity
 * failures. Kept free of stores/services so wording and pluralization are
 * unit-testable.
 */

export interface BlobSyncActivity {
  kind: 'upload' | 'download';
  /** 1-based item being processed (uploads) or in-flight count (downloads). */
  current: number;
  /** Total items in the burst; 0 = unknown (downloads resolve lazily). */
  total: number;
}

export function blobSyncMessage(activity: BlobSyncActivity): string {
  if (activity.kind === 'upload') {
    return `Syncing files ${Math.min(activity.current, activity.total)}/${activity.total}`;
  }
  const n = activity.current;
  return n === 1 ? 'Downloading 1 file' : `Downloading ${n} files`;
}

export const BLOB_SYNC_DONE_MESSAGE = 'File sync complete';

export function integrityFailureMessage(count: number): string {
  return count === 1
    ? '1 file failed integrity verification and was not saved'
    : `${count} files failed integrity verification and were not saved`;
}
