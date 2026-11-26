/**
 * Loading the bundled fonts (DSK-246).
 *
 * At startup every face is registered with the FontFace API
 * (`registerFonts.ts`), which fetches nothing until a face is used. Text in the page then loads what it needs by
 * itself. The canvas doesn't: it asks here (`requestFamily`) for what it is
 * about to draw, and redraws when a face arrives (`onFontLoad`).
 *
 * Where there is no `document.fonts` (tests, a worker) all of this does
 * nothing, and text draws in its fallback family.
 */

type FontLoadListener = () => void;

const listeners = new Set<FontLoadListener>();
const requested = new Set<string>();

export function fontSet(): FontFaceSet | null {
  if (typeof document === 'undefined' || typeof FontFace === 'undefined') return null;
  return document.fonts ?? null;
}

/** Tell subscribers fonts have arrived (on `loadingdone`, and in tests). */
export function notifyFontLoad(): void {
  for (const listener of listeners) listener();
}

/** The four faces a canvas may draw a family in. */
const VARIANTS = ['normal 400', 'normal 700', 'italic 400', 'italic 700'] as const;

/**
 * Ask for the family the canvas is about to draw `css` in: all its faces, once,
 * so bold and italic text never wait on a face of their own. {@link onFontLoad}
 * fires as they arrive.
 */
export function requestFamily(css: string): void {
  if (requested.has(css)) return;
  requested.add(css);
  const fonts = fontSet();
  if (!fonts) return;
  for (const variant of VARIANTS) void fonts.load(`${variant} 16px ${css}`).catch(() => []);
}

/**
 * Wait until the faces for `cssList` have loaded (every weight and style the
 * canvas draws), for an export that renders the canvas once and can't redraw.
 */
export async function fontsReady(cssList: readonly string[]): Promise<void> {
  const fonts = fontSet();
  if (!fonts) return;
  const loads = cssList.flatMap((css) =>
    VARIANTS.map((variant) => fonts.load(`${variant} 16px ${css}`).catch(() => [])),
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
