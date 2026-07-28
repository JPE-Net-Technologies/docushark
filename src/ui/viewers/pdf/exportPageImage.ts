/**
 * Render a single PDF page to a high-resolution PNG File — the "send page to
 * canvas" export. Same lazy pdf.js + OffscreenCanvas pattern as
 * ThumbnailGenerator, but at reading resolution and lossless.
 * Untestable in jsdom (canvas); deliberately kept thin.
 */

/** Target bitmap width — high enough to stay legible when scaled on canvas. */
const TARGET_WIDTH = 1600;
const MAX_SCALE = 4;

export async function exportPdfPageAsPngFile(
  source: Blob,
  pageNumber: number,
  baseName: string,
): Promise<File | null> {
  try {
    const pdfjsLib = await import('pdfjs-dist');
    if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
      pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
        'pdfjs-dist/build/pdf.worker.min.mjs',
        import.meta.url,
      ).toString();
    }

    const loadingTask = pdfjsLib.getDocument({ data: await source.arrayBuffer() });
    try {
      const doc = await loadingTask.promise;
      const page = await doc.getPage(Math.min(Math.max(1, pageNumber), doc.numPages));

      const base = page.getViewport({ scale: 1.0 });
      const scale = Math.min(MAX_SCALE, TARGET_WIDTH / base.width);
      const viewport = page.getViewport({ scale });

      const canvas = new OffscreenCanvas(
        Math.ceil(viewport.width),
        Math.ceil(viewport.height),
      );
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;

      // pdf.js v5 requires explicit `canvas: null` when passing canvasContext.
      await page.render({
        canvas: null,
        canvasContext: ctx as unknown as CanvasRenderingContext2D,
        viewport,
      }).promise;

      const png = await canvas.convertToBlob({ type: 'image/png' });
      const stem = baseName.replace(/\.pdf$/i, '');
      return new File([png], `${stem}-p${pageNumber}.png`, { type: 'image/png' });
    } finally {
      await loadingTask.destroy().catch(() => undefined);
    }
  } catch (err) {
    console.error('exportPdfPageAsPngFile failed:', err);
    return null;
  }
}
