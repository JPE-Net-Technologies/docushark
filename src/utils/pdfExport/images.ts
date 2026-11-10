/**
 * Image loading and sizing for PDF export: blobs to data URLs, SVG to PNG,
 * formats and scaled dimensions.
 */

import type { JSONContent } from '@tiptap/core';
import { blobStorage } from '../../storage/BlobStorage';
import type { ImageFormat } from 'jspdf';
import type { PDFRenderContext } from './context';

/**
 * Load all embedded images from content as data URLs.
 */
export async function loadEmbeddedImages(content: JSONContent): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  const blobIds = extractBlobIds(content);

  for (const blobId of blobIds) {
    const dataUrl = await loadBlobAsDataUrl(blobId);
    if (dataUrl) {
      images.set(blobId, dataUrl);
    }
  }

  return images;
}

/**
 * Extract all blob IDs from content (recursive).
 */
function extractBlobIds(node: JSONContent): string[] {
  const ids: string[] = [];

  if (node.type === 'image' && node.attrs?.['src']) {
    const src = node.attrs['src'] as string;
    if (src.startsWith('blob://')) {
      ids.push(src.slice(7)); // Remove 'blob://' prefix
    }
  }

  if (node.content) {
    for (const child of node.content) {
      ids.push(...extractBlobIds(child));
    }
  }

  return ids;
}

/**
 * Load a blob as a data URL.
 */
export async function loadBlobAsDataUrl(blobId: string): Promise<string | null> {
  try {
    const blob = await blobStorage.loadBlob(blobId);
    if (!blob) return null;

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(reader.result as string);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('Failed to load blob:', blobId, error);
    return null;
  }
}

/**
 * Image dimensions result.
 */
interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Check if a data URL is an SVG image.
 */
export function isSvgDataUrl(dataUrl: string): boolean {
  return dataUrl.startsWith('data:image/svg+xml');
}

/**
 * Convert an SVG data URL to a PNG data URL using canvas.
 * This is needed because jsPDF doesn't support SVG directly.
 */
export async function convertSvgToPng(svgDataUrl: string, scale: number = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Create canvas with scaled dimensions for better quality
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth * scale;
      canvas.height = img.naturalHeight * scale;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      // Draw SVG to canvas
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);

      // Convert to PNG data URL
      const pngDataUrl = canvas.toDataURL('image/png');
      resolve(pngDataUrl);
    };
    img.onerror = () => {
      reject(new Error('Failed to load SVG image'));
    };
    img.src = svgDataUrl;
  });
}

/**
 * Extract image format from a data URL.
 * Returns format suitable for jsPDF addImage (JPEG, PNG, GIF, WEBP).
 */
export function getImageFormat(dataUrl: string): ImageFormat {
  const match = dataUrl.match(/^data:image\/([^;]+);/);
  if (match && match[1]) {
    const mimeSubtype = match[1].toLowerCase();

    // Map common formats to jsPDF ImageFormat
    if (mimeSubtype === 'jpeg' || mimeSubtype === 'jpg') return 'JPEG';
    if (mimeSubtype === 'png') return 'PNG';
    if (mimeSubtype === 'gif') return 'GIF89a';
    if (mimeSubtype === 'bmp') return 'BMP';
    if (mimeSubtype === 'webp') return 'WEBP';
  }
  // Default to PNG
  return 'PNG';
}

/**
 * Get image dimensions from a data URL.
 * Returns dimensions in pixels.
 */
export async function getImageDimensions(dataUrl: string): Promise<ImageDimensions> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      reject(new Error('Failed to load image'));
    };
    img.src = dataUrl;
  });
}

/**
 * Calculate scaled dimensions to fit within max bounds while preserving aspect ratio.
 * @param width - Original width in pixels
 * @param height - Original height in pixels
 * @param maxWidth - Maximum width in mm
 * @param maxHeight - Maximum height in mm
 * @returns Scaled dimensions in mm
 */
export function calculateScaledDimensions(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  // Convert pixels to mm (assuming 96 DPI for screen images)
  const pxToMm = 25.4 / 96;
  let imgWidthMm = width * pxToMm;
  let imgHeightMm = height * pxToMm;

  // Scale down if needed, preserving aspect ratio
  if (imgWidthMm > maxWidth) {
    const scale = maxWidth / imgWidthMm;
    imgWidthMm = maxWidth;
    imgHeightMm *= scale;
  }

  if (imgHeightMm > maxHeight) {
    const scale = maxHeight / imgHeightMm;
    imgHeightMm = maxHeight;
    imgWidthMm *= scale;
  }

  return { width: imgWidthMm, height: imgHeightMm };
}

/** Load an image node's data URL (blob:// or data:), converting SVG → PNG. */
export async function loadPdfImage(
  ctx: PDFRenderContext,
  src: string | undefined,
): Promise<{ dataUrl: string; width: number; height: number } | null> {
  if (!src) return null;
  let dataUrl: string | undefined;
  if (src.startsWith('blob://')) dataUrl = ctx.images.get(src.slice(7));
  else if (src.startsWith('data:')) dataUrl = src;
  if (!dataUrl) return null;
  if (isSvgDataUrl(dataUrl)) dataUrl = await convertSvgToPng(dataUrl);
  const dim = await getImageDimensions(dataUrl);
  return { dataUrl, width: dim.width, height: dim.height };
}
