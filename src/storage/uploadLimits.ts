/**
 * One gate for every file a **user picks** (JP-496).
 *
 * Before this, each pick path enforced a different half of the same contract:
 *
 * | path | size ceiling | quota check |
 * |---|---|---|
 * | prose image (`proseImageUpload`) | 10 MiB, via `processImageForUpload` | no |
 * | gallery (`GalleryUploadButton`)  | 10 MiB, via `processImageForUpload` | no |
 * | prose file (`proseFileUpload`)   | none | yes |
 * | canvas import (`FileImportService`) | none | yes |
 * | replace contents (`FileReplaceService`) | none | yes |
 * | logo (`LogoPicker`)              | none | no |
 *
 * Both halves matter, and they fail differently:
 *
 * - **No ceiling → the tab dies.** `BlobStorage.computeHash` does
 *   `await blob.arrayBuffer()`, pulling the entire file into memory before
 *   hashing. A multi-GB attachment doesn't get refused, it OOMs the page and
 *   takes unsaved work with it.
 * - **No quota check → the write fails late,** after the file has been read and
 *   hashed, with an IndexedDB error rather than an explanation.
 *
 * ## Why the gate is here and not inside `saveBlob`
 *
 * `saveBlob` looks like the tempting choke point, but most of its callers are
 * moving bytes that already exist and are already the user's: restoring a
 * backup (`BackupImportService`), unpacking an archive
 * (`DocumentArchiveService`), receiving a peer's blob (`BlobSyncService`), the
 * icon library. A ceiling there would refuse to restore a document it had
 * happily created. The limit belongs at "a human just chose this file", which
 * is what this module gates.
 */

import { hasSpaceForBlob } from './StorageQuotaMonitor';
import { formatFileSize } from '../utils/byteSize';

/**
 * Largest file a user may attach, mirroring the relay's
 * `DEFAULT_MAX_BLOB_BYTES` (`relay/src/config.rs`) so a file that stores
 * locally can also sync. A deployment that lowers `RELAY_MAX_BLOB_BYTES` below
 * this would still 413 on upload — the relay does not advertise its limit to
 * clients, and teaching it to is a wire change, not this one.
 *
 * It is also the practical memory ceiling: `computeHash` buffers the whole file,
 * so this bounds peak upload RAM at roughly this figure.
 */
export const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

/** A picked file that cannot be stored, with a reason fit to show a user. */
export class UploadRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UploadRejectedError';
  }
}

/**
 * Why `file` cannot be stored, or `null` if it can.
 *
 * Returns rather than throws so a batch importer can collect one reason per
 * file and keep going; [`assertUploadable`] is the throwing form for single-file
 * paths.
 *
 * The ceiling is checked first and synchronously: the quota check does a
 * `navigator.storage.estimate()` round-trip, and an obviously-too-large file
 * should be refused without waiting for it.
 */
export async function uploadRejectionReason(file: { size: number }): Promise<string | null> {
  if (file.size > MAX_UPLOAD_BYTES) {
    const limit = formatFileSize(MAX_UPLOAD_BYTES);
    const actual = formatFileSize(file.size);
    // A file barely over the limit formats to the SAME string as the limit, and
    // "This file is 150.0 MB, over the 150.0 MB limit" reads as a bug rather
    // than a rule. Found in live testing at exactly limit+1 byte; the unit test
    // used round numbers and never saw it.
    return actual === limit
      ? `This file is just over the ${limit} limit for a single attachment.`
      : `This file is ${actual}, over the ${limit} limit for a single attachment.`;
  }
  // `hasSpaceForBlob` raises its own notification on failure — it is the
  // established quota gate, and duplicating its message here would double up.
  if (!(await hasSpaceForBlob(file.size))) {
    return 'Not enough local storage space for this file.';
  }
  return null;
}

/** [`uploadRejectionReason`], as a throw. */
export async function assertUploadable(file: { size: number }): Promise<void> {
  const reason = await uploadRejectionReason(file);
  if (reason !== null) throw new UploadRejectedError(reason);
}
