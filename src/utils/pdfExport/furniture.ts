/**
 * Page furniture for PDF export: the cover page, the table of contents, the
 * outline (bookmarks), internal heading links and page numbers.
 */

import { PDF_FONT_SANS } from './fonts';
import { PDFCoverPage } from '../../types/PDFExport';
import type { PDFRenderContext } from './context';
import {
  calculateScaledDimensions,
  convertSvgToPng,
  getImageDimensions,
  getImageFormat,
  isSvgDataUrl,
} from './images';
import { PDF_STYLE } from './style';

/**
 * Render the cover page.
 */
export async function renderCoverPage(
  ctx: PDFRenderContext,
  coverPage: PDFCoverPage,
  logoDataUrl: string | null
): Promise<void> {
  const centerX = ctx.pageWidth / 2;
  let y = ctx.marginTop + 30;


  // Logo at top
  if (logoDataUrl) {
    try {
      // Convert SVG to PNG if needed
      let imageDataUrl = logoDataUrl;
      if (isSvgDataUrl(logoDataUrl)) {
        imageDataUrl = await convertSvgToPng(logoDataUrl);
      }

      // Get actual image dimensions
      const dimensions = await getImageDimensions(imageDataUrl);

      // Calculate scaled dimensions (max width = coverPage.logoMaxWidth, max height = 60mm)
      const scaled = calculateScaledDimensions(
        dimensions.width,
        dimensions.height,
        coverPage.logoMaxWidth,
        60 // max height in mm
      );

      const format = getImageFormat(imageDataUrl);
      ctx.doc.addImage({
        imageData: imageDataUrl,
        format,
        x: centerX - scaled.width / 2,
        y,
        width: scaled.width,
        height: scaled.height,
        compression: ctx.imageCompression,
      });

      y += scaled.height + 15;
    } catch (error) {
      console.error('Failed to add logo to PDF:', error);
    }
  }

  // Decorative line
  ctx.doc.setDrawColor(100, 100, 100);
  ctx.doc.setLineWidth(0.5);
  ctx.doc.line(ctx.marginLeft + 20, y, ctx.pageWidth - ctx.marginRight - 20, y);
  y += 20;

  // Title
  if (coverPage.title) {
    ctx.doc.setFont(PDF_FONT_SANS, 'bold');
    ctx.doc.setFontSize(24);
    const titleLines = ctx.doc.splitTextToSize(coverPage.title, ctx.contentWidth - 40);
    ctx.doc.text(titleLines, centerX, y, { align: 'center' });
    y += titleLines.length * 10 + 10;
  }

  // Thin line under title
  ctx.doc.setLineWidth(0.3);
  ctx.doc.line(ctx.marginLeft + 40, y, ctx.pageWidth - ctx.marginRight - 40, y);
  y += 20;

  // Metadata
  ctx.doc.setFont(PDF_FONT_SANS, 'normal');
  ctx.doc.setFontSize(12);

  if (coverPage.version) {
    ctx.doc.text(`Version: ${coverPage.version}`, centerX, y, { align: 'center' });
    y += 8;
  }

  if (coverPage.author) {
    ctx.doc.text(`Author: ${coverPage.author}`, centerX, y, { align: 'center' });
    y += 8;
  }

  if (coverPage.date) {
    ctx.doc.text(`Date: ${coverPage.date}`, centerX, y, { align: 'center' });
    y += 8;
  }

  // Description
  if (coverPage.description) {
    y += 15;
    ctx.doc.setFontSize(10);
    ctx.doc.setFont(PDF_FONT_SANS, 'italic');
    const descLines = ctx.doc.splitTextToSize(coverPage.description, ctx.contentWidth - 60);
    ctx.doc.text(descLines, centerX, y, { align: 'center' });
  }
}

/**
 * Insert ToC pages right after the cover page (or at the front when no cover),
 * fill them with the heading list and dotted page-number leaders, then shift
 * `collectedHeadings` page numbers to account for the inserted pages.
 *
 * Returns the number of ToC pages inserted.
 */
export function insertTableOfContents(ctx: PDFRenderContext, hasCover: boolean): number {
  const headings = ctx.collectedHeadings;
  if (headings.length === 0) return 0;

  const titleFontSize = 18;
  const entryFontSize = 11;
  const entryLineHeightMm = entryFontSize * 0.352778 * 1.6;
  const titleLineHeightMm = titleFontSize * 0.352778 * 1.4;
  const footerSpace = ctx.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
  const usableHeight = ctx.pageHeight - ctx.marginTop - ctx.marginBottom - footerSpace;
  const firstPageEntries = Math.max(1, Math.floor((usableHeight - titleLineHeightMm - 6) / entryLineHeightMm));
  const subsequentPageEntries = Math.max(1, Math.floor(usableHeight / entryLineHeightMm));

  const tocPageCount = headings.length <= firstPageEntries
    ? 1
    : 1 + Math.ceil((headings.length - firstPageEntries) / subsequentPageEntries);

  const insertBefore = (hasCover ? 2 : 1);
  // Add ToC pages at the end then move them into place
  const startTotal = ctx.doc.getNumberOfPages();
  for (let i = 0; i < tocPageCount; i++) {
    ctx.doc.addPage();
  }
  // Move newly-added pages into position (in reverse so page numbers stay stable as we go)
  for (let i = 0; i < tocPageCount; i++) {
    const newPageIndex = startTotal + tocPageCount; // last newly-added page (numbers shift each move)
    ctx.doc.movePage(newPageIndex, insertBefore + i);
  }

  // All previously-numbered pages shift down by `tocPageCount`
  for (const h of headings) {
    h.pdfPage += tocPageCount;
  }
  for (const id of Object.keys(ctx.pageIdToPdfPage)) {
    const v = ctx.pageIdToPdfPage[id];
    if (v !== undefined) ctx.pageIdToPdfPage[id] = v + tocPageCount;
  }

  // Render ToC content
  const innerWidth = ctx.contentWidth;
  let cursor = 0;
  for (let p = 0; p < tocPageCount; p++) {
    const tocPdfPage = insertBefore + p;
    ctx.doc.setPage(tocPdfPage);
    let y = ctx.marginTop;

    if (p === 0) {
      ctx.doc.setFont(PDF_FONT_SANS, 'bold');
      ctx.doc.setFontSize(titleFontSize);
      ctx.doc.setTextColor(0, 0, 0);
      ctx.doc.text('Table of Contents', ctx.marginLeft, y + titleLineHeightMm * 0.7);
      y += titleLineHeightMm + 6;
    }

    const entriesOnPage = p === 0 ? firstPageEntries : subsequentPageEntries;
    const end = Math.min(headings.length, cursor + entriesOnPage);

    ctx.doc.setFont(PDF_FONT_SANS, 'normal');
    ctx.doc.setFontSize(entryFontSize);
    ctx.doc.setTextColor(0, 0, 0);

    for (; cursor < end; cursor++) {
      const h = headings[cursor]!;
      const indent = (h.level - 1) * 6; // mm per level
      const labelX = ctx.marginLeft + indent;
      const pageNumStr = String(h.pdfPage);
      const pageNumWidth = ctx.doc.getTextWidth(pageNumStr);
      const pageNumX = ctx.marginLeft + innerWidth - pageNumWidth;

      // Truncate label so leader dots have at least a little room
      const maxLabelWidth = pageNumX - labelX - 8;
      let label = h.text;
      while (ctx.doc.getTextWidth(label) > maxLabelWidth && label.length > 4) {
        label = label.slice(0, -2);
      }
      if (label !== h.text) label = label.slice(0, -1) + '…';

      ctx.doc.text(label, labelX, y);
      ctx.doc.text(pageNumStr, pageNumX, y);

      // Dotted leader between label and page number
      const labelWidth = ctx.doc.getTextWidth(label);
      const dotsStartX = labelX + labelWidth + 2;
      const dotsEndX = pageNumX - 2;
      if (dotsEndX > dotsStartX) {
        const dotWidth = ctx.doc.getTextWidth('.');
        const dots = Math.max(0, Math.floor((dotsEndX - dotsStartX) / dotWidth));
        if (dots > 0) {
          ctx.doc.text('.'.repeat(dots), dotsStartX, y);
        }
      }

      // Make the entry clickable in the PDF
      ctx.doc.link(labelX, y - entryLineHeightMm * 0.7, innerWidth - indent, entryLineHeightMm * 0.9, {
        pageNumber: h.pdfPage,
      });

      y += entryLineHeightMm;
    }
  }

  // Reset to last page so subsequent operations (page numbering) iterate correctly
  ctx.doc.setPage(ctx.doc.getNumberOfPages());

  return tocPageCount;
}

/**
 * Walk the deferred internal heading-links list and write the actual `doc.link`
 * calls now that we know the final PDF page for every heading.
 */
export function resolveDeferredHeadingLinks(ctx: PDFRenderContext): void {
  if (ctx.deferredHeadingLinks.length === 0) return;
  // Two lookup maps: by durable heading id (JP-432 Pillar C, position-proof)
  // and by (pageId, headingIndex) for legacy positional links.
  const byId = new Map<string, number>();
  const byIndex = new Map<string, number>();
  for (const h of ctx.collectedHeadings) {
    if (h.headingId !== undefined) {
      byId.set(h.headingId, h.pdfPage);
    }
    if (h.pageId !== undefined && h.pageHeadingIndex !== undefined) {
      byIndex.set(`${h.pageId}::${h.pageHeadingIndex}`, h.pdfPage);
    }
  }
  // Group by source PDF page to minimize setPage thrash
  const grouped = new Map<number, typeof ctx.deferredHeadingLinks>();
  for (const link of ctx.deferredHeadingLinks) {
    const arr = grouped.get(link.pdfPage) ?? [];
    arr.push(link);
    grouped.set(link.pdfPage, arr);
  }
  const restore = ctx.doc.getNumberOfPages();
  for (const [srcPage, links] of grouped) {
    ctx.doc.setPage(srcPage);
    for (const link of links) {
      const targetPdfPage =
        link.targetHeadingId !== undefined
          ? byId.get(link.targetHeadingId)
          : byIndex.get(`${link.targetPageId}::${link.targetHeadingIndex}`);
      if (targetPdfPage === undefined) continue;
      ctx.doc.link(link.x, link.y, link.w, link.h, { pageNumber: targetPdfPage });
    }
  }
  ctx.doc.setPage(restore);
}

/**
 * Build PDF reader bookmarks (outline) from the collected heading list,
 * nesting children under the most-recent heading of a higher level.
 */
export function buildPdfOutline(ctx: PDFRenderContext): void {
  const headings = ctx.collectedHeadings;
  // Stack of [level, outlineItem] from outermost to innermost
  const stack: Array<{ level: number; item: unknown }> = [];

  for (const h of headings) {
    while (stack.length > 0 && stack[stack.length - 1]!.level >= h.level) {
      stack.pop();
    }
    const parent = stack.length > 0 ? stack[stack.length - 1]!.item : null;
    const item = ctx.doc.outline.add(parent as never, h.text, { pageNumber: h.pdfPage });
    stack.push({ level: h.level, item });
  }
}

/**
 * Add page numbers to all pages.
 */
export function addPageNumbers(ctx: PDFRenderContext, hasCoverPage: boolean): void {
  const totalPages = ctx.doc.getNumberOfPages();

  for (let i = 1; i <= totalPages; i++) {
    ctx.doc.setPage(i);
    ctx.doc.setFont(PDF_FONT_SANS, 'normal');
    ctx.doc.setFontSize(10);
    ctx.doc.setTextColor(128, 128, 128);

    let pageText: string;
    if (ctx.pageNumberFormat === 'x-of-y') {
      if (hasCoverPage) {
        if (i === 1) {
          pageText = `Page 1 of ${totalPages}`;
        } else {
          pageText = `Page ${i} of ${totalPages}`;
        }
      } else {
        pageText = `Page ${i} of ${totalPages}`;
      }
    } else {
      pageText = `${i}`;
    }

    ctx.doc.text(
      pageText,
      ctx.pageWidth - ctx.marginRight,
      ctx.pageHeight - ctx.marginBottom / 2,
      { align: 'right' }
    );
  }

  // Reset text color
  ctx.doc.setTextColor(0, 0, 0);
}
