/**
 * The document's layout, shared by the export and the measure-only paginator
 * (DSK-252): the cover, the diagrams and every prose page, in order.
 *
 * On a real jsPDF this draws them. On a `MeasureDoc` it only measures, and the
 * pager still records every break, so both say the same thing about where the
 * pages fall: same code, same metrics.
 */

import type { ImageCompression } from 'jspdf';
import type { RichTextContent } from '../../types/RichText';
import { getPageDimensions, type PDFExportOptions, type PDFQuality } from '../../types/PDFExport';
import { renderAllDiagramPages } from './canvas';
import { newPage, type PDFCanvasPage, type PDFRenderContext, type PDFRichTextPage } from './context';
import type { PdfDoc } from './doc';
import { renderCoverPage, tableOfContentsLayout } from './furniture';
import { loadBlobAsDataUrl, loadEmbeddedImages } from './images';
import { type BlockStart, Pager, type PageBreak } from './pager';
import { renderChild } from './registry';
// Registers a renderer for every node type.
import './nodes';

/**
 * Map PDF quality setting to jsPDF image compression level.
 * All levels use DEFLATE (lossless) - higher = more compression effort.
 */
const QUALITY_TO_COMPRESSION: Record<PDFQuality, ImageCompression> = {
  standard: 'FAST',   // Quick export, slightly larger files
  high: 'MEDIUM',     // Balanced (default)
  print: 'SLOW',      // Best compression for smallest files
};

/** What to lay out: the same arguments `exportToPdf` takes. */
export interface LayoutInput {
  options: PDFExportOptions;
  /** Single page content (legacy); ignored when `richTextPages` has pages. */
  richTextContent: RichTextContent;
  /** Theme canvas background, for diagram embedding. */
  themeBackground: string | undefined;
  richTextPages: PDFRichTextPage[] | undefined;
  canvasPages: PDFCanvasPage[] | undefined;
}

/** Where the pages of an export fall (DSK-252). */
export interface PdfLayout {
  /** Pages the layout fills, counting the cover but not the contents. */
  pages: number;
  /** Contents pages the export inserts after the cover (or at the front). */
  contentsPages: number;
  /** Every page break, in order. */
  breaks: PageBreak[];
  /** Where each top-level block of each prose page started, for `relayoutFrom`. */
  starts: BlockStart[];
}

/** A layout to continue from one of its block starts, instead of from the top. */
export interface ResumeFrom {
  start: BlockStart;
  /** The previous layout's breaks and starts before that block. */
  breaks: PageBreak[];
  starts: BlockStart[];
}

/**
 * Lay the whole document out on `doc` and return the finished context. With
 * `resume`, start at one of a previous layout's block starts: the cover, the
 * diagrams before the content and every block before it are taken as laid out.
 */
export async function layOut(doc: PdfDoc, textFont: string, input: LayoutInput, resume?: ResumeFrom): Promise<PDFRenderContext> {
  const { options, richTextContent, themeBackground, richTextPages, canvasPages } = input;
  const { width, height } = getPageDimensions(options.pageSize, options.orientation);

  // Determine the list of rich text pages to render
  const pagesToRender: PDFRichTextPage[] = richTextPages && richTextPages.length > 0
    ? richTextPages
    : [{ name: 'Document', content: richTextContent }];

  // Load all embedded images from the pages to lay out
  const firstPage = resume?.start.prosePage ?? 0;
  const images = new Map<string, string>();
  for (const page of pagesToRender.slice(firstPage)) {
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
    pager: new Pager(),
    path: [],
    blocks: [],
    following: [],
    textFont,
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

  if (resume) {
    // Continue where the previous layout stood at this block.
    const { start } = resume;
    ctx.pager.breaks.push(...resume.breaks.slice(0, start.breaks));
    ctx.pager.starts.push(...resume.starts.filter((s) => s.prosePage < start.prosePage || (s.prosePage === start.prosePage && s.block < start.block)));
    ctx.pageNumber = start.pageNumber;
    ctx.y = start.y;
    // Only their number matters to a layout (the contents count them).
    ctx.collectedHeadings = Array.from({ length: start.headings }, () => ({
      level: 1, text: '', pdfPage: 0, pageId: undefined, pageHeadingIndex: undefined, headingId: undefined,
    }));
  } else {
    // Render cover page if enabled
    if (options.coverPage.enabled) {
      await renderCoverPage(ctx, options.coverPage, logoDataUrl);
      newPage(ctx, { kind: 'section', section: 'afterCover', index: 0 });
    }

    // Render diagrams after cover page if position is 'after-cover'
    if (options.diagramEmbed?.enabled && options.diagramEmbed.position === 'after-cover') {
      await renderAllDiagramPages(ctx, options.diagramEmbed, canvasPages, themeBackground);
    }

    // Render diagrams before content if position is 'before-content'
    if (options.diagramEmbed?.enabled && options.diagramEmbed.position === 'before-content') {
      await renderAllDiagramPages(ctx, options.diagramEmbed, canvasPages, themeBackground);
    }
  }

  // Render all rich text pages
  for (let i = firstPage; i < pagesToRender.length; i++) {
    const page = pagesToRender[i]!;
    const resumingHere = resume !== undefined && i === firstPage;

    ctx.currentPageId = page.id;
    ctx.currentPageHeadingIndex = resumingHere ? resume.start.pageHeadings : 0;

    // Add a page break before each rich text page (except the first)
    if (i > 0 && !resumingHere) {
      newPage(ctx, { kind: 'section', section: 'prose', index: i });
    }

    // Record where this app page lives in the PDF (for internal link resolution)
    if (page.id && !resumingHere) {
      ctx.pageIdToPdfPage[page.id] = ctx.pageNumber;
    }

    // (Page/tab names are intentionally not printed — pages are separated by the
    // hard page break above, not a per-page title heading.)

    // Render document content for this page, noting where each block starts.
    const blocks = page.content.content.content ?? [];
    for (let j = resumingHere ? resume.start.block : 0; j < blocks.length; j++) {
      ctx.pager.starts.push({
        prosePage: i,
        block: j,
        pageNumber: ctx.pageNumber,
        y: ctx.y,
        pageHeadings: ctx.currentPageHeadingIndex,
        headings: ctx.collectedHeadings.length,
        breaks: ctx.pager.breaks.length,
      });
      await renderChild(ctx, blocks, j, 0);
    }
  }

  // Render diagrams after content if position is 'after-content'
  if (options.diagramEmbed?.enabled && options.diagramEmbed.position === 'after-content') {
    await renderAllDiagramPages(ctx, options.diagramEmbed, canvasPages, themeBackground);
  }

  return ctx;
}

/** Whether the export inserts contents pages for this layout. */
export function wantsContents(options: PDFExportOptions, ctx: PDFRenderContext): boolean {
  return options.includeTableOfContents !== false && ctx.collectedHeadings.length > 0;
}

/** The finished layout's pages and breaks. */
export function layoutOf(options: PDFExportOptions, ctx: PDFRenderContext): PdfLayout {
  return {
    pages: ctx.pageNumber,
    contentsPages: wantsContents(options, ctx) ? tableOfContentsLayout(ctx).pages : 0,
    breaks: ctx.pager.breaks,
    starts: ctx.pager.starts,
  };
}
