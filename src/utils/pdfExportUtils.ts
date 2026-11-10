/**
 * PDF export utilities for converting rich text documents to PDF.
 *
 * Uses jsPDF library to generate PDF from Tiptap JSON content.
 * Supports multi-page export: iterates all rich text pages and canvas pages.
 * Renders inline formatting (bold, italic, underline, strikethrough, color,
 * highlight, inline code), text alignment, tables, task lists, and LaTeX math.
 *
 * This file is the entry point: `exportToPdf` puts the document together, and
 * the pieces live in `./pdfExport/` (DSK-242):
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
import { registerPDFFonts } from './pdfExport/fonts';
import { PDFExportOptions, getPageDimensions } from '../types/PDFExport';
import type { ImageCompression } from 'jspdf';
import type { PDFQuality } from '../types/PDFExport';
import { renderAllDiagramPages } from './pdfExport/canvas';
import type { PDFCanvasPage, PDFRenderContext, PDFRichTextPage } from './pdfExport/context';
import {
  addPageNumbers,
  buildPdfOutline,
  insertTableOfContents,
  renderCoverPage,
  resolveDeferredHeadingLinks,
} from './pdfExport/furniture';
import { loadBlobAsDataUrl, loadEmbeddedImages } from './pdfExport/images';
import { renderNode } from './pdfExport/registry';
// Registers a renderer for every node type.
import './pdfExport/nodes';

export { extractBibliographyEntries } from './pdfExport/blocks';
export { warnUnhandledNodes } from './pdfExport/nodes';
export { distributeColumnWidths } from './pdfExport/tables';
export { breakOversizedWord, extractSegments, parseColor } from './pdfExport/text';
export type { PDFCanvasPage, PDFRichTextPage } from './pdfExport/context';

/**
 * Map PDF quality setting to jsPDF image compression level.
 * All levels use DEFLATE (lossless) - higher = more compression effort.
 */
const QUALITY_TO_COMPRESSION: Record<PDFQuality, ImageCompression> = {
  standard: 'FAST',   // Quick export, slightly larger files
  high: 'MEDIUM',     // Balanced (default)
  print: 'SLOW',      // Best compression for smallest files
};

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
  const { width, height } = getPageDimensions(options.pageSize, options.orientation);

  // Create PDF document
  const doc = new jsPDF({
    orientation: options.orientation,
    unit: 'mm',
    format: options.pageSize,
  });

  // Register custom Unicode-capable fonts (Inter + JetBrains Mono)
  // to replace jsPDF's built-in helvetica/courier which cause þÿ artifacts
  await registerPDFFonts(doc);

  // Determine the list of rich text pages to render
  const pagesToRender: PDFRichTextPage[] = richTextPages && richTextPages.length > 0
    ? richTextPages
    : [{ name: 'Document', content: richTextContent }];

  // Load all embedded images from all pages
  const images = new Map<string, string>();
  for (const page of pagesToRender) {
    const pageImages = await loadEmbeddedImages(page.content.content);
    for (const [key, value] of pageImages) {
      images.set(key, value);
    }
  }

  // Load cover page logo if needed
  let logoDataUrl: string | null = null;
  if (options.coverPage.enabled && options.coverPage.logoBlobId) {
    logoDataUrl = await loadBlobAsDataUrl(options.coverPage.logoBlobId);
  }

  // Calculate content area
  const contentWidth = width - options.margins.left - options.margins.right;

  // Create render context
  const ctx: PDFRenderContext = {
    doc,
    y: options.margins.top,
    pageWidth: width,
    pageHeight: height,
    contentWidth,
    marginLeft: options.margins.left,
    marginRight: options.margins.right,
    marginTop: options.margins.top,
    marginBottom: options.margins.bottom,
    pageNumber: 1,
    totalPages: 1, // Will be updated later
    showPageNumbers: options.showPageNumbers,
    pageNumberFormat: options.pageNumberFormat,
    images,
    imageCompression: QUALITY_TO_COMPRESSION[options.quality],
    pageIdToPdfPage: {},
    collectedHeadings: [],
    currentPageHeadingIndex: 0,
    currentPageId: undefined,
    deferredHeadingLinks: [],
  };

  // Render cover page if enabled
  if (options.coverPage.enabled) {
    await renderCoverPage(ctx, options.coverPage, logoDataUrl);
    doc.addPage();
    ctx.pageNumber++;
    ctx.y = options.margins.top;
  }

  // Render diagrams after cover page if position is 'after-cover'
  if (options.diagramEmbed?.enabled && options.diagramEmbed.position === 'after-cover') {
    await renderAllDiagramPages(ctx, options.diagramEmbed, canvasPages, themeBackground);
  }

  // Render diagrams before content if position is 'before-content'
  if (options.diagramEmbed?.enabled && options.diagramEmbed.position === 'before-content') {
    await renderAllDiagramPages(ctx, options.diagramEmbed, canvasPages, themeBackground);
  }

  // Render all rich text pages
  for (let i = 0; i < pagesToRender.length; i++) {
    const page = pagesToRender[i]!;

    // Add a page break before each rich text page (except the first)
    if (i > 0) {
      doc.addPage();
      ctx.pageNumber++;
      ctx.y = ctx.marginTop;
    }

    // Record where this app page lives in the PDF (for internal link resolution)
    if (page.id) {
      ctx.pageIdToPdfPage[page.id] = ctx.pageNumber;
    }
    ctx.currentPageId = page.id;
    ctx.currentPageHeadingIndex = 0;

    // (Page/tab names are intentionally not printed — pages are separated by the
    // hard page break above, not a per-page title heading.)

    // Render document content for this page
    if (page.content.content.content) {
      for (const node of page.content.content.content) {
        await renderNode(ctx, node, 0);
      }
    }
  }

  // Render diagrams after content if position is 'after-content'
  if (options.diagramEmbed?.enabled && options.diagramEmbed.position === 'after-content') {
    await renderAllDiagramPages(ctx, options.diagramEmbed, canvasPages, themeBackground);
  }

  // Insert ToC pages after the cover (or at the very front if no cover) and shift heading pages
  const wantToc = options.includeTableOfContents !== false && ctx.collectedHeadings.length > 0;
  let tocInsertedCount = 0;
  if (wantToc) {
    tocInsertedCount = insertTableOfContents(ctx, options.coverPage.enabled);
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
    buildPdfOutline(ctx);
  }

  // Store total pages
  ctx.totalPages = ctx.pageNumber + tocInsertedCount;
  ctx.pageNumber = ctx.totalPages;

  // Add page numbers to all pages
  if (options.showPageNumbers) {
    addPageNumbers(ctx, options.coverPage.enabled);
  }

  // Return as blob
  return doc.output('blob');
}
