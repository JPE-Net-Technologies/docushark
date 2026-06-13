/**
 * Download utilities for exporting files.
 */

import { useNotificationStore } from '../store/notificationStore';

/**
 * Show a "downloaded" toast. Kept here so every download helper that routes
 * through {@link downloadBlob} confirms the save (browsers give no in-page
 * feedback once the file lands in the Downloads folder).
 */
export function notifyDownloaded(filename: string): void {
  useNotificationStore.getState().success(`Downloaded “${filename}”`);
}

/**
 * Trigger a file download from a Blob.
 */
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  notifyDownloaded(filename);
}

/**
 * Download an SVG string as a file.
 */
export function downloadSvg(svgString: string, filename: string): void {
  const blob = new Blob([svgString], { type: 'image/svg+xml' });
  downloadBlob(blob, filename);
}

/**
 * Download a PNG blob as a file.
 */
export function downloadPng(blob: Blob, filename: string): void {
  downloadBlob(blob, filename);
}

/**
 * Download a PDF blob as a file.
 */
export function downloadPdf(blob: Blob, filename: string): void {
  downloadBlob(blob, filename);
}
