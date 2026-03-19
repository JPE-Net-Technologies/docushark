/**
 * PDF export utilities for converting rich text documents to PDF.
 *
 * Uses jsPDF library to generate PDF from Tiptap JSON content.
 * Supports multi-page export: iterates all rich text pages and canvas pages.
 * Renders inline formatting (bold, italic, underline, strikethrough, color,
 * highlight, inline code), text alignment, tables, task lists, and LaTeX math.
 */

import { jsPDF } from 'jspdf';
import type { JSONContent } from '@tiptap/core';
import type { RichTextContent } from '../types/RichText';
import { registerPDFFonts, PDF_FONT_SANS, PDF_FONT_MONO } from './pdfFonts';
import {
  PDFExportOptions,
  PDFCoverPage,
  PDFDiagramEmbed,
  getPageDimensions,
} from '../types/PDFExport';
import { blobStorage } from '../storage/BlobStorage';
import { exportToPng, type ExportData } from './exportUtils';
import { useDocumentStore } from '../store/documentStore';
import { isGroup, type GroupShape, type Shape } from '../shapes/Shape';

/**
 * A rich text page prepared for PDF export (Tiptap JSON content).
 */
export interface PDFRichTextPage {
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

// ─── PDF Style Configuration ─────────────────────────────────────────────────

/**
 * Centralized style config for PDF rendering.
 * All hardcoded constants live here; renderers read from this object.
 */
const PDF_STYLE = {
  /** Font sizes for heading levels (in points) */
  headingSizes: { 1: 24, 2: 20, 3: 18, 4: 16, 5: 14, 6: 12 } as Record<number, number>,
  /** Default body text size (pt) */
  bodyFontSize: 12,
  /** Line height multiplier */
  lineHeight: 1.4,
  /** List indentation per level (mm) */
  listIndent: 8,
  /** Code block padding (mm) */
  codeBlockPadding: 3,
  /** Code block background color */
  codeBlockBg: '#f5f5f5',
  /** Footer height for page numbers (mm) */
  pageNumberFooterHeight: 10,
  /** Table cell padding (mm) */
  tableCellPadding: 2,
  /** Table header background */
  tableHeaderBg: '#f0f0f0',
  /** Table border color */
  tableBorderColor: '#cccccc',
  /** Block equation display font size (px, for KaTeX container) */
  mathBlockFontSize: '14px',
  /** Inline equation font size (px) */
  mathInlineFontSize: '12px',
  /** Max height for block equations (mm) */
  mathBlockMaxHeight: 30,
  /** Max height for inline equations (mm) */
  mathInlineMaxHeight: 12,
} as const;

// ─── PDF Node Renderer Registry ──────────────────────────────────────────────

/**
 * Signature for a registered PDF node renderer.
 *
 * Each Tiptap node type registers a function matching this signature.
 * The registry replaces the old switch/case in renderNode(), so adding
 * a new Tiptap extension only requires calling `pdfNodeRenderers.register()`.
 */
type PDFNodeRenderFn = (
  ctx: PDFRenderContext,
  node: JSONContent,
  listLevel: number,
  listCounter?: { value: number },
) => Promise<void> | void;

class PDFNodeRendererRegistry {
  private handlers = new Map<string, PDFNodeRenderFn>();

  /** Register a renderer for a Tiptap node type. */
  register(nodeType: string, fn: PDFNodeRenderFn): void {
    this.handlers.set(nodeType, fn);
  }

  /** Render a node. Falls back to rendering children for unknown types. */
  async render(
    ctx: PDFRenderContext,
    node: JSONContent,
    listLevel: number,
    listCounter?: { value: number },
  ): Promise<void> {
    const handler = node.type ? this.handlers.get(node.type) : undefined;
    if (handler) {
      await handler(ctx, node, listLevel, listCounter);
    } else if (node.type && node.type !== 'doc' && node.type !== 'text') {
      console.warn(`[PDF Export] No renderer registered for node type: "${node.type}"`);
      // Fall through: render children so content isn't silently lost
      if (node.content) {
        for (const child of node.content) {
          await this.render(ctx, child, listLevel, listCounter);
        }
      }
    } else if (node.content) {
      for (const child of node.content) {
        await this.render(ctx, child, listLevel, listCounter);
      }
    }
  }

  /** Return all registered node type names. */
  getRegisteredTypes(): string[] {
    return [...this.handlers.keys()];
  }
}

/** Singleton registry — renderers are registered after their functions are defined. */
const pdfNodeRenderers = new PDFNodeRendererRegistry();

/**
 * A styled text segment for inline rendering.
 */
interface TextSegment {
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
}

/**
 * Context for PDF rendering, tracks current position and state.
 */
interface PDFRenderContext {
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
}

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

    // Render page title as heading if there are multiple pages
    if (pagesToRender.length > 1) {
      ctx.doc.setFont(PDF_FONT_SANS, 'bold');
      ctx.doc.setFontSize(16);
      const titleLines = ctx.doc.splitTextToSize(page.name, ctx.contentWidth);
      ctx.doc.text(titleLines, ctx.marginLeft, ctx.y);
      ctx.y += titleLines.length * (16 * 0.352778 * PDF_STYLE.lineHeight) + 6;

      // Thin separator line
      ctx.doc.setDrawColor(200, 200, 200);
      ctx.doc.setLineWidth(0.3);
      ctx.doc.line(ctx.marginLeft, ctx.y, ctx.marginLeft + ctx.contentWidth, ctx.y);
      ctx.y += 6;
    }

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

  // Store total pages
  ctx.totalPages = ctx.pageNumber;

  // Add page numbers to all pages
  if (options.showPageNumbers) {
    addPageNumbers(ctx, options.coverPage.enabled);
  }

  // Return as blob
  return doc.output('blob');
}

/**
 * Load all embedded images from content as data URLs.
 */
async function loadEmbeddedImages(content: JSONContent): Promise<Map<string, string>> {
  const images = new Map<string, string>();
  const blobIds = extractBlobIds(content);

  for (const blobId of blobIds) {
    const dataUrl = await loadBlobAsDataUrl(blobId);
    if (dataUrl) {
      images.set(blobId, dataUrl);
    }
  }

  return images;
}

/**
 * Extract all blob IDs from content (recursive).
 */
function extractBlobIds(node: JSONContent): string[] {
  const ids: string[] = [];

  if (node.type === 'image' && node.attrs?.['src']) {
    const src = node.attrs['src'] as string;
    if (src.startsWith('blob://')) {
      ids.push(src.slice(7)); // Remove 'blob://' prefix
    }
  }

  if (node.content) {
    for (const child of node.content) {
      ids.push(...extractBlobIds(child));
    }
  }

  return ids;
}

/**
 * Load a blob as a data URL.
 */
async function loadBlobAsDataUrl(blobId: string): Promise<string | null> {
  try {
    const blob = await blobStorage.loadBlob(blobId);
    if (!blob) return null;

    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        resolve(reader.result as string);
      };
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch (error) {
    console.error('Failed to load blob:', blobId, error);
    return null;
  }
}

/**
 * Image dimensions result.
 */
interface ImageDimensions {
  width: number;
  height: number;
}

/**
 * Check if a data URL is an SVG image.
 */
function isSvgDataUrl(dataUrl: string): boolean {
  return dataUrl.startsWith('data:image/svg+xml');
}

/**
 * Convert an SVG data URL to a PNG data URL using canvas.
 * This is needed because jsPDF doesn't support SVG directly.
 */
async function convertSvgToPng(svgDataUrl: string, scale: number = 2): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      // Create canvas with scaled dimensions for better quality
      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth * scale;
      canvas.height = img.naturalHeight * scale;

      const ctx = canvas.getContext('2d');
      if (!ctx) {
        reject(new Error('Failed to get canvas context'));
        return;
      }

      // Draw SVG to canvas
      ctx.scale(scale, scale);
      ctx.drawImage(img, 0, 0);

      // Convert to PNG data URL
      const pngDataUrl = canvas.toDataURL('image/png');
      resolve(pngDataUrl);
    };
    img.onerror = () => {
      reject(new Error('Failed to load SVG image'));
    };
    img.src = svgDataUrl;
  });
}

/**
 * Extract image format from a data URL.
 * Returns format suitable for jsPDF addImage (JPEG, PNG, GIF, WEBP).
 */
function getImageFormat(dataUrl: string): string {
  const match = dataUrl.match(/^data:image\/([^;]+);/);
  if (match && match[1]) {
    const mimeSubtype = match[1].toLowerCase();

    // Map common formats
    if (mimeSubtype === 'jpeg' || mimeSubtype === 'jpg') return 'JPEG';
    if (mimeSubtype === 'png') return 'PNG';
    if (mimeSubtype === 'gif') return 'GIF';
    if (mimeSubtype === 'bmp') return 'BMP';
    if (mimeSubtype === 'webp') return 'WEBP';
  }
  // Default to PNG
  return 'PNG';
}

/**
 * Get image dimensions from a data URL.
 * Returns dimensions in pixels.
 */
async function getImageDimensions(dataUrl: string): Promise<ImageDimensions> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      reject(new Error('Failed to load image'));
    };
    img.src = dataUrl;
  });
}

/**
 * Calculate scaled dimensions to fit within max bounds while preserving aspect ratio.
 * @param width - Original width in pixels
 * @param height - Original height in pixels
 * @param maxWidth - Maximum width in mm
 * @param maxHeight - Maximum height in mm
 * @returns Scaled dimensions in mm
 */
function calculateScaledDimensions(
  width: number,
  height: number,
  maxWidth: number,
  maxHeight: number
): { width: number; height: number } {
  // Convert pixels to mm (assuming 96 DPI for screen images)
  const pxToMm = 25.4 / 96;
  let imgWidthMm = width * pxToMm;
  let imgHeightMm = height * pxToMm;

  // Scale down if needed, preserving aspect ratio
  if (imgWidthMm > maxWidth) {
    const scale = maxWidth / imgWidthMm;
    imgWidthMm = maxWidth;
    imgHeightMm *= scale;
  }

  if (imgHeightMm > maxHeight) {
    const scale = maxHeight / imgHeightMm;
    imgHeightMm = maxHeight;
    imgWidthMm *= scale;
  }

  return { width: imgWidthMm, height: imgHeightMm };
}

/**
 * Render the cover page.
 */
async function renderCoverPage(
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
      ctx.doc.addImage(
        imageDataUrl,
        format,
        centerX - scaled.width / 2,
        y,
        scaled.width,
        scaled.height
      );

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
 * Render all canvas pages as diagrams to PDF.
 * If canvasPages are provided, each page gets its own diagram with a title.
 * Falls back to the legacy single-page behavior using documentStore if no pages provided.
 */
async function renderAllDiagramPages(
  ctx: PDFRenderContext,
  embedOptions: PDFDiagramEmbed,
  canvasPages?: PDFCanvasPage[],
  themeBackground?: string
): Promise<void> {
  if (canvasPages && canvasPages.length > 0) {
    for (let i = 0; i < canvasPages.length; i++) {
      const page = canvasPages[i]!;
      if (page.shapeOrder.length === 0) continue;

      // Page break before each canvas page (except the first diagram page)
      if (i > 0) {
        ctx.doc.addPage();
        ctx.pageNumber++;
        ctx.y = ctx.marginTop;
      }

      // Render page title if multiple canvas pages
      if (canvasPages.length > 1) {
        ctx.doc.setFont(PDF_FONT_SANS, 'bold');
        ctx.doc.setFontSize(14);
        const titleLines = ctx.doc.splitTextToSize(page.name, ctx.contentWidth);
        ctx.doc.text(titleLines, ctx.marginLeft, ctx.y);
        ctx.y += titleLines.length * (14 * 0.352778 * PDF_STYLE.lineHeight) + 4;
      }

      await renderDiagramPageToPdf(ctx, embedOptions, page.shapes, page.shapeOrder, themeBackground);
    }
  } else {
    // Legacy: single page from documentStore
    await renderDiagramToPdf(ctx, embedOptions, themeBackground);
  }
}

/**
 * Render a single canvas page's shapes as a diagram image in the PDF.
 */
async function renderDiagramPageToPdf(
  ctx: PDFRenderContext,
  embedOptions: PDFDiagramEmbed,
  shapes: Record<string, Shape>,
  shapeOrder: string[],
  themeBackground?: string
): Promise<void> {
  try {
    if (shapeOrder.length === 0) {
      return;
    }

    const exportData: ExportData = {
      shapes,
      shapeOrder,
      selectedIds: [],
    };

    const backgroundColor = embedOptions.useThemeBackground && themeBackground
      ? themeBackground
      : '#ffffff';

    const pngBlob = await exportToPng(exportData, {
      format: 'png',
      scope: 'all',
      scale: embedOptions.scale,
      background: backgroundColor,
      padding: 20,
      filename: 'diagram',
    });

    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(pngBlob);
    });

    const dimensions = await getImageDimensions(dataUrl);

    const maxWidth = ctx.contentWidth;
    const footerSpace = ctx.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
    const maxHeight = ctx.pageHeight - ctx.marginTop - ctx.marginBottom - footerSpace - 20;

    const scaled = calculateScaledDimensions(
      dimensions.width,
      dimensions.height,
      maxWidth,
      maxHeight
    );

    checkPageBreak(ctx, scaled.height + 10);

    const x = ctx.marginLeft + (ctx.contentWidth - scaled.width) / 2;
    ctx.doc.addImage(dataUrl, 'PNG', x, ctx.y, scaled.width, scaled.height);
    ctx.y += scaled.height + 10;

  } catch (error) {
    console.error('[PDF Export] Failed to embed diagram page:', error);
  }
}

/**
 * Render the diagram to PDF (legacy single-page path using documentStore).
 */
async function renderDiagramToPdf(
  ctx: PDFRenderContext,
  embedOptions: PDFDiagramEmbed,
  themeBackground?: string
): Promise<void> {
  try {
    // Get shapes from documentStore
    const { shapes, shapeOrder } = useDocumentStore.getState();

    // Check if there are any shapes to export
    if (shapeOrder.length === 0) {
      return;
    }

    // Prepare export data
    const exportData: ExportData = {
      shapes,
      shapeOrder,
      selectedIds: [], // Export all shapes
    };

    // Determine background color
    const backgroundColor = embedOptions.useThemeBackground && themeBackground
      ? themeBackground
      : '#ffffff';

    // Export diagram as PNG
    const pngBlob = await exportToPng(exportData, {
      format: 'png',
      scope: 'all',
      scale: embedOptions.scale,
      background: backgroundColor,
      padding: 20,
      filename: 'diagram',
    });

    // Convert blob to data URL
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(pngBlob);
    });

    // Get image dimensions
    const dimensions = await getImageDimensions(dataUrl);

    // Calculate scaled dimensions to fit on page
    const maxWidth = ctx.contentWidth;
    const footerSpace = ctx.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
    const maxHeight = ctx.pageHeight - ctx.marginTop - ctx.marginBottom - footerSpace - 20;

    const scaled = calculateScaledDimensions(
      dimensions.width,
      dimensions.height,
      maxWidth,
      maxHeight
    );

    // Check if we need a page break
    checkPageBreak(ctx, scaled.height + 10);

    // Center the diagram
    const x = ctx.marginLeft + (ctx.contentWidth - scaled.width) / 2;

    // Add image to PDF
    ctx.doc.addImage(dataUrl, 'PNG', x, ctx.y, scaled.width, scaled.height);
    ctx.y += scaled.height + 10;

  } catch (error) {
    console.error('[PDF Export] Failed to embed diagram:', error);
  }
}

/**
 * Render a Tiptap node to PDF via the node renderer registry.
 */
async function renderNode(
  ctx: PDFRenderContext,
  node: JSONContent,
  listLevel: number,
  listCounter?: { value: number }
): Promise<void> {
  await pdfNodeRenderers.render(ctx, node, listLevel, listCounter);
}

/**
 * Render a heading node with inline formatting and alignment.
 */
function renderHeading(ctx: PDFRenderContext, node: JSONContent): void {
  const level = (node.attrs?.['level'] as number | undefined) || 1;
  const fontSize = PDF_STYLE.headingSizes[level] || 12;
  const textAlign = (node.attrs?.['textAlign'] as string | undefined) || 'left';

  checkPageBreak(ctx, fontSize * PDF_STYLE.lineHeight);

  // Headings default to bold, but inline marks can override
  const segments = extractSegments(node);
  renderSegmentedText(ctx, segments, fontSize, 'bold', ctx.marginLeft, ctx.contentWidth, textAlign);

  ctx.y += 4;
}

/**
 * Render a paragraph node with inline formatting and alignment.
 */
function renderParagraph(ctx: PDFRenderContext, node: JSONContent, indent: number): void {
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
async function renderBulletList(
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
async function renderOrderedList(
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
async function renderListItem(
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
function renderCodeBlock(ctx: PDFRenderContext, node: JSONContent): void {
  const text = extractText(node);
  const fontSize = 10;

  ctx.doc.setFont(PDF_FONT_MONO, 'normal');
  ctx.doc.setFontSize(fontSize);

  const lines = ctx.doc.splitTextToSize(text, ctx.contentWidth - PDF_STYLE.codeBlockPadding * 2);
  const blockHeight = lines.length * (fontSize * 0.352778 * PDF_STYLE.lineHeight) + PDF_STYLE.codeBlockPadding * 2;

  checkPageBreak(ctx, blockHeight);

  // Draw background
  ctx.doc.setFillColor(PDF_STYLE.codeBlockBg);
  ctx.doc.rect(
    ctx.marginLeft,
    ctx.y - 3,
    ctx.contentWidth,
    blockHeight,
    'F'
  );

  // Draw text
  ctx.doc.setTextColor(0, 0, 0);
  ctx.doc.text(lines, ctx.marginLeft + PDF_STYLE.codeBlockPadding, ctx.y + PDF_STYLE.codeBlockPadding);

  ctx.y += blockHeight + 4;

  // Reset font
  ctx.doc.setFont(PDF_FONT_SANS, 'normal');
}

/**
 * Render a blockquote.
 */
async function renderBlockquote(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
  if (!node.content) return;

  const startY = ctx.y;

  // Render content with indent
  ctx.doc.setFont(PDF_FONT_SANS, 'italic');

  for (const child of node.content) {
    await renderNode(ctx, child, 1);
  }

  // Draw left border
  ctx.doc.setDrawColor(150, 150, 150);
  ctx.doc.setLineWidth(1);
  ctx.doc.line(ctx.marginLeft + 2, startY - 2, ctx.marginLeft + 2, ctx.y - 2);

  ctx.doc.setFont(PDF_FONT_SANS, 'normal');
  ctx.y += 2;
}

/**
 * Render an image.
 */
async function renderImage(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
  const src = node.attrs?.['src'] as string | undefined;
  if (!src) return;

  let dataUrl: string | undefined;

  if (src.startsWith('blob://')) {
    const blobId = src.slice(7);
    dataUrl = ctx.images.get(blobId);
  } else if (src.startsWith('data:')) {
    dataUrl = src;
  }

  if (!dataUrl) {
    return;
  }

  try {
    // Convert SVG to PNG if needed
    let imageDataUrl = dataUrl;
    if (isSvgDataUrl(dataUrl)) {
      imageDataUrl = await convertSvgToPng(dataUrl);
    }

    // Get actual image dimensions from the data URL
    const dimensions = await getImageDimensions(imageDataUrl);

    // Use explicit width/height from ResizableImage attrs if available
    const attrWidth = node.attrs?.['width'] as number | null | undefined;
    const attrHeight = node.attrs?.['height'] as number | null | undefined;
    const sourceWidth = attrWidth || dimensions.width;
    const sourceHeight = attrHeight || dimensions.height;

    // Calculate max dimensions for the content area
    const maxWidth = ctx.contentWidth * 0.9;
    const footerSpace = ctx.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
    const maxHeight = ctx.pageHeight - ctx.marginTop - ctx.marginBottom - footerSpace - 10;

    // Calculate scaled dimensions preserving aspect ratio
    const scaled = calculateScaledDimensions(
      sourceWidth,
      sourceHeight,
      maxWidth,
      maxHeight
    );

    checkPageBreak(ctx, scaled.height + 4);

    // Center the image
    const x = ctx.marginLeft + (ctx.contentWidth - scaled.width) / 2;

    const format = getImageFormat(imageDataUrl);
    ctx.doc.addImage(imageDataUrl, format, x, ctx.y, scaled.width, scaled.height);
    ctx.y += scaled.height + 6;
  } catch (error) {
    console.error('Failed to add image to PDF:', error);
  }
}

/**
 * Get all shape IDs within a group (recursive for nested groups).
 */
function getGroupShapeIds(groupId: string, shapes: Record<string, unknown>): string[] {
  const group = shapes[groupId] as GroupShape | undefined;
  if (!group || !isGroup(group)) return [];

  const ids: string[] = [];
  for (const childId of group.childIds) {
    ids.push(childId);
    const child = shapes[childId];
    if (child && isGroup(child as GroupShape)) {
      ids.push(...getGroupShapeIds(childId, shapes));
    }
  }
  return ids;
}

/**
 * Render an embedded group node to PDF.
 */
async function renderEmbeddedGroup(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
  const groupId = node.attrs?.['groupId'] as string | undefined;
  if (!groupId) {
    console.warn('[PDF Export] Embedded group node has no groupId');
    return;
  }

  try {
    // Get shapes from documentStore
    const { shapes, shapeOrder } = useDocumentStore.getState();

    const group = shapes[groupId];
    if (!group || !isGroup(group)) {
      console.warn('[PDF Export] Group not found:', groupId);
      return;
    }

    // Get all shapes within this group (including nested)
    const groupShapeIds = new Set([groupId, ...getGroupShapeIds(groupId, shapes)]);

    // Filter shapes to only include those in this group
    const groupShapes: Record<string, Shape> = {};
    for (const id of groupShapeIds) {
      if (shapes[id]) {
        groupShapes[id] = shapes[id];
      }
    }

    // Order shapes according to shapeOrder (maintain z-order)
    const groupShapeOrder = shapeOrder.filter((id) => groupShapeIds.has(id));

    const exportData: ExportData = {
      shapes: groupShapes,
      shapeOrder: groupShapeOrder,
      selectedIds: [groupId],
    };

    // Export as PNG at 2x scale for quality
    // Use larger padding to accommodate group labels that may be outside bounds
    const pngBlob = await exportToPng(exportData, {
      format: 'png',
      scope: 'selection',
      scale: 2,
      background: '#ffffff',
      padding: 40,
      filename: 'group',
    });

    // Convert blob to data URL
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(pngBlob);
    });

    // Get image dimensions
    const dimensions = await getImageDimensions(dataUrl);

    // Calculate scaled dimensions to fit on page
    const maxWidth = ctx.contentWidth;
    const footerSpace = ctx.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
    const maxHeight = ctx.pageHeight - ctx.marginTop - ctx.marginBottom - footerSpace - 20;

    const scaled = calculateScaledDimensions(
      dimensions.width,
      dimensions.height,
      maxWidth,
      maxHeight
    );

    // Check if we need a page break
    checkPageBreak(ctx, scaled.height + 10);

    // Center the image
    const x = ctx.marginLeft + (ctx.contentWidth - scaled.width) / 2;

    // Add image to PDF
    ctx.doc.addImage(dataUrl, 'PNG', x, ctx.y, scaled.width, scaled.height);
    ctx.y += scaled.height + 8;

  } catch (error) {
    console.error('[PDF Export] Failed to render embedded group:', error);
  }
}

/**
 * Render a horizontal rule.
 */
function renderHorizontalRule(ctx: PDFRenderContext): void {
  checkPageBreak(ctx, 10);

  ctx.y += 4;
  ctx.doc.setDrawColor(200, 200, 200);
  ctx.doc.setLineWidth(0.5);
  ctx.doc.line(ctx.marginLeft, ctx.y, ctx.marginLeft + ctx.contentWidth, ctx.y);
  ctx.y += 6;
}

// ─── Inline Text Segment System ───────────────────────────────────────────────

/**
 * Extract styled text segments from a node's content.
 * Walks inline children and collects marks (bold, italic, color, etc).
 */
function extractSegments(node: JSONContent): TextSegment[] {
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

      segments.push(seg);
    } else if (child.type === 'hardBreak') {
      segments.push({
        text: '\n',
        bold: false, italic: false, underline: false, strike: false, code: false,
        color: null, highlight: null, fontSizeScale: 1, yOffset: 0,
      });
    }
    // Skip non-text inline nodes (mathInline handled separately at block level)
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

  // Named CSS colors (most commonly used in editors)
  const NAMED_COLORS: Record<string, [number, number, number]> = {
    black: [0, 0, 0], white: [255, 255, 255],
    red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255],
    yellow: [255, 255, 0], cyan: [0, 255, 255], magenta: [255, 0, 255],
    orange: [255, 165, 0], purple: [128, 0, 128], pink: [255, 192, 203],
    gray: [128, 128, 128], grey: [128, 128, 128],
    darkred: [139, 0, 0], darkgreen: [0, 100, 0], darkblue: [0, 0, 139],
    lightgray: [211, 211, 211], lightgrey: [211, 211, 211],
    brown: [165, 42, 42], navy: [0, 0, 128], teal: [0, 128, 128],
    maroon: [128, 0, 0], olive: [128, 128, 0], coral: [255, 127, 80],
    salmon: [250, 128, 114], tomato: [255, 99, 71],
    indianred: [205, 92, 92], crimson: [220, 20, 60],
  };
  const named = NAMED_COLORS[trimmed.toLowerCase()];
  if (named) return named;

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
function renderSegmentedText(
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

// ─── Task List Rendering ─────────────────────────────────────────────────────

/**
 * Render a task list (checkable items).
 */
async function renderTaskList(
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
async function renderTaskItem(
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

// ─── Table Rendering ─────────────────────────────────────────────────────────

/**
 * Table layout including per-column widths, per-row heights, and a grid model
 * that tracks which cells are occupied by colspan/rowspan merges.
 */
interface TableLayout {
  /** Number of logical columns */
  numCols: number;
  /** Width of each logical column (mm) */
  colWidths: number[];
  /** Height of each row (mm) */
  rowHeights: number[];
  totalWidth: number;
  totalHeight: number;
  /**
   * Grid model: `grid[row][col]` holds the cell that occupies that position.
   * A merged cell (colspan > 1 or rowspan > 1) writes itself into every
   * grid position it spans. Renderers draw only the "origin" position
   * (where row === originRow && col === originCol).
   */
  grid: TableGridCell[][];
}

interface TableGridCell {
  /** The Tiptap JSON node for this cell */
  node: JSONContent;
  /** Grid row of the cell's top-left corner */
  originRow: number;
  /** Grid column of the cell's top-left corner */
  originCol: number;
  /** How many columns this cell spans */
  colspan: number;
  /** How many rows this cell spans */
  rowspan: number;
  /** Whether this is a header cell */
  isHeader: boolean;
}

/**
 * Compute table layout with colspan/rowspan support.
 *
 * 1. Determine the logical column count by scanning all rows.
 * 2. Build a grid model that tracks which cell occupies each (row, col) position.
 * 3. Compute column widths (equal distribution or from colwidth attrs).
 * 4. Compute row heights by measuring text in each cell's actual spanned width.
 */
function computeTableLayout(ctx: PDFRenderContext, node: JSONContent): TableLayout {
  const rows = node.content || [];
  if (rows.length === 0) {
    return { numCols: 0, colWidths: [], rowHeights: [], totalWidth: 0, totalHeight: 0, grid: [] };
  }

  // First pass: determine logical column count.
  // The logical column count is the sum of colspans in the first row,
  // accounting for cells that rowspan into this row from above.
  // A simpler heuristic: scan all rows and take the max logical width.
  let numCols = 0;
  for (const row of rows) {
    let rowLogicalCols = 0;
    if (row.content) {
      for (const cell of row.content) {
        const cs = (cell.attrs?.['colspan'] as number | undefined) || 1;
        rowLogicalCols += cs;
      }
    }
    numCols = Math.max(numCols, rowLogicalCols);
  }
  if (numCols === 0) {
    return { numCols: 0, colWidths: [], rowHeights: [], totalWidth: 0, totalHeight: 0, grid: [] };
  }

  // Build the grid model
  const numRows = rows.length;
  const grid: (TableGridCell | null)[][] = Array.from({ length: numRows }, () =>
    Array(numCols).fill(null) as (TableGridCell | null)[]
  );

  for (let ri = 0; ri < numRows; ri++) {
    const cells = rows[ri]!.content || [];
    let ci = 0; // logical column pointer
    for (const cell of cells) {
      // Advance past positions already occupied by a rowspan from a previous row
      while (ci < numCols && grid[ri]![ci] !== null) ci++;
      if (ci >= numCols) break;

      const colspan = (cell.attrs?.['colspan'] as number | undefined) || 1;
      const rowspan = (cell.attrs?.['rowspan'] as number | undefined) || 1;
      const isHeader = cell.type === 'tableHeader';

      const gridCell: TableGridCell = {
        node: cell,
        originRow: ri,
        originCol: ci,
        colspan,
        rowspan,
        isHeader,
      };

      // Fill every grid position this cell occupies
      for (let dr = 0; dr < rowspan && ri + dr < numRows; dr++) {
        for (let dc = 0; dc < colspan && ci + dc < numCols; dc++) {
          grid[ri + dr]![ci + dc] = gridCell;
        }
      }

      ci += colspan;
    }
  }

  // Compute column widths (equal distribution)
  const totalWidth = ctx.contentWidth;
  const colWidth = totalWidth / numCols;
  const colWidths = Array(numCols).fill(colWidth) as number[];

  // Compute row heights by measuring cell content
  const fontSize = PDF_STYLE.bodyFontSize - 1;
  const lineH = fontSize * 0.352778 * PDF_STYLE.lineHeight;
  const rowHeights: number[] = Array(numRows).fill(lineH + PDF_STYLE.tableCellPadding * 2) as number[];

  for (let ri = 0; ri < numRows; ri++) {
    for (let ci = 0; ci < numCols; ci++) {
      const gc = grid[ri]![ci];
      if (!gc || gc.originRow !== ri || gc.originCol !== ci) continue; // skip spanned positions

      // Cell content width = sum of spanned columns minus padding
      let cellTotalWidth = 0;
      for (let dc = 0; dc < gc.colspan && ci + dc < numCols; dc++) {
        cellTotalWidth += colWidths[ci + dc]!;
      }
      const cellContentWidth = cellTotalWidth - PDF_STYLE.tableCellPadding * 2;

      const text = extractText(gc.node);
      ctx.doc.setFontSize(fontSize);
      ctx.doc.setFont(PDF_FONT_SANS, gc.isHeader ? 'bold' : 'normal');
      const wrappedLines = ctx.doc.splitTextToSize(text, Math.max(cellContentWidth, 5));
      const neededHeight = wrappedLines.length * lineH + PDF_STYLE.tableCellPadding * 2;

      if (gc.rowspan === 1) {
        // Single-row cell: just take the max
        rowHeights[ri] = Math.max(rowHeights[ri]!, neededHeight);
      } else {
        // Multi-row cell: distribute height evenly across spanned rows,
        // but only if existing rows don't already provide enough space
        const existingHeight = rowHeights.slice(ri, ri + gc.rowspan).reduce((a, b) => a + b, 0);
        if (neededHeight > existingHeight) {
          const extra = (neededHeight - existingHeight) / gc.rowspan;
          for (let dr = 0; dr < gc.rowspan && ri + dr < numRows; dr++) {
            rowHeights[ri + dr] = rowHeights[ri + dr]! + extra;
          }
        }
      }
    }
  }

  const totalHeight = rowHeights.reduce((s, h) => s + h, 0);

  // Cast grid to non-null (unfilled positions default to null but shouldn't be rendered)
  return {
    numCols,
    colWidths,
    rowHeights,
    totalWidth,
    totalHeight,
    grid: grid as TableGridCell[][],
  };
}

/**
 * Render a table node to PDF with borders, headers, cell backgrounds,
 * and colspan/rowspan merged cell support.
 */
async function renderTable(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
  const rows = node.content || [];
  if (rows.length === 0) return;

  const layout = computeTableLayout(ctx, node);
  if (layout.numCols === 0) return;

  const fontSize = PDF_STYLE.bodyFontSize - 1;

  // Check if entire table fits, otherwise start on new page
  checkPageBreak(ctx, Math.min(layout.totalHeight, layout.rowHeights[0]! + 10));

  // Track the Y position where each row starts (may shift on page breaks)
  const rowYPositions: number[] = [];

  for (let ri = 0; ri < rows.length; ri++) {
    const rowHeight = layout.rowHeights[ri]!;

    checkPageBreak(ctx, rowHeight);
    rowYPositions[ri] = ctx.y;

    // Draw cells in this row (only origin cells — skip spanned positions)
    for (let ci = 0; ci < layout.numCols; ci++) {
      const gc = layout.grid[ri]?.[ci];
      if (!gc || gc.originRow !== ri || gc.originCol !== ci) continue;

      // Compute cell position and dimensions
      let cellX = ctx.marginLeft;
      for (let c = 0; c < ci; c++) cellX += layout.colWidths[c]!;

      let cellWidth = 0;
      for (let dc = 0; dc < gc.colspan && ci + dc < layout.numCols; dc++) {
        cellWidth += layout.colWidths[ci + dc]!;
      }

      let cellHeight = 0;
      for (let dr = 0; dr < gc.rowspan && ri + dr < rows.length; dr++) {
        cellHeight += layout.rowHeights[ri + dr]!;
      }

      const cellTop = ctx.y - 3;

      // Cell background
      const bgColor = gc.node.attrs?.['backgroundColor'] as string | null | undefined;
      if (bgColor) {
        const rgb = parseColor(bgColor);
        if (rgb) {
          ctx.doc.setFillColor(rgb[0], rgb[1], rgb[2]);
          ctx.doc.rect(cellX, cellTop, cellWidth, cellHeight, 'F');
        }
      } else if (gc.isHeader) {
        ctx.doc.setFillColor(PDF_STYLE.tableHeaderBg);
        ctx.doc.rect(cellX, cellTop, cellWidth, cellHeight, 'F');
      }

      // Cell border
      ctx.doc.setDrawColor(PDF_STYLE.tableBorderColor);
      ctx.doc.setLineWidth(0.2);
      ctx.doc.rect(cellX, cellTop, cellWidth, cellHeight, 'S');

      // Cell text
      const textX = cellX + PDF_STYLE.tableCellPadding;
      const textY = ctx.y + PDF_STYLE.tableCellPadding - 1;
      const cellContentWidth = cellWidth - PDF_STYLE.tableCellPadding * 2;

      const segments = extractSegmentsDeep(gc.node);
      const plainText = segments.map((s) => s.text).join('');

      if (plainText.trim()) {
        const cellFontStyle = gc.isHeader ? 'bold' : 'normal';
        const savedY = ctx.y;
        ctx.y = textY;
        renderSegmentedText(ctx, segments, fontSize, cellFontStyle, textX, cellContentWidth, 'left');
        ctx.y = savedY;
      }
    }

    ctx.y += rowHeight;
  }

  // Reset
  ctx.doc.setFont(PDF_FONT_SANS, 'normal');
  ctx.doc.setFontSize(PDF_STYLE.bodyFontSize);
  ctx.doc.setTextColor(0, 0, 0);
  ctx.y += 4;
}

/**
 * Extract segments from a node recursively (for table cells which contain
 * paragraphs wrapping the text nodes).
 */
function extractSegmentsDeep(node: JSONContent): TextSegment[] {
  if (node.type === 'text') {
    return extractSegments({ type: 'paragraph', content: [node] });
  }

  // If this node has inline text children directly, extract them
  if (node.content && node.content.some((c) => c.type === 'text')) {
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

// ─── Math/LaTeX Rendering ────────────────────────────────────────────────────

/**
 * Render an inline math node (renders LaTeX formula as text fallback).
 * KaTeX → SVG → canvas → PNG would be ideal but requires DOM access;
 * we render the formula as styled monospace text in the PDF.
 */
async function renderMathInline(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
  const latex = (node.attrs?.['latex'] as string | undefined) || '';
  if (!latex) return;

  // Try rendering via KaTeX → SVG → PNG
  const dataUrl = await renderLatexToImage(latex, false);
  if (dataUrl) {
    await renderMathImage(ctx, dataUrl, false);
    return;
  }

  // Fallback: render as styled monospace text
  ctx.doc.setFont(PDF_FONT_MONO, 'italic');
  ctx.doc.setFontSize(PDF_STYLE.bodyFontSize);
  ctx.doc.setTextColor(100, 0, 100);
  ctx.doc.text(latex, ctx.marginLeft, ctx.y);
  const lineH = PDF_STYLE.bodyFontSize * 0.352778 * PDF_STYLE.lineHeight;
  ctx.y += lineH;
  ctx.doc.setFont(PDF_FONT_SANS, 'normal');
  ctx.doc.setTextColor(0, 0, 0);
}

/**
 * Render a block math node (display-mode LaTeX equation).
 */
async function renderMathBlock(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
  const latex = (node.attrs?.['latex'] as string | undefined) || '';
  if (!latex) return;

  const dataUrl = await renderLatexToImage(latex, true);
  if (dataUrl) {
    await renderMathImage(ctx, dataUrl, true);
    return;
  }

  // Fallback: render as styled monospace block
  checkPageBreak(ctx, PDF_STYLE.bodyFontSize * 0.352778 * PDF_STYLE.lineHeight + 8);
  ctx.y += 4;
  ctx.doc.setFont(PDF_FONT_MONO, 'italic');
  ctx.doc.setFontSize(PDF_STYLE.bodyFontSize);
  ctx.doc.setTextColor(100, 0, 100);
  const lines = ctx.doc.splitTextToSize(latex, ctx.contentWidth - 20);
  const centerX = ctx.marginLeft + ctx.contentWidth / 2;
  ctx.doc.text(lines, centerX, ctx.y, { align: 'center' });
  const lineH = PDF_STYLE.bodyFontSize * 0.352778 * PDF_STYLE.lineHeight;
  ctx.y += lines.length * lineH + 4;
  ctx.doc.setFont(PDF_FONT_SANS, 'normal');
  ctx.doc.setTextColor(0, 0, 0);
}

/**
 * Render a LaTeX formula to a PNG data URL via KaTeX → SVG → canvas.
 * Returns null if KaTeX is not available or rendering fails.
 */
async function renderLatexToImage(latex: string, displayMode: boolean): Promise<string | null> {
  try {
    // Dynamically import KaTeX (it's already bundled for the editor)
    const katex = await import('katex');
    const html = katex.default.renderToString(latex, {
      displayMode,
      throwOnError: false,
    });

    // Create an offscreen container and render the KaTeX HTML
    const container = document.createElement('div');
    container.style.position = 'absolute';
    container.style.left = '-9999px';
    container.style.top = '0';
    container.style.fontSize = displayMode ? PDF_STYLE.mathBlockFontSize : PDF_STYLE.mathInlineFontSize;
    container.style.color = '#000000';
    container.style.background = 'transparent';
    container.innerHTML = html;
    document.body.appendChild(container);

    // Use html2canvas-like approach: render to SVG foreignObject → canvas
    const width = container.offsetWidth + 8;
    const height = container.offsetHeight + 4;
    document.body.removeChild(container);

    // Build an SVG with foreignObject containing the KaTeX output
    const svgNS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(svgNS, 'svg');
    svg.setAttribute('width', String(width * 2));
    svg.setAttribute('height', String(height * 2));
    svg.setAttribute('viewBox', `0 0 ${width} ${height}`);

    const fo = document.createElementNS(svgNS, 'foreignObject');
    fo.setAttribute('width', String(width));
    fo.setAttribute('height', String(height));

    const body = document.createElement('div');
    body.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
    body.style.fontSize = displayMode ? PDF_STYLE.mathBlockFontSize : PDF_STYLE.mathInlineFontSize;
    body.style.color = '#000000';
    body.style.fontFamily = 'KaTeX_Main, serif';
    body.innerHTML = html;
    fo.appendChild(body);
    svg.appendChild(fo);

    // Inline the KaTeX CSS for the SVG
    const katexStyles = document.querySelectorAll('style, link[rel="stylesheet"]');
    let cssText = '';
    for (const el of Array.from(katexStyles)) {
      if (el instanceof HTMLStyleElement) {
        cssText += el.textContent || '';
      }
    }
    if (cssText) {
      const style = document.createElementNS(svgNS, 'style');
      style.textContent = cssText;
      svg.insertBefore(style, svg.firstChild);
    }

    const svgData = new XMLSerializer().serializeToString(svg);
    const svgDataUrl = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svgData);

    // Render SVG → canvas → PNG
    const pngDataUrl = await convertSvgToPng(svgDataUrl, 2);
    return pngDataUrl;
  } catch (error) {
    console.warn('[PDF Export] LaTeX rendering failed, using fallback:', error);
    return null;
  }
}

/**
 * Render a math formula image (from KaTeX) into the PDF.
 */
async function renderMathImage(ctx: PDFRenderContext, dataUrl: string, isBlock: boolean): Promise<void> {
  try {
    const dimensions = await getImageDimensions(dataUrl);
    const maxWidth = isBlock ? ctx.contentWidth * 0.8 : ctx.contentWidth * 0.3;
    const maxHeight = isBlock ? PDF_STYLE.mathBlockMaxHeight : PDF_STYLE.mathInlineMaxHeight;

    const scaled = calculateScaledDimensions(dimensions.width, dimensions.height, maxWidth, maxHeight);

    if (isBlock) {
      checkPageBreak(ctx, scaled.height + 8);
      ctx.y += 2;
      const x = ctx.marginLeft + (ctx.contentWidth - scaled.width) / 2;
      ctx.doc.addImage(dataUrl, 'PNG', x, ctx.y, scaled.width, scaled.height);
      ctx.y += scaled.height + 4;
    } else {
      // Inline: just place at current position (simplified — true inline would need cursor tracking)
      checkPageBreak(ctx, scaled.height + 2);
      ctx.doc.addImage(dataUrl, 'PNG', ctx.marginLeft, ctx.y - scaled.height * 0.7, scaled.width, scaled.height);
      ctx.y += scaled.height * 0.3 + 2;
    }
  } catch (error) {
    console.warn('[PDF Export] Failed to render math image:', error);
  }
}

// ─── Existing Utilities ──────────────────────────────────────────────────────

/**
 * Extract plain text from a node (recursive).
 */
function extractText(node: JSONContent): string {
  if (node.type === 'text') {
    return node.text || '';
  }

  if (!node.content) {
    return '';
  }

  return node.content.map((child) => extractText(child)).join('');
}

/**
 * Check if we need a page break, and add one if necessary.
 * Accounts for footer space when page numbers are enabled.
 */
function checkPageBreak(ctx: PDFRenderContext, requiredHeight: number): void {
  // Reserve extra space for page numbers if enabled
  const footerSpace = ctx.showPageNumbers ? PDF_STYLE.pageNumberFooterHeight : 0;
  const availableHeight = ctx.pageHeight - ctx.marginBottom - footerSpace - ctx.y;

  if (requiredHeight > availableHeight) {
    ctx.doc.addPage();
    ctx.pageNumber++;
    ctx.y = ctx.marginTop;
  }
}

/**
 * Add page numbers to all pages.
 */
function addPageNumbers(ctx: PDFRenderContext, hasCoverPage: boolean): void {
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

// ─── Node Renderer Registrations ─────────────────────────────────────────────
//
// Every Tiptap node type that the PDF exporter supports is registered here.
// To add PDF support for a new Tiptap extension, add a single
// `pdfNodeRenderers.register(...)` call — no switch/case to modify.

pdfNodeRenderers.register('heading', (ctx, node) => {
  renderHeading(ctx, node);
});
pdfNodeRenderers.register('paragraph', (ctx, node, listLevel) => {
  renderParagraph(ctx, node, listLevel);
});
pdfNodeRenderers.register('bulletList', (ctx, node, listLevel) =>
  renderBulletList(ctx, node, listLevel)
);
pdfNodeRenderers.register('orderedList', (ctx, node, listLevel) =>
  renderOrderedList(ctx, node, listLevel)
);
pdfNodeRenderers.register('listItem', (ctx, node, listLevel, listCounter) =>
  renderListItem(ctx, node, listLevel, listCounter)
);
pdfNodeRenderers.register('codeBlock', (ctx, node) => {
  renderCodeBlock(ctx, node);
});
pdfNodeRenderers.register('blockquote', (ctx, node) =>
  renderBlockquote(ctx, node)
);
pdfNodeRenderers.register('image', (ctx, node) =>
  renderImage(ctx, node)
);
pdfNodeRenderers.register('horizontalRule', (ctx) => {
  renderHorizontalRule(ctx);
});
pdfNodeRenderers.register('embeddedGroup', (ctx, node) =>
  renderEmbeddedGroup(ctx, node)
);
pdfNodeRenderers.register('taskList', (ctx, node, listLevel) =>
  renderTaskList(ctx, node, listLevel)
);
pdfNodeRenderers.register('taskItem', (ctx, node, listLevel) =>
  renderTaskItem(ctx, node, listLevel)
);
pdfNodeRenderers.register('table', (ctx, node) =>
  renderTable(ctx, node)
);
// tableRow/Cell/Header are handled internally by renderTable — no-ops prevent warnings
pdfNodeRenderers.register('tableRow', () => {});
pdfNodeRenderers.register('tableCell', () => {});
pdfNodeRenderers.register('tableHeader', () => {});
pdfNodeRenderers.register('mathInline', (ctx, node) =>
  renderMathInline(ctx, node)
);
pdfNodeRenderers.register('mathBlock', (ctx, node) =>
  renderMathBlock(ctx, node)
);
// hardBreak is handled inline by extractSegments
pdfNodeRenderers.register('hardBreak', () => {});

/**
 * Log warnings for any Tiptap extension node types that don't have
 * a registered PDF renderer. Call this at export time to surface gaps.
 *
 * @param extensionNames - Node type names from the Tiptap extensions array
 */
export function warnUnhandledNodes(extensionNames: string[]): void {
  const registered = new Set(pdfNodeRenderers.getRegisteredTypes());
  // These meta-types are always handled implicitly
  registered.add('doc');
  registered.add('text');

  const missing = extensionNames.filter((name) => !registered.has(name));
  if (missing.length > 0) {
    console.warn(
      `[PDF Export] The following Tiptap node types have no PDF renderer registered: ${missing.join(', ')}. ` +
      'Content of these types will fall through to child rendering.'
    );
  }
}