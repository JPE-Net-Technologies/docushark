/**
 * Fonts on the canvas (DSK-246). Canvas text draws in the document font
 * unless its shape has one, and asks for the face as it draws: unlike text in
 * the page, the canvas doesn't load a font by itself. The Renderer redraws
 * when the face arrives (`onFontLoad`).
 */

import { currentDocumentFont } from './currentDocumentFont';
import { FOLLOW_DOCUMENT_FONT, resolveShapeFont } from './fontFamily';
import { requestFamily } from './fontLoader';

const MAX_CACHED = 256;
const resolved = new Map<string, string>();

/**
 * The CSS font-family list a shape's text draws with. `stored` is a text
 * shape's `fontFamily` or a shape's `labelFontFamily`; absent, or
 * `sans-serif`, follows the document font.
 */
export function canvasFont(stored?: unknown): string {
  const document = currentDocumentFont();
  let css: string;
  if (stored === undefined || stored === FOLLOW_DOCUMENT_FONT) {
    css = document;
  } else {
    const key = `${String(stored)}\u0000${document}`;
    css = resolved.get(key) ?? resolveShapeFont(stored, document);
    if (!resolved.has(key)) {
      if (resolved.size >= MAX_CACHED) resolved.clear();
      resolved.set(key, css);
    }
  }
  requestFamily(css);
  return css;
}

/**
 * Every font a set of shapes draws in, the document font included (library
 * shapes draw their inner text in it). An export renders once and can't
 * redraw, so it waits for these (`fontsReady`) before drawing.
 */
export function fontsOf(shapes: Iterable<object>): string[] {
  const fonts = new Set<string>([currentDocumentFont()]);
  for (const shape of shapes) {
    const { fontFamily, labelFontFamily } = shape as { fontFamily?: unknown; labelFontFamily?: unknown };
    if (fontFamily !== undefined) fonts.add(canvasFont(fontFamily));
    if (labelFontFamily !== undefined) fonts.add(canvasFont(labelFontFamily));
  }
  return [...fonts];
}
