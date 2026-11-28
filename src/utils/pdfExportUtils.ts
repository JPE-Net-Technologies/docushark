/**
 * PDF export utilities for converting rich text documents to PDF.
 *
 * Uses jsPDF library to generate PDF from Tiptap JSON content.
 * Supports multi-page export: iterates all rich text pages and canvas pages.
 * Renders inline formatting (bold, italic, underline, strikethrough, color,
 * highlight, inline code), text alignment, tables, task lists, and LaTeX math.
 *
 * This file is the entry point: `exportToPdf` lays the document out and adds
 * the furniture, and the pieces live in `./pdfExport/` (DSK-242, DSK-252):
 * - `layout.ts`: the layout itself, shared with `paginate.ts`, which runs it on
 *   a `MeasureDoc` (`doc.ts`) to find where the pages break without writing a
 *   PDF, and lays out again from an edited block (Paper Mode).
 * - `pager.ts`: every page break and what opens the new page; `keep.ts`: keeping
 *   a heading with the start of what follows.
 * - `context.ts`: the render context, the page types and the page-break check;
 *   `style.ts`: sizes, spacing and colours.
 * - `text.ts` and `tables.ts`: layout of styled text and of tables.
 * - `registry.ts` and `nodes.ts`: one renderer per node type, registered in
 *   `nodes.ts`; the renderers are in `blocks.ts`, `media.ts`, `tables.ts`,
 *   `math.ts` and `canvas.ts`.
 * - `furniture.ts`: the cover page, contents, outline, heading links and page
 *   numbers.
 * - `canvas.ts`: canvas pages and groups embedded as images.
 * - `images.ts`: loading and sizing images; `fonts.ts`: the embedded fonts.
 *
 * `pdfExportGolden.test.ts` pins what a reader gets out of an export.
 */

import { jsPDF } from 'jspdf';
import type { RichTextContent } from '../types/RichText';
import { pdfFontFor, registerPDFFonts } from './pdfExport/fonts';
import type { PDFExportOptions } from '../types/PDFExport';
import type { PDFCanvasPage, PDFRichTextPage } from './pdfExport/context';
import {
  addPageNumbers,
  buildPdfOutline,
  insertTableOfContents,
  resolveDeferredHeadingLinks,
} from './pdfExport/furniture';
import { layOut, layoutOf, wantsContents, type PdfLayout } from './pdfExport/layout';

export { extractBibliographyEntries } from './pdfExport/blocks';
export { warnUnhandledNodes } from './pdfExport/nodes';
export { distributeColumnWidths } from './pdfExport/tables';
export { breakOversizedWord, extractSegments, parseColor } from './pdfExport/text';
export type { PDFCanvasPage, PDFRichTextPage } from './pdfExport/context';

/**
 * Export rich text content to PDF.
 *
 * Iterates all rich text pages and canvas pages in order.
 * Each rich text page's content is rendered sequentially.
 * Diagram embedding renders all canvas pages (or just the active one
 * if only a single page of shapes is provided via legacy path).
 *
 * @param options - PDF export options
 * @param richTextContent - Single page content (legacy) or ignored when richTextPages provided
 * @param themeBackground - Current theme canvas background color (for diagram embedding)
 * @param richTextPages - All rich text pages in order (multi-page export)
 * @param canvasPages - All canvas pages in order (multi-page diagram export)
 * @returns PDF blob
 */
export async function exportToPdf(
  options: PDFExportOptions,
  richTextContent: RichTextContent,
  themeBackground?: string,
  richTextPages?: PDFRichTextPage[],
  canvasPages?: PDFCanvasPage[]
): Promise<Blob> {
  return (await exportToPdfWithLayout(options, richTextContent, themeBackground, richTextPages, canvasPages)).blob;
}

/**
 * `exportToPdf`, also returning where its pages broke: the same layout
 * `paginate` computes without writing a PDF (DSK-252).
 */
export async function exportToPdfWithLayout(
  options: PDFExportOptions,
  richTextContent: RichTextContent,
  themeBackground?: string,
  richTextPages?: PDFRichTextPage[],
  canvasPages?: PDFCanvasPage[]
): Promise<{ blob: Blob; layout: PdfLayout }> {
  // Create PDF document. Compressed: jsPDF otherwise writes every content
  // stream and embedded font raw, about four times the size (DSK-250).
  const doc = new jsPDF({
    orientation: options.orientation,
    unit: 'mm',
    format: options.pageSize,
    compress: true,
  });

  // Register custom Unicode-capable fonts (Inter + JetBrains Mono)
  // to replace jsPDF's built-in helvetica/courier which cause þÿ artifacts
  const textFont = await registerPDFFonts(doc, pdfFontFor(options.fontFamily));

  // The cover, the diagrams and every prose page, drawn.
  const ctx = await layOut(doc, textFont, { options, richTextContent, themeBackground, richTextPages, canvasPages });
  const layout = layoutOf(options, ctx);

  // Insert ToC pages after the cover (or at the very front if no cover) and shift heading pages
  let tocInsertedCount = 0;
  if (wantsContents(options, ctx)) {
    tocInsertedCount = insertTableOfContents(ctx, doc, options.coverPage.enabled);
  }
  // ToC insertion shifts every recorded PDF page number by `tocInsertedCount`.
  // Apply that shift to deferred-link source pages too so we write to the right page.
  if (tocInsertedCount > 0) {
    for (const link of ctx.deferredHeadingLinks) {
      link.pdfPage += tocInsertedCount;
    }
  }

  // Resolve deferred internal heading-links now that final page numbers are known
  resolveDeferredHeadingLinks(ctx);

  // Build PDF outline / bookmarks from collected headings
  if (options.includePdfOutline !== false && ctx.collectedHeadings.length > 0) {
    buildPdfOutline(ctx, doc);
  }

  // Store total pages
  ctx.totalPages = ctx.pageNumber + tocInsertedCount;
  ctx.pageNumber = ctx.totalPages;

  // Add page numbers to all pages
  if (options.showPageNumbers) {
    addPageNumbers(ctx, options.coverPage.enabled);
  }

  // Return as blob
  return { blob: doc.output('blob'), layout };
}
