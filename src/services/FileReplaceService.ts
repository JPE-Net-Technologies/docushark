/**
 * FileReplaceService — handles replacing the content of an existing FileShape
 * while preserving its geometry (position, size, rotation).
 */

import type { FileShape, FileCategory } from '../shapes/Shape';
import { isFile } from '../shapes/Shape';
import { blobStorage } from '../storage/BlobStorage';
import { hasSpaceForBlob } from '../storage/StorageQuotaMonitor';
import { useDocumentStore } from '../store/documentStore';
import { useHistoryStore } from '../store/historyStore';
import { useNotificationStore } from '../store/notificationStore';
import {
  detectFileCategory,
  getMimeType,
  sanitizeFileName,
  validateFileForEmbed,
} from '../utils/fileUtils';
import { generateThumbnail, type ThumbnailResult } from './ThumbnailGenerator';
import { validateFileIntegrity } from './FileIntegrityValidator';

export interface ReplaceResult {
  success: boolean;
  error?: string | undefined;
  /** The new blob reference if successful */
  newBlobRef?: string | undefined;
}

/**
 * Replace the file content of a FileShape while preserving its geometry.
 *
 * This function:
 * 1. Validates the new file
 * 2. Stores the new blob
 * 3. Generates a thumbnail (best-effort)
 * 4. Updates the shape with new file metadata
 * 5. The old blob will be garbage collected if orphaned
 *
 * @param shapeId - The ID of the FileShape to update
 * @param newFile - The replacement file
 * @returns Result indicating success or failure
 */
export async function replaceFileContents(
  shapeId: string,
  newFile: File
): Promise<ReplaceResult> {
  const shapes = useDocumentStore.getState().shapes;
  const shape = shapes[shapeId];

  // Validate shape exists and is a FileShape
  if (!shape) {
    return { success: false, error: 'Shape not found' };
  }
  if (!isFile(shape)) {
    return { success: false, error: 'Shape is not a file shape' };
  }

  const sanitizedName = sanitizeFileName(newFile.name);

  // Validate file
  const validationError = validateFileForEmbed(newFile);
  if (validationError !== null) {
    return { success: false, error: validationError };
  }

  // Check storage quota
  const hasSpace = await hasSpaceForBlob(newFile.size);
  if (!hasSpace) {
    return { success: false, error: 'Storage quota exceeded' };
  }

  try {
    // Determine MIME type
    const extensionMime = getMimeType(newFile.name);
    const mimeType =
      extensionMime !== 'application/octet-stream'
        ? extensionMime
        : newFile.type || extensionMime;
    const fileCategory: FileCategory = detectFileCategory(mimeType, sanitizedName);

    // Validate file integrity (detect corrupt files early)
    const integrityResult = await validateFileIntegrity(
      new Blob([newFile], { type: mimeType }),
      fileCategory,
      mimeType
    );
    if (!integrityResult.valid) {
      return {
        success: false,
        error: integrityResult.error ?? 'File appears to be corrupt',
      };
    }

    // Push history before making changes
    useHistoryStore.getState().push('Replace file');

    // Store the new blob
    const newBlobRef = await blobStorage.saveBlob(
      new Blob([newFile], { type: mimeType }),
      sanitizedName
    );

    // Generate thumbnail (best-effort)
    let thumbnail: ThumbnailResult | null = null;
    try {
      thumbnail = await generateThumbnail(
        new Blob([newFile], { type: mimeType }),
        mimeType,
        sanitizedName
      );
    } catch {
      // Thumbnail failure is non-fatal
    }

    // Prepare update payload — preserve geometry
    const update: Partial<FileShape> = {
      blobRef: newBlobRef,
      fileName: sanitizedName,
      mimeType,
      fileSize: newFile.size,
      fileCategory,
    };

    // Update preview if thumbnail was generated
    if (thumbnail) {
      update.preview = {
        thumbnail: thumbnail.thumbnail,
        ...(thumbnail.pageCount !== undefined && { pageCount: thumbnail.pageCount }),
        ...(thumbnail.dimensions !== undefined && { dimensions: thumbnail.dimensions }),
      };
    }

    // Update the shape
    useDocumentStore.getState().updateShape(shapeId, update);

    // Note: Old blob will be garbage collected by BlobGarbageCollector
    // when it's no longer referenced by any shape

    useNotificationStore.getState().success(`Replaced file with ${sanitizedName}`);

    return { success: true, newBlobRef };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : String(err);
    useNotificationStore.getState().error(`Failed to replace file: ${errorMessage}`);
    return { success: false, error: errorMessage };
  }
}

/**
 * Re-upload a file to recover a missing blob reference.
 *
 * Similar to replace, but specifically for recovery scenarios where
 * the original blob was lost (e.g., storage corruption, sync issues).
 *
 * @param shapeId - The ID of the FileShape to recover
 * @param file - The file to upload
 * @returns Result indicating success or failure
 */
export async function reuploadMissingBlob(
  shapeId: string,
  file: File
): Promise<ReplaceResult> {
  // Reuse the replace logic - it handles all the validation and updates
  const result = await replaceFileContents(shapeId, file);

  if (result.success) {
    useNotificationStore.getState().success('File recovered successfully');
  }

  return result;
}
