/**
 * Loading the bundled fonts (DSK-246).
 *
 * At startup every face is registered with the FontFace API, which fetches
 * nothing until a face is used. Text in the page then loads what it needs by
 * itself. The canvas doesn't: it asks here (`requestFont`) for what it is
 * about to draw, and redraws when a face arrives (`onFontLoad`).
 *
 * Where there is no `document.fonts` (tests, a worker) all of this does
 * nothing, and text draws in its fallback family.
 */

import { FONT_CATALOGUE, INTERFACE_INTER } from './catalogue';

type FontLoadListener = () => void;

const listeners = new Set<FontLoadListener>();
const requested = new Set<string>();
let registered = false;

function fontSet(): FontFaceSet | null {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return null;
  return document.fonts ?? null;
}

/**
 * Register every bundled face (no network). Call once at startup; later calls
 * do nothing.
 */
export function registerBundledFonts(): void {
  if (registered) return;
  registered = true;
  const fonts = fontSet();
  if (!fonts) return;
  for (const font of FONT_CATALOGUE) {
    for (const face of font.faces) {
      fonts.add(
        new FontFace(font.family, `url(${face.woff2}) format('woff2')`, {
          weight: String(face.weight),
          style: face.style,
          display: 'swap',
        }),
      );
    }
  }
  fonts.add(
    new FontFace(INTERFACE_INTER.family, `url(${INTERFACE_INTER.woff2}) format('woff2')`, {
      weight: INTERFACE_INTER.weights,
      style: 'normal',
      display: 'swap',
    }),
  );
  fonts.addEventListener('loadingdone', () => {
    for (const listener of listeners) listener();
  });
}

/**
 * Ask for the face the canvas is about to draw `css` with. Loads it once;
 * {@link onFontLoad} fires when it has arrived.
 */
export function requestFont(css: string, weight: 400 | 700 = 400, style: 'normal' | 'italic' = 'normal'): void {
  const key = `${style} ${weight} ${css}`;
  if (requested.has(key)) return;
  requested.add(key);
  void fontSet()?.load(`${style} ${weight} 16px ${css}`).catch(() => {});
}

/**
 * Wait until the faces for `cssList` have loaded (every weight and style the
 * canvas draws), for an export that renders the canvas once and can't redraw.
 */
export async function fontsReady(cssList: readonly string[]): Promise<void> {
  const fonts = fontSet();
  if (!fonts) return;
  const loads = cssList.flatMap((css) =>
    ['normal 400', 'normal 700', 'italic 400', 'italic 700'].map((variant) =>
      fonts.load(`${variant} 16px ${css}`).catch(() => []),
    ),
  );
  await Promise.all(loads);
}

/** Subscribe to fonts arriving. Returns the unsubscribe. */
export function onFontLoad(listener: FontLoadListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Fetch a font file's bytes, for the PDF. Replaced in tests, which have no server. */
type FontBytesSource = (url: string) => Promise<ArrayBuffer>;

let fontBytesSource: FontBytesSource = async (url) => {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`font ${url}: HTTP ${response.status}`);
  return response.arrayBuffer();
};

/** The bytes of the font file at `url`. */
export function loadFontBytes(url: string): Promise<ArrayBuffer> {
  return fontBytesSource(url);
}

/** Test seam: where font bytes come from. */
export function setFontBytesSource(source: FontBytesSource): void {
  fontBytesSource = source;
}
