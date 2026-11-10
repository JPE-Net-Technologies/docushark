/**
 * Renderers for images, figures and galleries in PDF export.
 */

import type { JSONContent } from '@tiptap/core';
import { PDF_FONT_SANS } from './fonts';
import { checkPageBreak, type PDFRenderContext } from './context';
import {
  calculateScaledDimensions,
  convertSvgToPng,
  getImageDimensions,
  getImageFormat,
  isSvgDataUrl,
  loadPdfImage,
} from './images';
import { PDF_STYLE } from './style';
import { extractText, renderCenteredText } from './text';

/**
 * Render an image.
 */
export async function renderImage(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
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
    ctx.doc.addImage({
      imageData: imageDataUrl,
      format,
      x,
      y: ctx.y,
      width: scaled.width,
      height: scaled.height,
      compression: ctx.imageCompression,
    });
    ctx.y += scaled.height + 6;
  } catch (error) {
    console.error('Failed to add image to PDF:', error);
  }
}

/** Figure — the image, then a centered caption. */
export async function renderFigure(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
  if (!node.content) return;
  const imageNode = node.content.find((c) => c.type === 'image');
  const captionNode = node.content.find((c) => c.type === 'figcaption');
  if (imageNode) await renderImage(ctx, imageNode);
  const caption = captionNode ? extractText(captionNode).trim() : '';
  if (caption) {
    ctx.doc.setFont(PDF_FONT_SANS, 'italic');
    ctx.doc.setFontSize(9);
    ctx.doc.setTextColor(120, 120, 120);
    renderCenteredText(ctx, caption, 9);
    ctx.doc.setTextColor(0, 0, 0);
    ctx.doc.setFont(PDF_FONT_SANS, 'normal');
    ctx.y += 3;
  }
}

/** Gallery — images in a grid (the row layout is normalised to a grid for print). */
export async function renderGallery(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
  if (!node.content) return;
  const images = node.content.filter((c) => c.type === 'image' && c.attrs?.['src']);
  if (images.length === 0) return;

  const cols = images.length === 1 ? 1 : images.length <= 4 ? 2 : 3;
  const gap = 4;
  const cellW = (ctx.contentWidth - gap * (cols - 1)) / cols;

  for (let i = 0; i < images.length; i += cols) {
    const rowImages = images.slice(i, i + cols);
    const loaded = await Promise.all(
      rowImages.map((im) => loadPdfImage(ctx, im.attrs?.['src'] as string | undefined)),
    );
    const cellHeights = loaded.map((l) => (l ? (l.height * cellW) / l.width : 0));
    const rowH = Math.max(0, ...cellHeights);
    if (rowH === 0) continue;

    checkPageBreak(ctx, rowH + gap);
    let x = ctx.marginLeft;
    loaded.forEach((l, idx) => {
      if (l) {
        ctx.doc.addImage({
          imageData: l.dataUrl,
          format: getImageFormat(l.dataUrl),
          x,
          y: ctx.y,
          width: cellW,
          height: cellHeights[idx]!,
          compression: ctx.imageCompression,
        });
      }
      x += cellW + gap;
    });
    ctx.y += rowH + gap;
  }
  ctx.y += 2;
}
