/**
 * Shared prose-file upload pipeline (JP-495).
 *
 * The file counterpart of `proseImageUpload.ts`: persist a picked File to
 * content-addressed blob storage and hand back the attributes a `fileRef` chip
 * needs. There is no processing step — an attachment is stored byte-for-byte,
 * unlike an image, which gets validated and downscaled.
 *
 * The quota check is the gate images get for free from `processImageForUpload`
 * (which enforces `MAX_FILE_SIZE`). A raw attachment has no such ceiling, so
 * without this a single large file could fill IndexedDB. `hasSpaceForBlob` is
 * the same gate the canvas import path uses (`FileImportService`) — quota-aware
 * rather than a fixed cap, so prose and canvas can't disagree about what fits.
 */

import { blobStorage } from '../storage/BlobStorage';
import { hasSpaceForBlob } from '../storage/StorageQuotaMonitor';
import type { FileRefAttrs } from '../tiptap/FileRefExtension';

export class ProseFileQuotaError extends Error {
  constructor() {
    super('Not enough local storage space for this file.');
    this.name = 'ProseFileQuotaError';
  }
}

/**
 * Store `file` and return the chip attributes for it.
 *
 * `blobRef` comes back in the **`blob://<hash>` URI form**, not a bare hash: the
 * attribute is serialized inside an HTML string, and only that grammar is
 * discoverable by the blob reference walk. Storing a bare hash would leave the
 * blob invisible to refcounting, the publish manifest, and the MCP file tools —
 * none of which fail loudly (JP-494).
 */
export async function uploadProseFile(file: File): Promise<FileRefAttrs> {
  if (!(await hasSpaceForBlob(file.size))) {
    throw new ProseFileQuotaError();
  }

  const blobId = await blobStorage.saveBlob(file, file.name);

  return {
    blobRef: `blob://${blobId}`,
    fileName: file.name,
    // A browser leaves `type` empty for unknown extensions; the chip and viewer
    // both fall back to filename-based detection, so an empty string is a
    // truthful "unknown" rather than a guess.
    mimeType: file.type,
    fileSize: String(file.size),
  };
}
