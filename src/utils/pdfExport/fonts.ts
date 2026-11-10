/**
 * PDF Font Registration for jsPDF.
 *
 * Embeds the document's font (DSK-246) and the code font, from the font
 * catalogue's TTF files (`src/fonts/catalogue.ts`): the same files the
 * screen's WOFF2s are generated from, so a line wraps on paper where it wraps
 * on screen. jsPDF's built-in helvetica/courier only support WinAnsiEncoding
 * and cause þÿ artifacts with Unicode text.
 *
 * The files are fetched when an export runs; the default family's and the
 * code font's are precached, so a default document exports offline.
 *
 * @see https://github.com/parallax/jsPDF/issues/2677
 */

import type { jsPDF } from 'jspdf';
import {
  CODE_FONT,
  DEFAULT_DOCUMENT_FONT,
  FONT_CATALOGUE,
  type CatalogueFace,
  type CatalogueFont,
} from '../../fonts/catalogue';
import { catalogueFontFor } from '../../fonts/fontFamily';
import { loadFontBytes } from '../../fonts/fontLoader';

/** Monospace font family name used for code blocks */
export const PDF_FONT_MONO = CODE_FONT.pdfName;

type PdfStyle = 'normal' | 'bold' | 'italic' | 'bolditalic';

/** jsPDF's four styles, as weight and slant. */
const PDF_STYLES: ReadonlyArray<{ style: PdfStyle; weight: 400 | 700; italic: boolean }> = [
  { style: 'normal', weight: 400, italic: false },
  { style: 'bold', weight: 700, italic: false },
  { style: 'italic', weight: 400, italic: true },
  { style: 'bolditalic', weight: 700, italic: true },
];

/**
 * The bundled font a PDF embeds for a document font: the one it names, else
 * the bundled stand-in for the generic family it ends with, else the default.
 * A PDF can only embed what is bundled.
 */
export function pdfFontFor(fontFamily: string | undefined): CatalogueFont {
  if (fontFamily === undefined) return DEFAULT_DOCUMENT_FONT;
  const named = catalogueFontFor(fontFamily);
  if (named) return named;
  const generic = fontFamily.split(',').map((part) => part.trim()).pop();
  if (generic === 'sans-serif') return DEFAULT_DOCUMENT_FONT;
  return FONT_CATALOGUE.find((font) => font.generic === generic) ?? DEFAULT_DOCUMENT_FONT;
}

/** The face for a jsPDF style: exact, else the same weight upright, else the regular. */
function faceFor(font: CatalogueFont, weight: 400 | 700, italic: boolean): CatalogueFace {
  const style = italic ? 'italic' : 'normal';
  return (
    font.faces.find((face) => face.weight === weight && face.style === style) ??
    font.faces.find((face) => face.weight === weight && face.style === 'normal') ??
    font.faces[0]!
  );
}

/**
 * The file as base64, which is what jsPDF's virtual file system was given when
 * the fonts were bundled as base64 modules, so default exports stay
 * byte-identical.
 */
async function fileAsBase64(url: string): Promise<string> {
  const bytes = new Uint8Array(await loadFontBytes(url));
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Register the document's font family and the code font with a jsPDF document,
 * and return the family's jsPDF name for `setFont`. Must be called once after
 * `new jsPDF(...)` and before any text rendering.
 */
export async function registerPDFFonts(doc: jsPDF, text: CatalogueFont = DEFAULT_DOCUMENT_FONT): Promise<string> {
  const textFaces = PDF_STYLES.map(({ style, weight, italic }) => ({ style, face: faceFor(text, weight, italic) }));
  const code = faceFor(CODE_FONT, 400, false);
  const files = new Map<string, string>();
  const urls = new Set([...textFaces.map(({ face }) => face.ttf), code.ttf]);
  await Promise.all([...urls].map(async (url) => files.set(url, await fileAsBase64(url))));

  for (const { style, face } of textFaces) {
    doc.addFileToVFS(face.file, files.get(face.ttf)!);
    doc.addFont(face.file, text.pdfName, style);
  }

  if (text !== CODE_FONT) {
    // The code font: regular only, standing in for its italic too (DSK-247
    // embeds just the faces a document uses).
    doc.addFileToVFS(code.file, files.get(code.ttf)!);
    doc.addFont(code.file, CODE_FONT.pdfName, 'normal');
    doc.addFont(code.file, CODE_FONT.pdfName, 'italic');
  }

  doc.setFont(text.pdfName, 'normal');
  return text.pdfName;
}
