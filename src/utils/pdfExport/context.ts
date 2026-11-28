/**
 * The render context every PDF renderer works through (position, page geometry
 * and what has been collected so far), the page types the exporter takes, and
 * the page-break check.
 */

import type { JSONContent } from '@tiptap/core';
import type { ImageCompression } from 'jspdf';
import type { RichTextContent } from '../../types/RichText';
import type { Shape } from '../../shapes/Shape';
import type { PdfDoc } from './doc';
import { type BreakAt, type Pager, withBlockId } from './pager';
import { PDF_STYLE } from './style';

/**
 * A rich text page prepared for PDF export (Tiptap JSON content).
 */
export interface PDFRichTextPage {
  /** Stable page ID (used for resolving internal `docushark://page/<id>` links) */
  id?: string;
  /** Page display name */
  name: string;
  /** Tiptap JSON content */
  content: RichTextContent;
}

/**
 * A canvas page prepared for PDF export (shapes and z-order).
 */
export interface PDFCanvasPage {
  /** Page display name */
  name: string;
  /** Shapes keyed by ID */
  shapes: Record<string, Shape>;
  /** Z-order of shapes */
  shapeOrder: string[];
}

/**
 * A styled text segment for inline rendering.
 */
export interface TextSegment {
  text: string;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  code: boolean;
  color: string | null;
  highlight: string | null;
  /** Font size override (for sub/superscript) */
  fontSizeScale: number;
  /** Vertical offset in mm (positive = up for superscript, negative = down for subscript) */
  yOffset: number;
  /** Hyperlink href if this segment has a link mark */
  link?: string;
  /** Index of the inline child it came from, for page-break positions (DSK-252) */
  source?: number;
}

/**
 * Context for PDF rendering, tracks current position and state.
 */
export interface PDFRenderContext {
  /** A real jsPDF when exporting, a `MeasureDoc` when only laying out (DSK-252). */
  doc: PdfDoc;
  /** Records every page break and what opens the new page. */
  pager: Pager;
  /** Index path, from the prose page's root, of the node being laid out. */
  path: number[];
  /** The nodes along `path`, innermost last. */
  blocks: JSONContent[];
  /** jsPDF's name for the document's font family (DSK-246), for `setFont`. */
  textFont: string;
  y: number;
  pageWidth: number;
  pageHeight: number;
  contentWidth: number;
  marginLeft: number;
  marginRight: number;
  marginTop: number;
  marginBottom: number;
  pageNumber: number;
  totalPages: number;
  showPageNumbers: boolean;
  pageNumberFormat: 'numeric' | 'x-of-y';
  images: Map<string, string>; // blobId -> dataURL
  imageCompression: ImageCompression;
  /** Map from rich-text page ID to PDF page number (for internal link resolution) */
  pageIdToPdfPage: Record<string, number>;
  /** Headings collected during render for ToC + outline */
  collectedHeadings: Array<{
    level: number;
    text: string;
    pdfPage: number;
    pageId: string | undefined;
    /** Index of this heading within its page (used to disambiguate duplicates) */
    pageHeadingIndex: number | undefined;
    /** The heading's durable block id (JP-432 Pillar C), when it carries one */
    headingId: string | undefined;
  }>;
  /** Per-page heading counter, resets when a new rich-text page begins */
  currentPageHeadingIndex: number;
  /** ID of the rich-text page currently being rendered */
  currentPageId: string | undefined;
  /** Internal heading links deferred until after render (so target pages are known) */
  deferredHeadingLinks: Array<{
    pdfPage: number;
    x: number;
    y: number;
    w: number;
    h: number;
    targetPageId: string;
    /** Positional target (legacy grammar); undefined for id-form links */
    targetHeadingIndex: number | undefined;
    /** Durable-id target (id grammar); undefined for legacy links */
    targetHeadingId: string | undefined;
  }>;
}

/** Space kept clear at the foot of each page for its number, when shown. */
function footerSpace(ctx: PDFRenderContext): number {
  return ctx.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
}

/** Height left for content on the current page, above the footer. */
export function spaceLeft(ctx: PDFRenderContext): number {
  return ctx.pageHeight - ctx.marginBottom - footerSpace(ctx) - ctx.y;
}

/** Height a whole page offers content, between its margins and above the footer. */
export function pageContentHeight(ctx: PDFRenderContext): number {
  return ctx.pageHeight - ctx.marginTop - ctx.marginBottom - footerSpace(ctx);
}

/** The node being laid out, as what would open a new page. */
export function blockAt(ctx: PDFRenderContext): BreakAt {
  return { kind: 'block', path: [...ctx.path], ...withBlockId(ctx.blocks[ctx.blocks.length - 1]) };
}

/** Start a new page, opened by `at`, and record the break. */
export function newPage(ctx: PDFRenderContext, at: BreakAt): void {
  ctx.doc.addPage();
  ctx.pageNumber++;
  ctx.y = ctx.marginTop;
  ctx.pager.record(ctx.pageNumber, ctx.currentPageId, at);
}

/**
 * Start a new page when `requiredHeight` doesn't fit in what's left of this
 * one (above the footer, when page numbers are shown). `at` says what opens
 * the new page; by default, the node being laid out.
 */
export function checkPageBreak(ctx: PDFRenderContext, requiredHeight: number, at?: BreakAt): void {
  if (requiredHeight > spaceLeft(ctx)) {
    newPage(ctx, at ?? blockAt(ctx));
  }
}
