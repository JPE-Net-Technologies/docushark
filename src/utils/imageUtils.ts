/**
 * Image utilities for upload, resize, and optimization.
 */

/**
 * Maximum image dimensions for resizing.
 */
export const MAX_IMAGE_WIDTH = 2000;
export const MAX_IMAGE_HEIGHT = 2000;

/**
 * Maximum file size in bytes (10MB).
 */
export const MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * Supported image MIME types.
 */
export const SUPPORTED_IMAGE_TYPES = [
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/svg+xml',
];

/**
 * Validate an image file.
 *
 * @param file - File to validate
 * @returns Error message if invalid, null if valid
 */
export function validateImageFile(file: File): string | null {
  // Check file type
  if (!SUPPORTED_IMAGE_TYPES.includes(file.type)) {
    return `Unsupported image type: ${file.type}. Supported types: JPEG, PNG, GIF, WebP, SVG`;
  }

  // Check file size
  if (file.size > MAX_FILE_SIZE) {
    const sizeMB = (file.size / (1024 * 1024)).toFixed(2);
    const maxMB = (MAX_FILE_SIZE / (1024 * 1024)).toFixed(0);
    return `Image too large: ${sizeMB}MB. Maximum size: ${maxMB}MB`;
  }

  return null;
}

/**
 * Resize an image if it exceeds maximum dimensions.
 * Maintains aspect ratio.
 *
 * @param blob - Original image blob
 * @param maxWidth - Maximum width (default: MAX_IMAGE_WIDTH)
 * @param maxHeight - Maximum height (default: MAX_IMAGE_HEIGHT)
 * @returns Resized image blob or original if no resize needed
 */
export async function resizeImage(
  blob: Blob,
  maxWidth = MAX_IMAGE_WIDTH,
  maxHeight = MAX_IMAGE_HEIGHT
): Promise<Blob> {
  // SVG images don't need resizing
  if (blob.type === 'image/svg+xml') {
    return blob;
  }

  return new Promise((resolve, reject) => {
    const img = new Image();
    const objectUrl = URL.createObjectURL(blob);

    img.onload = () => {
      URL.revokeObjectURL(objectUrl);

      // Check if resize is needed
      if (img.width <= maxWidth && img.height <= maxHeight) {
        resolve(blob);
        return;
      }

      // Calculate new dimensions maintaining aspect ratio
      let newWidth = img.width;
      let newHeight = img.height;

      if (newWidth > maxWidth) {
        newHeight = (newHeight * maxWidth) / newWidth;
        newWidth = maxWidth;
      }

      if (newHeight > maxHeight) {
        newWidth = (newWidth * maxHeight) / newHeight;
        newHeight = maxHeight;
      }

      // Create canvas and resize
      const canvas = document.createElement('canvas');
      canvas.width = newWidth;
      canvas.height = newHeight;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      ctx.drawImage(img, 0, 0, newWidth, newHeight);

      // Convert to blob
      canvas.toBlob(
        (resizedBlob) => {
          if (!resizedBlob) {
            reject(new Error('Failed to create resized blob'));
            return;
          }
          resolve(resizedBlob);
        },
        blob.type,
        0.9 // Quality for JPEG
      );
    };

    img.onerror = () => {
      URL.revokeObjectURL(objectUrl);
      reject(new Error('Failed to load image'));
    };

    img.src = objectUrl;
  });
}

/**
 * Process an image file for upload.
 * Validates, resizes if needed, and returns blob ready for storage.
 *
 * @param file - Image file to process
 * @returns Processed blob and metadata
 * @throws Error if validation or processing fails
 */
export async function processImageForUpload(file: File): Promise<{
  blob: Blob;
  name: string;
  originalSize: number;
  processedSize: number;
  wasResized: boolean;
}> {
  // Validate
  const error = validateImageFile(file);
  if (error) {
    throw new Error(error);
  }

  const originalSize = file.size;

  // Resize if needed
  const processedBlob = await resizeImage(file);

  return {
    blob: processedBlob,
    name: file.name,
    originalSize,
    processedSize: processedBlob.size,
    wasResized: processedBlob.size !== originalSize,
  };
}

/**
 * Create a thumbnail from an image blob.
 * Useful for preview UI.
 *
 * @param blob - Image blob
 * @param maxSize - Maximum width/height (default: 100)
 * @returns Data URL of thumbnail
 */
export async function createThumbnail(blob: Blob, maxSize = 100): Promise<string> {
  const resized = await resizeImage(blob, maxSize, maxSize);
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Failed to read thumbnail'));
    reader.readAsDataURL(resized);
  });
}
