/**
 * Text layout for PDF export: inline segments with their marks, colour parsing,
 * measuring, word breaking, and drawing wrapped, styled text.
 */

import type { jsPDF } from 'jspdf';
import type { JSONContent } from '@tiptap/core';
import { PDF_FONT_SANS, PDF_FONT_MONO } from './fonts';
import { formatFileSize } from '../byteSize';
import { parseHeadingHref } from '../headingLinks';
import { NAMED_COLORS } from '../color';
import { checkPageBreak, type PDFRenderContext, type TextSegment } from './context';
import { PDF_STYLE } from './style';

/**
 * Extract styled text segments from a node's content.
 * Walks inline children and collects marks (bold, italic, color, etc).
 */
/** Exported for unit testing — builds inline TextSegments from a block node. */
export function extractSegments(node: JSONContent): TextSegment[] {
  const segments: TextSegment[] = [];
  if (!node.content) return segments;

  for (const child of node.content) {
    if (child.type === 'text') {
      const marks = child.marks || [];
      const seg: TextSegment = {
        text: child.text || '',
        bold: marks.some((m) => m.type === 'bold'),
        italic: marks.some((m) => m.type === 'italic'),
        underline: marks.some((m) => m.type === 'underline'),
        strike: marks.some((m) => m.type === 'strike'),
        code: marks.some((m) => m.type === 'code'),
        color: null,
        highlight: null,
        fontSizeScale: 1,
        yOffset: 0,
      };

      const colorMark = marks.find((m) => m.type === 'textStyle');
      if (colorMark?.attrs?.['color']) {
        seg.color = colorMark.attrs['color'] as string;
      }

      const highlightMark = marks.find((m) => m.type === 'highlight');
      if (highlightMark?.attrs?.['color']) {
        seg.highlight = highlightMark.attrs['color'] as string;
      }

      if (marks.some((m) => m.type === 'superscript')) {
        seg.fontSizeScale = 0.7;
        seg.yOffset = -1.5;
      } else if (marks.some((m) => m.type === 'subscript')) {
        seg.fontSizeScale = 0.7;
        seg.yOffset = 1.5;
      }

      const linkMark = marks.find((m) => m.type === 'link');
      if (linkMark?.attrs?.['href']) {
        seg.link = linkMark.attrs['href'] as string;
      }

      segments.push(seg);
    } else if (child.type === 'hardBreak') {
      segments.push({
        text: '\n',
        bold: false, italic: false, underline: false, strike: false, code: false,
        color: null, highlight: null, fontSizeScale: 1, yOffset: 0,
      });
    } else if (child.type === 'citationInline') {
      // Inline citation: render the cached formatted label (JP-89). Empty when a
      // doc was never opened in the editor (no label cached yet) — skip then.
      const label = (child.attrs?.['label'] as string | undefined) || '';
      if (label) {
        segments.push({
          text: label,
          bold: false, italic: false, underline: false, strike: false, code: false,
          color: null, highlight: null, fontSizeScale: 1, yOffset: 0,
        });
      }
    } else if (child.type === 'fieldRef') {
      // Inline field: render the cached resolved value (Phase 3). Empty when a
      // doc was never opened in the editor (no label cached) — skip then.
      const label = (child.attrs?.['label'] as string | undefined) || '';
      if (label) {
        segments.push({
          text: label,
          bold: false, italic: false, underline: false, strike: false, code: false,
          color: null, highlight: null, fontSizeScale: 1, yOffset: 0,
        });
      }
    } else if (child.type === 'fileRef') {
      // Inline file chip (JP-495). A PDF can't carry the attachment, but it must
      // not silently drop the fact that one is referenced — a reader of the
      // export would have no idea a file was ever there. Name + size is the
      // honest static rendering, matching how the other inline atoms degrade.
      const name = (child.attrs?.['fileName'] as string | undefined) || 'Attachment';
      const rawSize = Number(child.attrs?.['fileSize'] ?? 0);
      const size = Number.isFinite(rawSize) && rawSize > 0 ? ` (${formatFileSize(rawSize)})` : '';
      segments.push({
        text: `${name}${size}`,
        bold: false, italic: true, underline: false, strike: false, code: false,
        color: null, highlight: null, fontSizeScale: 1, yOffset: 0,
      });
    }
    // Skip other non-text inline nodes (mathInline handled separately at block level)
  }

  return segments;
}

/**
 * Parse a CSS color string into [r, g, b].
 * Handles: #rgb, #rrggbb, rgb(r,g,b), rgba(r,g,b,a), and common named colors.
 * Returns null for unparseable values.
 */
export function parseColor(color: string): [number, number, number] | null {
  const trimmed = color.trim();

  // #rrggbb or #rgb
  if (trimmed.startsWith('#')) {
    const hex = trimmed.slice(1);
    if (hex.length === 3 && /^[0-9a-fA-F]{3}$/.test(hex)) {
      const r = parseInt(hex[0]! + hex[0]!, 16);
      const g = parseInt(hex[1]! + hex[1]!, 16);
      const b = parseInt(hex[2]! + hex[2]!, 16);
      return [r, g, b];
    }
    if (hex.length === 6 && /^[0-9a-fA-F]{6}$/.test(hex)) {
      const r = parseInt(hex.substring(0, 2), 16);
      const g = parseInt(hex.substring(2, 4), 16);
      const b = parseInt(hex.substring(4, 6), 16);
      return [r, g, b];
    }
    return null;
  }

  // rgb(r, g, b) or rgba(r, g, b, a)
  const rgbMatch = trimmed.match(/^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/);
  if (rgbMatch) {
    return [
      Math.min(255, parseInt(rgbMatch[1]!, 10)),
      Math.min(255, parseInt(rgbMatch[2]!, 10)),
      Math.min(255, parseInt(rgbMatch[3]!, 10)),
    ];
  }

  // Named CSS colors — shared with the editor's color input so the two
  // grammars cannot drift (see utils/color.ts NAMED_COLORS).
  const named = NAMED_COLORS[trimmed.toLowerCase()];
  if (named) return [named.r, named.g, named.b];

  return null;
}

/**
 * Measure a text string's width in mm after applying a segment's font style.
 * The `text` parameter is the actual string to measure (e.g. a single word),
 * while `seg` provides the font styling (bold, italic, code, size scale).
 */
function measureTextWidth(doc: jsPDF, seg: TextSegment, text: string, fontSize: number, defaultStyle: string): number {
  applySegmentFont(doc, seg, fontSize, defaultStyle);
  return doc.getTextWidth(text);
}

/**
 * Split a string into character-bounded pieces that each fit within
 * `availableWidth`, using `measure(prefix)` to get the width of a candidate
 * prefix. Used as a fallback when a single token is wider than the line.
 *
 * Exported for unit testing — the measure callback lets tests run without jsPDF.
 */
export function breakOversizedWord(
  text: string,
  availableWidth: number,
  measure: (s: string) => number,
): string[] {
  if (text.length === 0) return [];
  const pieces: string[] = [];
  let start = 0;
  while (start < text.length) {
    let lo = 1;
    let hi = text.length - start;
    let best = 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      const slice = text.slice(start, start + mid);
      if (measure(slice) <= availableWidth) {
        best = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    pieces.push(text.slice(start, start + best));
    start += best;
  }
  return pieces;
}

/**
 * Apply a segment's font style to jsPDF.
 */
function applySegmentFont(doc: jsPDF, seg: TextSegment, fontSize: number, defaultStyle: string): void {
  const actualSize = fontSize * seg.fontSizeScale;
  doc.setFontSize(actualSize);

  if (seg.code) {
    doc.setFont(PDF_FONT_MONO, 'normal');
  } else {
    let style = defaultStyle;
    if (seg.bold && seg.italic) style = 'bolditalic';
    else if (seg.bold) style = 'bold';
    else if (seg.italic) style = 'italic';
    doc.setFont(PDF_FONT_SANS, style);
  }
}

/**
 * Render styled text segments with word-wrapping, alignment, and inline marks.
 * Handles bold, italic, underline, strikethrough, color, highlight, code,
 * subscript, superscript, and text alignment.
 */
export function renderSegmentedText(
  ctx: PDFRenderContext,
  segments: TextSegment[],
  fontSize: number,
  defaultStyle: string,
  startX: number,
  availableWidth: number,
  textAlign: string
): void {
  if (segments.length === 0) {
    ctx.y += fontSize * 0.352778 * PDF_STYLE.lineHeight;
    return;
  }

  const lineHeightMm = fontSize * 0.352778 * PDF_STYLE.lineHeight;

  // Break segments into words, preserving which segment each word belongs to
  interface WordChunk { text: string; seg: TextSegment; }
  const words: WordChunk[] = [];
  for (const seg of segments) {
    if (seg.text === '\n') {
      words.push({ text: '\n', seg });
      continue;
    }
    // Split on word boundaries but keep leading/trailing spaces with the word
    const parts = seg.text.split(/( +)/);
    for (const part of parts) {
      if (part.length > 0) {
        words.push({ text: part, seg });
      }
    }
  }

  // Build lines by wrapping words
  interface LineDef { chunks: WordChunk[]; width: number; }
  const lines: LineDef[] = [];
  let currentLine: WordChunk[] = [];
  let currentLineWidth = 0;

  for (const word of words) {
    if (word.text === '\n') {
      lines.push({ chunks: currentLine, width: currentLineWidth });
      currentLine = [];
      currentLineWidth = 0;
      continue;
    }

    const wordWidth = measureTextWidth(ctx.doc, word.seg, word.text, fontSize, defaultStyle);

    // Single token wider than the entire line — fall back to character-level
    // breaking so the text can't overflow the column / page. Whitespace-only
    // tokens skip this path; they collapse naturally at line boundaries.
    if (wordWidth > availableWidth && !/^ +$/.test(word.text)) {
      if (currentLine.length > 0) {
        lines.push({ chunks: currentLine, width: currentLineWidth });
        currentLine = [];
        currentLineWidth = 0;
      }
      applySegmentFont(ctx.doc, word.seg, fontSize, defaultStyle);
      const pieces = breakOversizedWord(
        word.text,
        availableWidth,
        (s) => ctx.doc.getTextWidth(s),
      );
      for (let i = 0; i < pieces.length - 1; i++) {
        const pieceText = pieces[i]!;
        const pieceWidth = measureTextWidth(ctx.doc, word.seg, pieceText, fontSize, defaultStyle);
        lines.push({ chunks: [{ text: pieceText, seg: word.seg }], width: pieceWidth });
      }
      const lastPiece = pieces[pieces.length - 1]!;
      currentLine = [{ text: lastPiece, seg: word.seg }];
      currentLineWidth = measureTextWidth(ctx.doc, word.seg, lastPiece, fontSize, defaultStyle);
      continue;
    }

    if (currentLineWidth + wordWidth > availableWidth && currentLine.length > 0) {
      lines.push({ chunks: currentLine, width: currentLineWidth });
      currentLine = [];
      currentLineWidth = 0;
    }

    currentLine.push(word);
    currentLineWidth += wordWidth;
  }
  if (currentLine.length > 0) {
    lines.push({ chunks: currentLine, width: currentLineWidth });
  }

  // Render each line
  for (const line of lines) {
    checkPageBreak(ctx, lineHeightMm);

    // Calculate x offset for alignment
    let lineX = startX;
    if (textAlign === 'center') {
      lineX = startX + (availableWidth - line.width) / 2;
    } else if (textAlign === 'right') {
      lineX = startX + availableWidth - line.width;
    }

    let cursorX = lineX;
    for (const chunk of line.chunks) {
      const seg = chunk.seg;
      applySegmentFont(ctx.doc, seg, fontSize, defaultStyle);

      // Set text color
      if (seg.color) {
        const rgb = parseColor(seg.color);
        if (rgb) ctx.doc.setTextColor(rgb[0], rgb[1], rgb[2]);
      } else if (seg.link) {
        ctx.doc.setTextColor(37, 99, 235); // link blue
      } else {
        ctx.doc.setTextColor(0, 0, 0);
      }

      const chunkWidth = ctx.doc.getTextWidth(chunk.text);
      const yPos = ctx.y + seg.yOffset;

      // Render highlight background
      if (seg.highlight) {
        const rgb = parseColor(seg.highlight);
        if (rgb) {
          ctx.doc.setFillColor(rgb[0], rgb[1], rgb[2]);
          ctx.doc.rect(cursorX, yPos - lineHeightMm * 0.7, chunkWidth, lineHeightMm * 0.9, 'F');
        }
      }

      // Render inline code background
      if (seg.code) {
        ctx.doc.setFillColor(PDF_STYLE.codeBlockBg);
        ctx.doc.rect(cursorX - 0.5, yPos - lineHeightMm * 0.7, chunkWidth + 1, lineHeightMm * 0.9, 'F');
        // Reset text color after fill
        if (seg.color) {
          const rgb = parseColor(seg.color);
          if (rgb) ctx.doc.setTextColor(rgb[0], rgb[1], rgb[2]);
        } else {
          ctx.doc.setTextColor(0, 0, 0);
        }
      }

      // Draw text
      ctx.doc.text(chunk.text, cursorX, yPos);

      // Hyperlink + auto-underline for links
      if (seg.link) {
        const linkY = yPos - lineHeightMm * 0.7;
        const linkH = lineHeightMm * 0.9;
        const headingLink = parseHeadingHref(seg.link);
        if (headingLink) {
          // Defer — we don't know the target's PDF page until the whole doc
          // has rendered. Both grammar forms (durable id + legacy positional).
          ctx.deferredHeadingLinks.push({
            pdfPage: ctx.pageNumber,
            x: cursorX,
            y: linkY,
            w: chunkWidth,
            h: linkH,
            targetPageId: headingLink.pageId,
            targetHeadingIndex: headingLink.index,
            targetHeadingId: headingLink.blockId,
          });
        } else if (seg.link.startsWith('docushark://page/')) {
          // Backwards compat: legacy page-level links
          const targetId = seg.link.slice('docushark://page/'.length);
          const targetPage = ctx.pageIdToPdfPage[targetId];
          if (targetPage !== undefined) {
            ctx.doc.link(cursorX, linkY, chunkWidth, linkH, { pageNumber: targetPage });
          }
        } else {
          ctx.doc.link(cursorX, linkY, chunkWidth, linkH, { url: seg.link });
        }
        if (!seg.underline) {
          const underY = yPos + 1;
          ctx.doc.setDrawColor(37, 99, 235);
          ctx.doc.setLineWidth(0.2);
          ctx.doc.line(cursorX, underY, cursorX + chunkWidth, underY);
        }
      }

      // Draw underline
      if (seg.underline) {
        const underY = yPos + 1;
        ctx.doc.setDrawColor(seg.color ? (parseColor(seg.color) || [0, 0, 0])[0] : 0,
                             seg.color ? (parseColor(seg.color) || [0, 0, 0])[1] : 0,
                             seg.color ? (parseColor(seg.color) || [0, 0, 0])[2] : 0);
        ctx.doc.setLineWidth(0.2);
        ctx.doc.line(cursorX, underY, cursorX + chunkWidth, underY);
      }

      // Draw strikethrough
      if (seg.strike) {
        const strikeY = yPos - lineHeightMm * 0.25;
        ctx.doc.setDrawColor(seg.color ? (parseColor(seg.color) || [0, 0, 0])[0] : 0,
                             seg.color ? (parseColor(seg.color) || [0, 0, 0])[1] : 0,
                             seg.color ? (parseColor(seg.color) || [0, 0, 0])[2] : 0);
        ctx.doc.setLineWidth(0.2);
        ctx.doc.line(cursorX, strikeY, cursorX + chunkWidth, strikeY);
      }

      cursorX += chunkWidth;
    }

    ctx.y += lineHeightMm;
  }

  // Reset defaults
  ctx.doc.setFont(PDF_FONT_SANS, 'normal');
  ctx.doc.setFontSize(PDF_STYLE.bodyFontSize);
  ctx.doc.setTextColor(0, 0, 0);
}

/**
 * Extract segments from a node recursively (for table cells which contain
 * paragraphs wrapping the text nodes).
 */
export function extractSegmentsDeep(node: JSONContent): TextSegment[] {
  if (node.type === 'text') {
    return extractSegments({ type: 'paragraph', content: [node] });
  }

  // If this node has inline text (or inline citation / field) children directly, extract them
  if (
    node.content &&
    node.content.some(
      (c) =>
        c.type === 'text' ||
        c.type === 'citationInline' ||
        c.type === 'fieldRef' ||
        // A paragraph holding ONLY a file chip still has content to render;
        // without this it is treated as empty and skipped entirely.
        c.type === 'fileRef',
    )
  ) {
    return extractSegments(node);
  }

  // Otherwise recurse into children (e.g. table cells contain paragraphs)
  const segments: TextSegment[] = [];
  if (node.content) {
    for (let i = 0; i < node.content.length; i++) {
      if (i > 0) {
        // Add line break between block children
        segments.push({
          text: '\n', bold: false, italic: false, underline: false, strike: false,
          code: false, color: null, highlight: null, fontSizeScale: 1, yOffset: 0,
        });
      }
      segments.push(...extractSegmentsDeep(node.content[i]!));
    }
  }
  return segments;
}

/**
 * Extract plain text from a node (recursive).
 */
export function extractText(node: JSONContent): string {
  if (node.type === 'text') {
    return node.text || '';
  }

  if (!node.content) {
    return '';
  }

  return node.content.map((child) => extractText(child)).join('');
}

/** Draw text centered in the content column; advances ctx.y. */
export function renderCenteredText(ctx: PDFRenderContext, text: string, sizePt: number): void {
  const lines = ctx.doc.splitTextToSize(text, ctx.contentWidth) as string[];
  const lineH = sizePt * 0.352778 * 1.3;
  checkPageBreak(ctx, lines.length * lineH + 2);
  for (const line of lines) {
    const w = ctx.doc.getTextWidth(line);
    ctx.doc.text(line, ctx.marginLeft + (ctx.contentWidth - w) / 2, ctx.y + lineH * 0.72);
    ctx.y += lineH;
  }
}
