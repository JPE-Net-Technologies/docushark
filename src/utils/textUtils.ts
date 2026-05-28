/**
 * Cache for rendered LaTeX images.
 * Maps latex string + fontSize to HTMLImageElement.
 */
const latexImageCache = new Map<string, HTMLImageElement>();

/**
 * Global render request callback.
 * Set by the Renderer to trigger re-renders when async LaTeX completes.
 */
let globalRenderCallback: (() => void) | null = null;

/**
 * Set the global render callback for async LaTeX rendering.
 * Called by the Renderer during initialization.
 */
export function setLatexRenderCallback(callback: () => void): void {
  globalRenderCallback = callback;
}

/**
 * Check if text should be rendered as LaTeX (starts with `=`).
 */
export function isLatexText(text: string): boolean {
  return text.startsWith('=') && text.length > 1;
}

/**
 * Extract LaTeX content from text (removes the leading `=`).
 */
export function extractLatex(text: string): string {
  return text.slice(1);
}

/**
 * Render LaTeX to an HTMLImageElement using KaTeX SVG output.
 * Returns a promise that resolves with the image.
 */
export async function renderLatexToImage(
  latex: string,
  fontSize: number,
  fillStyle: string
): Promise<HTMLImageElement> {
  const cacheKey = `${latex}|${fontSize}|${fillStyle}`;
  const cached = latexImageCache.get(cacheKey);
  if (cached) return cached;

  // Render to HTML with KaTeX (dynamically imported so the ~270 KB lib is a
  // separate chunk, fetched only the first time a LaTeX label is rendered).
  const { default: katex } = await import('katex');
  const html = katex.renderToString(latex, {
    displayMode: true,
    throwOnError: false,
    errorColor: '#cc0000',
    output: 'html',
  });

  // Create SVG from the HTML with foreignObject
  const svgNS = 'http://www.w3.org/2000/svg';
  const container = document.createElement('div');
  container.style.cssText = `
    position: absolute;
    visibility: hidden;
    font-size: ${fontSize}px;
    color: ${fillStyle};
  `;
  container.innerHTML = html;
  document.body.appendChild(container);

  // Get dimensions
  const rect = container.getBoundingClientRect();
  const width = Math.ceil(rect.width) + 4;
  const height = Math.ceil(rect.height) + 4;

  // Create SVG with foreignObject
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('width', String(width));
  svg.setAttribute('height', String(height));
  svg.setAttribute('xmlns', svgNS);

  const foreignObject = document.createElementNS(svgNS, 'foreignObject');
  foreignObject.setAttribute('width', '100%');
  foreignObject.setAttribute('height', '100%');

  const div = document.createElement('div');
  div.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  div.style.cssText = `font-size: ${fontSize}px; color: ${fillStyle}; display: flex; align-items: center; justify-content: center; width: 100%; height: 100%;`;
  div.innerHTML = html;
  foreignObject.appendChild(div);
  svg.appendChild(foreignObject);

  document.body.removeChild(container);

  // Convert SVG to data URL
  const svgString = new XMLSerializer().serializeToString(svg);
  const svgBlob = new Blob([svgString], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(svgBlob);

  // Load as image
  const img = new Image();
  await new Promise<void>((resolve, reject) => {
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve();
    };
    img.onerror = reject;
    img.src = url;
  });

  // Store dimensions on image for rendering
  (img as unknown as { latexWidth: number; latexHeight: number }).latexWidth = width;
  (img as unknown as { latexWidth: number; latexHeight: number }).latexHeight = height;

  latexImageCache.set(cacheKey, img);
  return img;
}

/**
 * Render LaTeX centered within a bounding box.
 * This is an async operation that triggers a re-render when complete.
 */
export function renderLatexText(
  ctx: CanvasRenderingContext2D,
  text: string,
  _maxWidth: number,
  _maxHeight: number,
  fontSize: number,
  _fontFamily: string,
  fillStyle: string,
  requestRender?: () => void
): void {
  const latex = extractLatex(text);
  const cacheKey = `${latex}|${fontSize}|${fillStyle}`;
  const cached = latexImageCache.get(cacheKey);

  if (cached) {
    // Draw cached image centered
    const imgData = cached as unknown as { latexWidth: number; latexHeight: number };
    const width = imgData.latexWidth ?? cached.width;
    const height = imgData.latexHeight ?? cached.height;
    ctx.drawImage(cached, -width / 2, -height / 2, width, height);
  } else {
    // Render async and request re-render when done
    renderLatexToImage(latex, fontSize, fillStyle).then(() => {
      // Use provided callback or fall back to global
      const callback = requestRender ?? globalRenderCallback;
      callback?.();
    });
    // Draw placeholder text while loading
    ctx.fillStyle = fillStyle;
    ctx.font = `${fontSize}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('Loading...', 0, 0);
  }
}

/**
 * Wrap text to fit within a given width.
 * Returns an array of lines.
 */
export function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  fontSize: number,
  fontFamily: string
): string[] {
  // Set up font for measurement
  ctx.font = `${fontSize}px ${fontFamily}`;

  const paragraphs = text.split('\n');
  const lines: string[] = [];

  for (const paragraph of paragraphs) {
    if (paragraph === '') {
      lines.push('');
      continue;
    }

    const words = paragraph.split(' ');
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const metrics = ctx.measureText(testLine);

      if (metrics.width > maxWidth && currentLine) {
        lines.push(currentLine);
        currentLine = word;
      } else {
        currentLine = testLine;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }
  }

  return lines.length > 0 ? lines : [''];
}

/**
 * Render wrapped text centered within a bounding box.
 * Supports LaTeX equations when text starts with `=`.
 * @param ctx - Canvas rendering context
 * @param text - Text to render
 * @param maxWidth - Maximum width for text wrapping
 * @param maxHeight - Maximum height for text (for vertical centering)
 * @param fontSize - Font size in pixels
 * @param fontFamily - Font family
 * @param fillStyle - Fill color for text
 * @param requestRender - Optional callback to trigger re-render (for async LaTeX)
 */
export function renderWrappedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  maxHeight: number,
  fontSize: number,
  fontFamily: string,
  fillStyle: string,
  requestRender?: () => void
): void {
  // Check for LaTeX text (starts with `=`)
  if (isLatexText(text)) {
    renderLatexText(ctx, text, maxWidth, maxHeight, fontSize, fontFamily, fillStyle, requestRender);
    return;
  }

  const lines = wrapText(ctx, text, maxWidth, fontSize, fontFamily);
  const lineHeight = fontSize * 1.2;
  const totalTextHeight = lines.length * lineHeight;

  // Calculate starting Y position to center text vertically
  const startY = -totalTextHeight / 2 + lineHeight / 2;

  ctx.fillStyle = fillStyle;
  ctx.font = `${fontSize}px ${fontFamily}`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // Only render lines that fit within maxHeight
  const maxLines = Math.floor(maxHeight / lineHeight);
  const linesToRender = lines.slice(0, maxLines);

  linesToRender.forEach((line, index) => {
    ctx.fillText(line, 0, startY + index * lineHeight);
  });
}
