/**
 * FileIntegrityValidator — validates file content integrity before import.
 *
 * Detects corrupt files early to prevent storing broken content:
 * - PDF: Attempts to parse with pdf.js
 * - Image: Uses createImageBitmap to verify decodability
 * - Spreadsheet: Attempts partial parse with XLSX
 * - Text: Validates UTF-8 encoding
 */

import type { FileCategory } from '../shapes/Shape';

export interface ValidationResult {
  valid: boolean;
  error?: string | undefined;
}

/**
 * Validate file integrity based on its category.
 *
 * @param blob - The file blob to validate
 * @param category - The detected file category
 * @param mimeType - The MIME type of the file
 * @returns Validation result with error message if invalid
 */
export async function validateFileIntegrity(
  blob: Blob,
  category: FileCategory,
  _mimeType: string
): Promise<ValidationResult> {
  try {
    switch (category) {
      case 'pdf':
        return await validatePdf(blob);
      case 'image':
        return await validateImage(blob);
      case 'spreadsheet':
        return await validateSpreadsheet(blob);
      case 'text':
        return await validateText(blob);
      default:
        // Generic files can't be validated - assume valid
        return { valid: true };
    }
  } catch (error) {
    return {
      valid: false,
      error: error instanceof Error ? error.message : 'Unknown validation error',
    };
  }
}

/**
 * Validate PDF file by attempting to load it with pdf.js.
 */
async function validatePdf(blob: Blob): Promise<ValidationResult> {
  try {
    const pdfjsLib = await import('pdfjs-dist');

    // Configure worker if not already set
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url
      ).toString();
    }

    const arrayBuffer = await blob.arrayBuffer();
    const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });

    // Attempt to load the PDF
    const pdf = await loadingTask.promise;

    // Basic sanity check - must have at least one page
    if (pdf.numPages < 1) {
      pdf.destroy();
      return { valid: false, error: 'PDF has no pages' };
    }

    // Try to get the first page to verify structure
    await pdf.getPage(1);

    pdf.destroy();
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Corrupt PDF: ${error instanceof Error ? error.message : 'Unable to parse'}`,
    };
  }
}

/**
 * Validate image file using createImageBitmap.
 * This is the most reliable way to verify an image is decodable.
 */
async function validateImage(blob: Blob): Promise<ValidationResult> {
  try {
    const bitmap = await createImageBitmap(blob);

    // Basic sanity check - must have dimensions
    if (bitmap.width < 1 || bitmap.height < 1) {
      bitmap.close();
      return { valid: false, error: 'Image has invalid dimensions' };
    }

    bitmap.close();
    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Corrupt image: ${error instanceof Error ? error.message : 'Unable to decode'}`,
    };
  }
}

/**
 * Validate spreadsheet file by attempting partial parse with XLSX.
 * Only reads first 100KB to avoid loading entire large files.
 */
async function validateSpreadsheet(blob: Blob): Promise<ValidationResult> {
  try {
    const XLSX = await import('xlsx');

    // Read only first 100KB for validation
    const maxBytes = 100 * 1024;
    const slice = blob.slice(0, Math.min(blob.size, maxBytes));
    const arrayBuffer = await slice.arrayBuffer();

    // Attempt to parse
    const workbook = XLSX.read(arrayBuffer, { type: 'array', sheetRows: 10 });

    // Basic sanity check - must have at least one sheet
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
      return { valid: false, error: 'Spreadsheet has no sheets' };
    }

    return { valid: true };
  } catch (error) {
    return {
      valid: false,
      error: `Corrupt spreadsheet: ${error instanceof Error ? error.message : 'Unable to parse'}`,
    };
  }
}

/**
 * Validate text file by checking UTF-8 encoding.
 * Only checks first 4KB to avoid loading entire large files.
 */
async function validateText(blob: Blob): Promise<ValidationResult> {
  try {
    // Read only first 4KB for validation
    const maxBytes = 4 * 1024;
    const slice = blob.slice(0, Math.min(blob.size, maxBytes));

    // Attempt to decode as UTF-8
    const arrayBuffer = await slice.arrayBuffer();
    const decoder = new TextDecoder('utf-8', { fatal: true });

    // This will throw if the content is not valid UTF-8
    decoder.decode(arrayBuffer);

    return { valid: true };
  } catch (error) {
    // TextDecoder throws on invalid UTF-8
    return {
      valid: false,
      error: 'File contains invalid UTF-8 encoding',
    };
  }
}

/**
 * Quick validation check that can be used for UI feedback.
 * Returns true if the file appears to be valid.
 */
export async function isFileValid(
  blob: Blob,
  category: FileCategory,
  mimeType: string
): Promise<boolean> {
  const result = await validateFileIntegrity(blob, category, mimeType);
  return result.valid;
}
