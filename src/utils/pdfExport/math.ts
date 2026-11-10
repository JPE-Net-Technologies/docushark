/**
 * Math in PDF export: LaTeX rendered to images, inline and as blocks.
 */

import type { JSONContent } from '@tiptap/core';
import { PDF_FONT_SANS, PDF_FONT_MONO } from './fonts';
import { checkPageBreak, type PDFRenderContext } from './context';
import { calculateScaledDimensions, convertSvgToPng, getImageDimensions } from './images';
import { PDF_STYLE } from './style';

/**
 * Render an inline math node (renders LaTeX formula as text fallback).
 * KaTeX → SVG → canvas → PNG would be ideal but requires DOM access;
 * we render the formula as styled monospace text in the PDF.
 */
export async function renderMathInline(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
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
export async function renderMathBlock(ctx: PDFRenderContext, node: JSONContent): Promise<void> {
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
      ctx.doc.addImage({
        imageData: dataUrl,
        format: 'PNG',
        x,
        y: ctx.y,
        width: scaled.width,
        height: scaled.height,
        compression: ctx.imageCompression,
      });
      ctx.y += scaled.height + 4;
    } else {
      // Inline: just place at current position (simplified — true inline would need cursor tracking)
      checkPageBreak(ctx, scaled.height + 2);
      ctx.doc.addImage({
        imageData: dataUrl,
        format: 'PNG',
        x: ctx.marginLeft,
        y: ctx.y - scaled.height * 0.7,
        width: scaled.width,
        height: scaled.height,
        compression: ctx.imageCompression,
      });
      ctx.y += scaled.height * 0.3 + 2;
    }
  } catch (error) {
    console.warn('[PDF Export] Failed to render math image:', error);
  }
}
