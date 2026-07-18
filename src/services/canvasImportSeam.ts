/**
 * Seam letting non-canvas UI (the file viewer's "send page to canvas") import
 * files at the viewport center without a UI→engine import cycle. Mirrors the
 * registerBlobDownloader pattern in blobResolver: CanvasContainer registers a
 * handler while an engine exists; callers degrade gracefully when none does.
 */

type ViewportImporter = (files: File[]) => Promise<boolean>;

let importer: ViewportImporter | null = null;

/** Register (or clear, with null) the active viewport importer. */
export function registerViewportImporter(fn: ViewportImporter | null): void {
  importer = fn;
}

/**
 * Import files as shapes at the canvas viewport center. Resolves false when
 * no canvas is mounted (or the import failed) — callers surface that state.
 */
export async function importFilesAtViewportCenter(files: File[]): Promise<boolean> {
  if (!importer) return false;
  try {
    return await importer(files);
  } catch {
    return false;
  }
}
