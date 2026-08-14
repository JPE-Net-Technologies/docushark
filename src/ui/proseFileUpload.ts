/**
 * Shared prose-file upload pipeline (JP-495).
 *
 * The file counterpart of `proseImageUpload.ts`: persist a picked File to
 * content-addressed blob storage and hand back the attributes a `fileRef` chip
 * needs. There is no processing step — an attachment is stored byte-for-byte,
 * unlike an image, which gets validated and downscaled.
 *
 * `assertUploadable` is the gate every user-pick path shares (JP-496): a size
 * ceiling *and* a quota check. This path originally had only the quota half,
 * which left the real hazard open — `BlobStorage.computeHash` buffers the whole
 * file to hash it, so an attachment large enough to matter took the tab down
 * rather than being refused.
 */

import { blobStorage } from '../storage/BlobStorage';
import { assertUploadable } from '../storage/uploadLimits';
import type { FileRefAttrs } from '../tiptap/FileRefExtension';

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
  await assertUploadable(file);

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
