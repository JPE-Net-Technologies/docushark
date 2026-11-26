/**
 * The bundled fonts (DSK-246).
 *
 * Each face ships twice from one source: the TTF the PDF embeds, and a WOFF2
 * for the screen generated from that TTF by `scripts/fonts/build-woff2.py`,
 * which checks the two measure alike. So text wraps the same on screen and
 * on paper.
 *
 * A stored font is a CSS font-family list ending in a generic family (an
 * entry's `css`). A build without the font, or a font later removed from
 * this list, falls back to that generic family.
 *
 * Adding a font: put its TTFs (TrueType outlines: jsPDF can't embed CFF) and
 * licence in `src/assets/fonts/<id>/`, run the script, add an entry here and
 * its files to `fontFiles.ts`.
 *
 * Names only: the files' URLs are in `fontFiles.ts`, so code that only needs a
 * font's name (the canvas, the docs site's data loaders) imports no font asset.
 */


/** Where a font may be chosen. */
export type FontRole = 'document' | 'shape';

/** One face of a family: its weight and style, and its TTF's file name. */
export interface CatalogueFace {
  weight: 400 | 700;
  style: 'normal' | 'italic';
  /** The TTF's file name: what the PDF names the embedded file, and the key of its files (`fontFiles.ts`). */
  file: string;
}

export interface CatalogueFont {
  /** Stable id. */
  id: string;
  /** Shown in pickers, drawn in the font itself. */
  name: string;
  /** What kind of font it is, shown beside the name. */
  kind: 'Sans' | 'Serif' | 'Mono' | 'Handwriting';
  /** The family name the faces are registered under. */
  family: string;
  /** The stored value: a CSS font-family list ending in `generic`. */
  css: string;
  /** What a build without this font shows instead. */
  generic: 'sans-serif' | 'serif' | 'monospace' | 'cursive';
  roles: readonly FontRole[];
  faces: readonly CatalogueFace[];
  /** The family's name inside jsPDF (`setFont`). */
  pdfName: string;
}

const face = (weight: CatalogueFace['weight'], style: CatalogueFace['style'], file: string): CatalogueFace => ({
  weight,
  style,
  file,
});

export const INTER: CatalogueFont = {
  id: 'inter',
  name: 'Inter',
  kind: 'Sans',
  family: 'Inter',
  css: 'Inter, sans-serif',
  generic: 'sans-serif',
  roles: ['document', 'shape'],
  faces: [
    face(400, 'normal', 'Inter-Regular.ttf'),
    face(700, 'normal', 'Inter-Bold.ttf'),
    face(400, 'italic', 'Inter-Italic.ttf'),
    face(700, 'italic', 'Inter-BoldItalic.ttf'),
  ],
  pdfName: 'Inter',
};

export const SOURCE_SERIF: CatalogueFont = {
  id: 'source-serif-4',
  name: 'Source Serif 4',
  kind: 'Serif',
  family: 'Source Serif 4',
  css: "'Source Serif 4', serif",
  generic: 'serif',
  roles: ['document', 'shape'],
  faces: [
    face(400, 'normal', 'SourceSerif4-Regular.ttf'),
    face(700, 'normal', 'SourceSerif4-Bold.ttf'),
    face(400, 'italic', 'SourceSerif4-It.ttf'),
    face(700, 'italic', 'SourceSerif4-BoldIt.ttf'),
  ],
  pdfName: 'SourceSerif4',
};

export const JETBRAINS_MONO: CatalogueFont = {
  id: 'jetbrains-mono',
  name: 'JetBrains Mono',
  kind: 'Mono',
  family: 'JetBrains Mono',
  css: "'JetBrains Mono', monospace",
  generic: 'monospace',
  roles: ['document', 'shape'],
  faces: [
    face(400, 'normal', 'JetBrainsMono-Regular.ttf'),
    face(700, 'normal', 'JetBrainsMono-Bold.ttf'),
    face(400, 'italic', 'JetBrainsMono-Italic.ttf'),
    face(700, 'italic', 'JetBrainsMono-BoldItalic.ttf'),
  ],
  pdfName: 'JetBrainsMono',
};

export const CAVEAT: CatalogueFont = {
  id: 'caveat',
  name: 'Caveat',
  kind: 'Handwriting',
  family: 'Caveat',
  css: 'Caveat, cursive',
  generic: 'cursive',
  // Handwriting suits a note or a label, not a page of text.
  roles: ['shape'],
  faces: [
    face(400, 'normal', 'Caveat-Regular.ttf'),
    face(700, 'normal', 'Caveat-Bold.ttf'),
  ],
  pdfName: 'Caveat',
};

/** Every bundled font, in the order pickers list them. */
export const FONT_CATALOGUE: readonly CatalogueFont[] = [INTER, SOURCE_SERIF, JETBRAINS_MONO, CAVEAT];

/** A document's font when it has chosen none (founder decision, 2026-11-10). */
export const DEFAULT_DOCUMENT_FONT = INTER;

/** Code in prose, on the canvas and in the PDF. */
export const CODE_FONT = JETBRAINS_MONO;

/**
 * The interface font when the app font is set to Inter: the variable build,
 * which has every weight the chrome uses (400 to 700). Separate from the
 * document fonts, which are the static faces the PDF embeds.
 */
export const INTERFACE_INTER = {
  family: 'InterVariable',
  weights: '100 900',
} as const;
