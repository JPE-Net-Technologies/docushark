/**
 * Thumbnail generation service for embedded file shapes.
 *
 * Generates preview thumbnails asynchronously. Runs on the main thread
 * (no Web Workers currently in the codebase). Thumbnails are stored as
 * base64 JPEG data URLs on the shape's preview field.
 */

import { detectFileCategory } from '../utils/fileUtils';

/** Result from thumbnail generation */
export interface ThumbnailResult {
  /** Base64 data URL of the thumbnail (JPEG) */
  thumbnail: string;
  /** Number of pages (for PDFs and multi-page docs) */
  pageCount?: number | undefined;
  /** Original content dimensions in pixels */
  dimensions?: { width: number; height: number } | undefined;
}

/** Maximum thumbnail width in pixels */
const MAX_THUMBNAIL_WIDTH = 400;
/** Maximum thumbnail height in pixels */
const MAX_THUMBNAIL_HEIGHT = 300;
/** JPEG quality for thumbnails (0-1) */
const THUMBNAIL_QUALITY = 0.7;

/**
 * Generate a preview thumbnail for an embedded file.
 *
 * Returns null for file types that don't support previews.
 * Thumbnail generation is async and non-blocking.
 *
 * @param blob - The file blob
 * @param mimeType - MIME type of the file
 * @param fileName - Original filename
 * @returns Thumbnail result or null if no preview available
 */
export async function generateThumbnail(
  blob: Blob,
  mimeType: string,
  fileName: string,
): Promise<ThumbnailResult | null> {
  const category = detectFileCategory(mimeType, fileName);

  switch (category) {
    case 'image':
      return generateImageThumbnail(blob);
    case 'pdf':
      return generatePdfThumbnail(blob);
    case 'text':
      return generateTextThumbnail(blob);
    default:
      return null;
  }
}

/**
 * Generate thumbnail for image files by scaling to fit max dimensions.
 */
async function generateImageThumbnail(blob: Blob): Promise<ThumbnailResult | null> {
  try {
    const imageBitmap = await createImageBitmap(blob);
    const { width: origW, height: origH } = imageBitmap;

    // Calculate scaled dimensions maintaining aspect ratio
    const scale = Math.min(
      MAX_THUMBNAIL_WIDTH / origW,
      MAX_THUMBNAIL_HEIGHT / origH,
      1, // Don't upscale
    );
    const width = Math.round(origW * scale);
    const height = Math.round(origH * scale);

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) {
      imageBitmap.close();
      return null;
    }

    ctx.drawImage(imageBitmap, 0, 0, width, height);
    imageBitmap.close();

    const thumbnailBlob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: THUMBNAIL_QUALITY,
    });

    const thumbnail = await blobToDataUrl(thumbnailBlob);

    return {
      thumbnail,
      dimensions: { width: origW, height: origH },
    };
  } catch (error) {
    console.warn('Failed to generate image thumbnail:', error);
    return null;
  }
}

/**
 * Generate thumbnail for PDF files by rendering page 1.
 * Lazy-loads pdf.js to keep bundle size small.
 */
async function generatePdfThumbnail(blob: Blob): Promise<ThumbnailResult | null> {
  try {
    const pdfjsLib = await import('pdfjs-dist');

    // Configure worker — use the bundled worker via import.meta.url.
    // Falls back to running without a worker if resolution fails at build time.
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
    }

    const arrayBuffer = await blob.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });
    const pdf = await loadingTask.promise;
    const pageCount = pdf.numPages;

    // Render first page
    const page = await pdf.getPage(1);
    const viewport = page.getViewport({ scale: 1 });

    // Scale to fit max thumbnail dimensions
    const scale = Math.min(
      MAX_THUMBNAIL_WIDTH / viewport.width,
      MAX_THUMBNAIL_HEIGHT / viewport.height,
      1,
    );
    const scaledViewport = page.getViewport({ scale });

    const canvas = new OffscreenCanvas(
      Math.round(scaledViewport.width),
      Math.round(scaledViewport.height),
    );
    const ctx = canvas.getContext('2d') as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) {
      pdf.destroy();
      return null;
    }

    await page.render({
      canvas: null,
      canvasContext: ctx as unknown as CanvasRenderingContext2D,
      viewport: scaledViewport,
    }).promise;

    pdf.destroy();

    const thumbnailBlob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: THUMBNAIL_QUALITY,
    });

    const thumbnail = await blobToDataUrl(thumbnailBlob);

    return {
      thumbnail,
      pageCount,
      dimensions: {
        width: Math.round(viewport.width),
        height: Math.round(viewport.height),
      },
    };
  } catch (error) {
    console.warn('Failed to generate PDF thumbnail:', error);
    return null;
  }
}

/**
 * Generate a simple text preview thumbnail.
 * Renders the first ~20 lines in a monospace font.
 */
async function generateTextThumbnail(blob: Blob): Promise<ThumbnailResult | null> {
  try {
    // Only preview first 4KB to avoid processing huge files
    const slice = blob.slice(0, 4096);
    const text = await slice.text();
    const lines = text.split('\n').slice(0, 20);

    const canvas = new OffscreenCanvas(MAX_THUMBNAIL_WIDTH, MAX_THUMBNAIL_HEIGHT);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Render text
    const fontSize = 11;
    const lineHeight = fontSize * 1.4;
    const padding = 12;
    ctx.fillStyle = '#374151';
    ctx.font = `${fontSize}px monospace`;

    for (let i = 0; i < lines.length; i++) {
      const y = padding + (i + 1) * lineHeight;
      if (y > canvas.height - padding) break;
      const line = lines[i] ?? '';
      ctx.fillText(line.slice(0, 60), padding, y);
    }

    const thumbnailBlob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: THUMBNAIL_QUALITY,
    });

    const thumbnail = await blobToDataUrl(thumbnailBlob);

    return { thumbnail };
  } catch (error) {
    console.warn('Failed to generate text thumbnail:', error);
    return null;
  }
}

/**
 * Convert a Blob to a base64 data URL.
 */
function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
