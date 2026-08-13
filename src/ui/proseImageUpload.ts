/**
 * Shared prose-image upload pipeline.
 *
 * Both the toolbar/slash "Upload image" button and the context-menu "Replace
 * image" action funnel a picked File through the same flow: validate + resize,
 * persist to content-addressed blob storage, and hand back a `blob://` src ready
 * to drop into the Tiptap image node.
 */

import { blobStorage } from '../storage/BlobStorage';
import { assertUploadable } from '../storage/uploadLimits';
import { processImageForUpload } from '../utils/imageUtils';

/** `accept` attribute for image file inputs — the formats we can process. */
export const IMAGE_FILE_ACCEPT = 'image/jpeg,image/jpg,image/png,image/gif,image/webp,image/svg+xml';

export interface UploadedProseImage {
  /** `blob://<id>` src for the image node. */
  src: string;
  /** Suggested alt text (the processed file name). */
  alt: string;
  /** Whether the source image was downscaled to fit the size limits. */
  wasResized: boolean;
  originalSize: number;
  processedSize: number;
}

/**
 * Process and store an image file, returning its `blob://` src + metadata.
 * Throws if the file is invalid or storage fails (callers surface the error).
 */
export async function uploadProseImage(file: File): Promise<UploadedProseImage> {
  // `processImageForUpload` enforces its own, stricter `MAX_FILE_SIZE` (10 MiB)
  // because a source image gets downscaled anyway. What it never did was check
  // whether the result FITS — so an image upload could push storage past quota
  // while a file upload could exhaust memory. Both paths now do both (JP-496).
  await assertUploadable(file);
  const { blob, name, originalSize, processedSize, wasResized } = await processImageForUpload(file);
  const blobId = await blobStorage.saveBlob(blob, name);
  return { src: `blob://${blobId}`, alt: name, wasResized, originalSize, processedSize };
}
