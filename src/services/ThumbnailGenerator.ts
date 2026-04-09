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
    case 'spreadsheet':
      return generateSpreadsheetThumbnail(blob);
    case 'generic':
    default:
      return generateGenericThumbnail(mimeType, fileName);
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
 * Generate a simple spreadsheet preview thumbnail.
 * Shows a grid-like representation.
 */
async function generateSpreadsheetThumbnail(blob: Blob): Promise<ThumbnailResult | null> {
  try {
    const XLSX = await import('xlsx');

    // Read only first portion for preview
    const slice = blob.slice(0, 100 * 1024);
    const arrayBuffer = await slice.arrayBuffer();
    const workbook = XLSX.read(arrayBuffer, { type: 'array', sheetRows: 10 });

    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return generateGenericThumbnail('application/vnd.ms-excel', 'spreadsheet');
    }

    const firstSheet = workbook.Sheets[workbook.SheetNames[0]!];
    if (!firstSheet) {
      return generateGenericThumbnail('application/vnd.ms-excel', 'spreadsheet');
    }

    const canvas = new OffscreenCanvas(MAX_THUMBNAIL_WIDTH, MAX_THUMBNAIL_HEIGHT);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // White background
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Draw grid lines
    const cellWidth = 60;
    const cellHeight = 20;
    const headerHeight = 24;
    const padding = 8;

    ctx.strokeStyle = '#e2e8f0';
    ctx.lineWidth = 1;

    // Horizontal lines
    for (let y = padding + headerHeight; y < canvas.height - padding; y += cellHeight) {
      ctx.beginPath();
      ctx.moveTo(padding, y);
      ctx.lineTo(canvas.width - padding, y);
      ctx.stroke();
    }

    // Vertical lines
    for (let x = padding; x < canvas.width - padding; x += cellWidth) {
      ctx.beginPath();
      ctx.moveTo(x, padding + headerHeight);
      ctx.lineTo(x, canvas.height - padding);
      ctx.stroke();
    }

    // Header row
    ctx.fillStyle = '#f1f5f9';
    ctx.fillRect(padding, padding, canvas.width - padding * 2, headerHeight);

    // Header text
    ctx.fillStyle = '#64748b';
    ctx.font = '11px sans-serif';
    ctx.textBaseline = 'middle';
    const columns = ['A', 'B', 'C', 'D', 'E', 'F'];
    for (let i = 0; i < columns.length && i * cellWidth + padding < canvas.width - padding; i++) {
      const label = columns[i];
      if (label) {
        ctx.fillText(label, padding + i * cellWidth + cellWidth / 2 - 4, padding + headerHeight / 2);
      }
    }

    // Sheet name badge
    ctx.fillStyle = '#3b82f6';
    ctx.font = 'bold 10px sans-serif';
    ctx.fillText(workbook.SheetNames[0] ?? 'Sheet1', padding + 4, canvas.height - padding - 8);

    const thumbnailBlob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: THUMBNAIL_QUALITY,
    });

    return { thumbnail: await blobToDataUrl(thumbnailBlob) };
  } catch (error) {
    console.warn('Failed to generate spreadsheet thumbnail:', error);
    return generateGenericThumbnail('application/vnd.ms-excel', 'spreadsheet');
  }
}

/**
 * Generate a placeholder thumbnail for generic/unsupported file types.
 * Shows a file icon with the extension.
 */
async function generateGenericThumbnail(
  mimeType: string,
  fileName: string
): Promise<ThumbnailResult | null> {
  try {
    const canvas = new OffscreenCanvas(MAX_THUMBNAIL_WIDTH, MAX_THUMBNAIL_HEIGHT);
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Light gray background
    ctx.fillStyle = '#f8fafc';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // File icon shape (document with folded corner)
    const iconWidth = 80;
    const iconHeight = 100;
    const foldSize = 20;
    const iconX = (canvas.width - iconWidth) / 2;
    const iconY = (canvas.height - iconHeight) / 2 - 20;

    ctx.fillStyle = '#e2e8f0';
    ctx.beginPath();
    ctx.moveTo(iconX, iconY);
    ctx.lineTo(iconX + iconWidth - foldSize, iconY);
    ctx.lineTo(iconX + iconWidth, iconY + foldSize);
    ctx.lineTo(iconX + iconWidth, iconY + iconHeight);
    ctx.lineTo(iconX, iconY + iconHeight);
    ctx.closePath();
    ctx.fill();

    // Folded corner
    ctx.fillStyle = '#cbd5e1';
    ctx.beginPath();
    ctx.moveTo(iconX + iconWidth - foldSize, iconY);
    ctx.lineTo(iconX + iconWidth - foldSize, iconY + foldSize);
    ctx.lineTo(iconX + iconWidth, iconY + foldSize);
    ctx.closePath();
    ctx.fill();

    // Border
    ctx.strokeStyle = '#cbd5e1';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(iconX, iconY);
    ctx.lineTo(iconX + iconWidth - foldSize, iconY);
    ctx.lineTo(iconX + iconWidth, iconY + foldSize);
    ctx.lineTo(iconX + iconWidth, iconY + iconHeight);
    ctx.lineTo(iconX, iconY + iconHeight);
    ctx.closePath();
    ctx.stroke();

    // Extension label
    const ext = fileName.includes('.')
      ? fileName.split('.').pop()?.toUpperCase().slice(0, 4) ?? ''
      : '';

    if (ext) {
      ctx.fillStyle = '#64748b';
      ctx.font = 'bold 16px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(ext, canvas.width / 2, iconY + iconHeight / 2 + 10);
    }

    // MIME type at bottom
    ctx.fillStyle = '#94a3b8';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(mimeType.split('/')[1] ?? 'file', canvas.width / 2, canvas.height - 20);

    const thumbnailBlob = await canvas.convertToBlob({
      type: 'image/jpeg',
      quality: THUMBNAIL_QUALITY,
    });

    return { thumbnail: await blobToDataUrl(thumbnailBlob) };
  } catch (error) {
    console.warn('Failed to generate generic thumbnail:', error);
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
