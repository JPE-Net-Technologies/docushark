/**
 * Font values (DSK-246): what a document or a shape stores, and what it draws
 * with. Pure; no loading here (see `fontLoader.ts`).
 *
 * Every stored font is a CSS font-family list ending in a generic family, such
 * as `'Source Serif 4', serif`. A value naming a bundled family resolves to
 * that family's canonical list; any other safe value is used as it is, so a
 * font this build doesn't know still draws, in its generic family at worst.
 */

import {
  CAVEAT,
  DEFAULT_DOCUMENT_FONT,
  FONT_CATALOGUE,
  JETBRAINS_MONO,
  SOURCE_SERIF,
  type CatalogueFont,
} from './catalogue';

/**
 * What a text shape stores to follow the document font: the old default, so
 * every existing text shape, and every one an agent creates, follows it.
 */
export const FOLLOW_DOCUMENT_FONT = 'sans-serif';

/** Longest font value accepted. */
const MAX_LENGTH = 200;
/** Family names, separators and quotes: nothing that could end a CSS value. */
const SAFE = /^[\w ,.'"-]+$/;

/**
 * Generic families stand for a bundled font, so a shape an agent or an import
 * gives `serif` draws the same everywhere. `sans-serif` is the exception: it
 * follows the document font (see {@link FOLLOW_DOCUMENT_FONT}).
 */
const GENERIC_STAND_INS: Readonly<Record<string, CatalogueFont>> = {
  serif: SOURCE_SERIF,
  monospace: JETBRAINS_MONO,
  cursive: CAVEAT,
};

/** A stored font value, if it is safe to use; otherwise `null`. */
export function sanitizeFontFamily(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.length > MAX_LENGTH || !SAFE.test(trimmed)) return null;
  // An unbalanced quote makes the whole value invalid, and a canvas then keeps
  // whatever font it had before.
  if (count(trimmed, "'") % 2 !== 0 || count(trimmed, '"') % 2 !== 0) return null;
  return trimmed;
}

function count(text: string, char: string): number {
  return text.split(char).length - 1;
}

/** The first family a font value names, unquoted and lower-cased. */
export function firstFamily(css: string): string {
  return (css.split(',')[0] ?? '').trim().replace(/^['"]|['"]$/g, '').toLowerCase();
}

/**
 * The bundled font a value names, by its first family, or the bundled stand-in
 * for a generic family. `null` for anything else.
 */
export function catalogueFontFor(value: unknown): CatalogueFont | null {
  const css = sanitizeFontFamily(value);
  if (css === null) return null;
  const first = firstFamily(css);
  return (
    FONT_CATALOGUE.find((font) => font.family.toLowerCase() === first) ??
    GENERIC_STAND_INS[first] ??
    null
  );
}

/**
 * The font a document's text draws with, from its `settings.font`. Unset or
 * unsafe means the default; a bundled family resolves to its canonical list.
 */
export function resolveDocumentFont(value: unknown): string {
  const css = sanitizeFontFamily(value);
  if (css === null || css === FOLLOW_DOCUMENT_FONT) return DEFAULT_DOCUMENT_FONT.css;
  return catalogueFontFor(css)?.css ?? css;
}

/**
 * The font a shape's text draws with: the document font unless the shape has
 * its own. `stored` is a text shape's `fontFamily` or a shape's
 * `labelFontFamily`; `documentFont` is a resolved document font.
 */
export function resolveShapeFont(stored: unknown, documentFont: string): string {
  const css = sanitizeFontFamily(stored);
  if (css === null || css === FOLLOW_DOCUMENT_FONT) return documentFont;
  return catalogueFontFor(css)?.css ?? css;
}
