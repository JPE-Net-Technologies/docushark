/**
 * The render context every PDF renderer works through (position, page geometry
 * and what has been collected so far), the page types the exporter takes, and
 * the page-break check.
 */

import type { jsPDF, ImageCompression } from 'jspdf';
import type { RichTextContent } from '../../types/RichText';
import type { Shape } from '../../shapes/Shape';
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
}

/**
 * Context for PDF rendering, tracks current position and state.
 */
export interface PDFRenderContext {
  doc: jsPDF;
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

/**
 * Check if we need a page break, and add one if necessary.
 * Accounts for footer space when page numbers are enabled.
 */
export function checkPageBreak(ctx: PDFRenderContext, requiredHeight: number): void {
  // Reserve extra space for page numbers if enabled
  const footerSpace = ctx.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
  const availableHeight = ctx.pageHeight - ctx.marginBottom - footerSpace - ctx.y;

  if (requiredHeight > availableHeight) {
    ctx.doc.addPage();
    ctx.pageNumber++;
    ctx.y = ctx.marginTop;
  }
}
