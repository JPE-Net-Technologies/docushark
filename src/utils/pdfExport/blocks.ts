/**
 * Renderers for block nodes in PDF export: headings, paragraphs, lists, code,
 * quotes, rules, task lists, callouts and the bibliography.
 */

import type { JSONContent } from '@tiptap/core';
import { PDF_FONT_SANS, PDF_FONT_MONO } from './fonts';
import { checkPageBreak, pageContentHeight, spaceLeft, type PDFRenderContext, type TextSegment } from './context';
import { renderNode } from './registry';
import { PDF_STYLE } from './style';
import { extractSegments, extractText, renderSegmentedText } from './text';

/**
 * Render a heading node with inline formatting and alignment.
 */
export function renderHeading(ctx: PDFRenderContext, node: JSONContent): void {
  const level = (node.attrs?.['level'] as number | undefined) || 1;
  const fontSize = PDF_STYLE.headingSizes[level] || 12;
  const textAlign = (node.attrs?.['textAlign'] as string | undefined) || 'left';
  const topSpacing = PDF_STYLE.headingTopSpacing[level] ?? 3;

  // Suppress top spacing if heading is the first thing on the page
  if (ctx.y > ctx.marginTop) {
    ctx.y += topSpacing;
  }

  checkPageBreak(ctx, fontSize * PDF_STYLE.lineHeight);

  // Capture heading metadata for ToC + outline (text and the page where it lands).
  // Stamp pageId + within-page index so heading-targeted internal links can resolve.
  const headingText = extractText(node).trim();
  const headingIndexInPage = ctx.currentPageHeadingIndex;
  ctx.currentPageHeadingIndex++;
  if (headingText) {
    const headingId = node.attrs?.['id'];
    ctx.collectedHeadings.push({
      level,
      text: headingText,
      pdfPage: ctx.pageNumber,
      pageId: ctx.currentPageId,
      pageHeadingIndex: headingIndexInPage,
      headingId: typeof headingId === 'string' && headingId.length > 0 ? headingId : undefined,
    });
  }

  const segments = extractSegments(node);
  renderSegmentedText(ctx, segments, fontSize, 'bold', ctx.marginLeft, ctx.contentWidth, textAlign);

  ctx.y += PDF_STYLE.headingBottomSpacing;
}

/**
 * Render a paragraph node with inline formatting and alignment.
 */
/**
 * Extract bibliography entry strings from cached citeproc HTML (JP-89). citeproc
 * wraps each reference in a `.csl-entry`; fall back to the whole text when the
 * structure is unexpected (e.g. the empty-state placeholder).
 */
export function extractBibliographyEntries(contentHtml: string): string[] {
  if (!contentHtml.trim()) return [];
  const doc = new DOMParser().parseFromString(contentHtml, 'text/html');
  const entries = Array.from(doc.querySelectorAll('.csl-entry'))
    .map((el) => (el.textContent ?? '').replace(/\s+/g, ' ').trim())
    .filter((t) => t.length > 0);
  if (entries.length > 0) return entries;
  const whole = (doc.body.textContent ?? '').replace(/\s+/g, ' ').trim();
  return whole ? [whole] : [];
}

/**
 * Render a bibliography block — each cached entry as a body-text paragraph.
 */
export function renderBibliography(ctx: PDFRenderContext, node: JSONContent): void {
  const content = (node.attrs?.['bibHtml'] as string | undefined) || '';
  const entries = extractBibliographyEntries(content);
  if (entries.length === 0) return;
  const fontSize = PDF_STYLE.bodyFontSize;
  for (const entry of entries) {
    checkPageBreak(ctx, fontSize * PDF_STYLE.lineHeight);
    const seg: TextSegment = {
      text: entry,
      bold: false, italic: false, underline: false, strike: false, code: false,
      color: null, highlight: null, fontSizeScale: 1, yOffset: 0,
    };
    renderSegmentedText(ctx, [seg], fontSize, 'normal', ctx.marginLeft, ctx.contentWidth, 'left');
    ctx.y += 2;
  }
}

export function renderParagraph(ctx: PDFRenderContext, node: JSONContent, indent: number): void {
  const fontSize = PDF_STYLE.bodyFontSize;
  const textAlign = (node.attrs?.['textAlign'] as string | undefined) || 'left';
  checkPageBreak(ctx, fontSize * PDF_STYLE.lineHeight);

  const segments = extractSegments(node);
  const plainText = segments.map((s) => s.text).join('');

  if (!plainText.trim()) {
    // Empty paragraph - add some space
    ctx.y += fontSize * 0.352778 * PDF_STYLE.lineHeight;
    return;
  }

  const indentMm = indent * PDF_STYLE.listIndent;
  const availableWidth = ctx.contentWidth - indentMm;

  renderSegmentedText(ctx, segments, fontSize, 'normal', ctx.marginLeft + indentMm, availableWidth, textAlign);

  ctx.y += 2;
}

/**
 * Render a bullet list.
 */
export async function renderBulletList(
  ctx: PDFRenderContext,
  node: JSONContent,
  listLevel: number
): Promise<void> {
  if (!node.content) return;

  for (const child of node.content) {
    await renderNode(ctx, child, listLevel + 1);
  }

  ctx.y += 2;
}

/**
 * Render an ordered list.
 */
export async function renderOrderedList(
  ctx: PDFRenderContext,
  node: JSONContent,
  listLevel: number
): Promise<void> {
  if (!node.content) return;

  const counter = { value: (node.attrs?.['start'] as number | undefined) || 1 };

  for (const child of node.content) {
    await renderNode(ctx, child, listLevel + 1, counter);
  }

  ctx.y += 2;
}

/**
 * Render a list item.
 */
export async function renderListItem(
  ctx: PDFRenderContext,
  node: JSONContent,
  listLevel: number,
  listCounter?: { value: number }
): Promise<void> {
  if (!node.content) return;

  const fontSize = PDF_STYLE.bodyFontSize;
  checkPageBreak(ctx, fontSize * PDF_STYLE.lineHeight);

  ctx.doc.setFont(PDF_FONT_SANS, 'normal');
  ctx.doc.setFontSize(fontSize);

  const indentMm = listLevel * PDF_STYLE.listIndent;

  // Draw bullet or number
  const bulletX = ctx.marginLeft + indentMm - 4;

  if (listCounter) {
    // Ordered list
    ctx.doc.text(`${listCounter.value}.`, bulletX, ctx.y);
    listCounter.value++;
  } else {
    // Bullet list
    ctx.doc.setFillColor(0, 0, 0);
    ctx.doc.circle(bulletX, ctx.y - 1.5, 1, 'F');
  }

  // Render list item content
  for (const child of node.content) {
    await renderNode(ctx, child, listLevel);
  }
}

/**
 * Render a code block.
 */
export function renderCodeBlock(ctx: PDFRenderContext, node: JSONContent): void {
  const text = extractText(node);
  const fontSize = 10;
  const lineHeightMm = fontSize * 0.352778 * PDF_STYLE.lineHeight;

  ctx.doc.setFont(PDF_FONT_MONO, 'normal');
  ctx.doc.setFontSize(fontSize);

  // Preserve indentation: split on \n manually, then wrap each line individually
  // and re-prepend the line's leading whitespace to wrapped continuations.
  const innerWidth = ctx.contentWidth - PDF_STYLE.codeBlockPadding * 2;
  const wrappedLines: string[] = [];
  for (const rawLine of text.split('\n')) {
    if (rawLine.length === 0) {
      wrappedLines.push('');
      continue;
    }
    const indentMatch = rawLine.match(/^[\t ]*/);
    const indent = indentMatch ? indentMatch[0] : '';
    const segments = ctx.doc.splitTextToSize(rawLine, innerWidth) as string[];
    if (segments.length <= 1) {
      wrappedLines.push(rawLine);
    } else {
      wrappedLines.push(segments[0] ?? rawLine);
      for (let i = 1; i < segments.length; i++) {
        wrappedLines.push(indent + (segments[i] ?? ''));
      }
    }
  }

  const blockHeight = wrappedLines.length * lineHeightMm + PDF_STYLE.codeBlockPadding * 2;

  if (blockHeight <= pageContentHeight(ctx)) {
    // Fits on a page: kept together, on the next page if need be.
    checkPageBreak(ctx, blockHeight);
    drawCodeLines(ctx, wrappedLines, lineHeightMm);
  } else {
    // Taller than a page: split across pages, starting where it stands. Drawn
    // in one piece it ran off the page and lost its end (DSK-251).
    checkPageBreak(ctx, CODE_BLOCK_MIN_LINES * lineHeightMm + PDF_STYLE.codeBlockPadding * 2);
    let remaining = wrappedLines;
    while (remaining.length > 0) {
      const room = Math.floor((spaceLeft(ctx) - PDF_STYLE.codeBlockPadding * 2) / lineHeightMm);
      const part = remaining.slice(0, Math.max(1, room));
      remaining = remaining.slice(part.length);
      drawCodeLines(ctx, part, lineHeightMm);
      if (remaining.length > 0) {
        ctx.doc.addPage();
        ctx.pageNumber++;
        ctx.y = ctx.marginTop;
      }
    }
  }

  ctx.doc.setFont(PDF_FONT_SANS, 'normal');
}

/** Fewest lines of a split code block worth starting at the foot of a page. */
const CODE_BLOCK_MIN_LINES = 3;

/** Draw code lines on their shaded background at the current position. */
function drawCodeLines(ctx: PDFRenderContext, lines: string[], lineHeightMm: number): void {
  const height = lines.length * lineHeightMm + PDF_STYLE.codeBlockPadding * 2;

  ctx.doc.setFillColor(PDF_STYLE.codeBlockBg);
  ctx.doc.rect(
    ctx.marginLeft,
    ctx.y - 3,
    ctx.contentWidth,
    height,
    'F'
  );

  ctx.doc.setTextColor(0, 0, 0);
  // Space the lines as the background is sized: jsPDF's own default (1.15)
  // left the bottom fifth of every block empty.
  ctx.doc.text(lines, ctx.marginLeft + PDF_STYLE.codeBlockPadding, ctx.y + PDF_STYLE.codeBlockPadding, {
    lineHeightFactor: PDF_STYLE.lineHeight,
  });

  ctx.y += height + 4;
}

/**
 * Render a blockquote.
 */
export async function renderBlockquote(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
  if (!node.content) return;

  const pad = PDF_STYLE.blockquoteVerticalPadding;
  const startY = ctx.y;
  const startPage = ctx.pageNumber;

  ctx.y += pad;
  ctx.doc.setFont(PDF_FONT_SANS, 'italic');

  for (const child of node.content) {
    await renderNode(ctx, child, 1);
  }

  // Last child added trailing 2mm; reduce so internal bottom pad reads symmetric with top
  ctx.y += pad - 2;

  ctx.doc.setDrawColor(150, 150, 150);
  ctx.doc.setLineWidth(1);

  if (ctx.pageNumber === startPage) {
    ctx.doc.line(ctx.marginLeft + 2, startY, ctx.marginLeft + 2, ctx.y);
  } else {
    const footerSpace = ctx.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
    ctx.doc.setPage(startPage);
    ctx.doc.line(
      ctx.marginLeft + 2,
      startY,
      ctx.marginLeft + 2,
      ctx.pageHeight - ctx.marginBottom - footerSpace,
    );
    ctx.doc.setPage(ctx.pageNumber);
    ctx.doc.line(ctx.marginLeft + 2, ctx.marginTop, ctx.marginLeft + 2, ctx.y);
  }

  ctx.doc.setFont(PDF_FONT_SANS, 'normal');
  ctx.y += 2;
}

/**
 * Render a horizontal rule.
 */
export function renderHorizontalRule(ctx: PDFRenderContext): void {
  checkPageBreak(ctx, 10);

  ctx.y += 4;
  ctx.doc.setDrawColor(200, 200, 200);
  ctx.doc.setLineWidth(0.5);
  ctx.doc.line(ctx.marginLeft, ctx.y, ctx.marginLeft + ctx.contentWidth, ctx.y);
  ctx.y += 6;
}

/**
 * Render a task list (checkable items).
 */
export async function renderTaskList(
  ctx: PDFRenderContext,
  node: JSONContent,
  listLevel: number
): Promise<void> {
  if (!node.content) return;

  for (const child of node.content) {
    await renderNode(ctx, child, listLevel + 1);
  }
  ctx.y += 2;
}

/**
 * Render a task list item with checkbox.
 */
export async function renderTaskItem(
  ctx: PDFRenderContext,
  node: JSONContent,
  listLevel: number
): Promise<void> {
  if (!node.content) return;

  const checked = !!(node.attrs?.['checked']);
  const fontSize = PDF_STYLE.bodyFontSize;
  checkPageBreak(ctx, fontSize * PDF_STYLE.lineHeight);

  const indentMm = listLevel * PDF_STYLE.listIndent;
  const checkboxX = ctx.marginLeft + indentMm - 5;
  const checkboxY = ctx.y - 3;
  const boxSize = 3;

  // Draw checkbox outline
  ctx.doc.setDrawColor(100, 100, 100);
  ctx.doc.setLineWidth(0.3);
  ctx.doc.rect(checkboxX, checkboxY, boxSize, boxSize, 'S');

  // Draw checkmark if checked
  if (checked) {
    ctx.doc.setDrawColor(0, 120, 0);
    ctx.doc.setLineWidth(0.5);
    ctx.doc.line(checkboxX + 0.5, checkboxY + 1.5, checkboxX + 1.2, checkboxY + 2.5);
    ctx.doc.line(checkboxX + 1.2, checkboxY + 2.5, checkboxX + 2.5, checkboxY + 0.5);
  }

  // Render task item content
  for (const child of node.content) {
    await renderNode(ctx, child, listLevel);
  }
}

const PDF_CALLOUT_COLORS: Record<string, [number, number, number]> = {
  note: [74, 134, 232],
  tip: [46, 158, 91],
  warning: [217, 154, 0],
  danger: [214, 69, 69],
};

/** Callout / admonition — coloured left border + variant label + content. */
export async function renderCallout(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
  if (!node.content) return;
  const variant = (node.attrs?.['variant'] as string) ?? 'note';
  const color = PDF_CALLOUT_COLORS[variant] ?? PDF_CALLOUT_COLORS['note']!;
  const startY = ctx.y;
  const startPage = ctx.pageNumber;

  ctx.y += 3;
  const labelLineH = 8 * 0.352778 * 1.3;
  const bodyAscent = PDF_STYLE.bodyFontSize * 0.352778 * PDF_STYLE.lineHeight * 0.75;
  checkPageBreak(ctx, labelLineH + bodyAscent + 4);
  ctx.doc.setFont(PDF_FONT_SANS, 'bold');
  ctx.doc.setFontSize(8);
  ctx.doc.setTextColor(color[0], color[1], color[2]);
  ctx.doc.text(variant.toUpperCase(), ctx.marginLeft + 4, ctx.y + labelLineH * 0.72);
  // Advance below the label AND the first body line's ascent — renderSegmentedText
  // draws each baseline at ctx.y, so text rises above it; without this the body's
  // first line overlaps the label.
  ctx.y += labelLineH + bodyAscent;
  ctx.doc.setTextColor(0, 0, 0);
  ctx.doc.setFont(PDF_FONT_SANS, 'normal');

  for (const child of node.content) {
    await renderNode(ctx, child, 1);
  }
  ctx.y += 1;

  // Coloured left border (handles page spill like blockquote).
  ctx.doc.setDrawColor(color[0], color[1], color[2]);
  ctx.doc.setLineWidth(1.5);
  if (ctx.pageNumber === startPage) {
    ctx.doc.line(ctx.marginLeft + 1.5, startY, ctx.marginLeft + 1.5, ctx.y);
  } else {
    const footerSpace = ctx.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
    ctx.doc.setPage(startPage);
    ctx.doc.line(ctx.marginLeft + 1.5, startY, ctx.marginLeft + 1.5, ctx.pageHeight - ctx.marginBottom - footerSpace);
    ctx.doc.setPage(ctx.pageNumber);
    ctx.doc.line(ctx.marginLeft + 1.5, ctx.marginTop, ctx.marginLeft + 1.5, ctx.y);
  }
  ctx.doc.setDrawColor(0, 0, 0);
  ctx.y += 3;
}
