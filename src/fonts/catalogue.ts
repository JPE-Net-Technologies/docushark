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
 * licence in `src/assets/fonts/<id>/`, run the script, and add an entry here.
 */

import interRegularTtf from '../assets/fonts/inter/Inter-Regular.ttf?url';
import interRegularWoff2 from '../assets/fonts/inter/Inter-Regular.woff2?url';
import interBoldTtf from '../assets/fonts/inter/Inter-Bold.ttf?url';
import interBoldWoff2 from '../assets/fonts/inter/Inter-Bold.woff2?url';
import interItalicTtf from '../assets/fonts/inter/Inter-Italic.ttf?url';
import interItalicWoff2 from '../assets/fonts/inter/Inter-Italic.woff2?url';
import interBoldItalicTtf from '../assets/fonts/inter/Inter-BoldItalic.ttf?url';
import interBoldItalicWoff2 from '../assets/fonts/inter/Inter-BoldItalic.woff2?url';
import interVariableWoff2 from '../assets/fonts/inter/InterVariable.woff2?url';
import serifRegularTtf from '../assets/fonts/source-serif-4/SourceSerif4-Regular.ttf?url';
import serifRegularWoff2 from '../assets/fonts/source-serif-4/SourceSerif4-Regular.woff2?url';
import serifBoldTtf from '../assets/fonts/source-serif-4/SourceSerif4-Bold.ttf?url';
import serifBoldWoff2 from '../assets/fonts/source-serif-4/SourceSerif4-Bold.woff2?url';
import serifItalicTtf from '../assets/fonts/source-serif-4/SourceSerif4-It.ttf?url';
import serifItalicWoff2 from '../assets/fonts/source-serif-4/SourceSerif4-It.woff2?url';
import serifBoldItalicTtf from '../assets/fonts/source-serif-4/SourceSerif4-BoldIt.ttf?url';
import serifBoldItalicWoff2 from '../assets/fonts/source-serif-4/SourceSerif4-BoldIt.woff2?url';
import monoRegularTtf from '../assets/fonts/jetbrains-mono/JetBrainsMono-Regular.ttf?url';
import monoRegularWoff2 from '../assets/fonts/jetbrains-mono/JetBrainsMono-Regular.woff2?url';
import monoBoldTtf from '../assets/fonts/jetbrains-mono/JetBrainsMono-Bold.ttf?url';
import monoBoldWoff2 from '../assets/fonts/jetbrains-mono/JetBrainsMono-Bold.woff2?url';
import monoItalicTtf from '../assets/fonts/jetbrains-mono/JetBrainsMono-Italic.ttf?url';
import monoItalicWoff2 from '../assets/fonts/jetbrains-mono/JetBrainsMono-Italic.woff2?url';
import monoBoldItalicTtf from '../assets/fonts/jetbrains-mono/JetBrainsMono-BoldItalic.ttf?url';
import monoBoldItalicWoff2 from '../assets/fonts/jetbrains-mono/JetBrainsMono-BoldItalic.woff2?url';
import caveatRegularTtf from '../assets/fonts/caveat/Caveat-Regular.ttf?url';
import caveatRegularWoff2 from '../assets/fonts/caveat/Caveat-Regular.woff2?url';
import caveatBoldTtf from '../assets/fonts/caveat/Caveat-Bold.ttf?url';
import caveatBoldWoff2 from '../assets/fonts/caveat/Caveat-Bold.woff2?url';

/** Where a font may be chosen. */
export type FontRole = 'document' | 'shape';

/** One face of a family: its weight and style, and its two files. */
export interface CatalogueFace {
  weight: 400 | 700;
  style: 'normal' | 'italic';
  /** The TTF's file name: what the PDF names the embedded file. */
  file: string;
  /** URL of the TTF, which the PDF embeds. */
  ttf: string;
  /** URL of the WOFF2, which the screen loads. */
  woff2: string;
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

const face = (
  weight: CatalogueFace['weight'],
  style: CatalogueFace['style'],
  file: string,
  ttf: string,
  woff2: string,
): CatalogueFace => ({ weight, style, file, ttf, woff2 });

export const INTER: CatalogueFont = {
  id: 'inter',
  name: 'Inter',
  kind: 'Sans',
  family: 'Inter',
  css: 'Inter, sans-serif',
  generic: 'sans-serif',
  roles: ['document', 'shape'],
  faces: [
    face(400, 'normal', 'Inter-Regular.ttf', interRegularTtf, interRegularWoff2),
    face(700, 'normal', 'Inter-Bold.ttf', interBoldTtf, interBoldWoff2),
    face(400, 'italic', 'Inter-Italic.ttf', interItalicTtf, interItalicWoff2),
    face(700, 'italic', 'Inter-BoldItalic.ttf', interBoldItalicTtf, interBoldItalicWoff2),
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
    face(400, 'normal', 'SourceSerif4-Regular.ttf', serifRegularTtf, serifRegularWoff2),
    face(700, 'normal', 'SourceSerif4-Bold.ttf', serifBoldTtf, serifBoldWoff2),
    face(400, 'italic', 'SourceSerif4-It.ttf', serifItalicTtf, serifItalicWoff2),
    face(700, 'italic', 'SourceSerif4-BoldIt.ttf', serifBoldItalicTtf, serifBoldItalicWoff2),
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
    face(400, 'normal', 'JetBrainsMono-Regular.ttf', monoRegularTtf, monoRegularWoff2),
    face(700, 'normal', 'JetBrainsMono-Bold.ttf', monoBoldTtf, monoBoldWoff2),
    face(400, 'italic', 'JetBrainsMono-Italic.ttf', monoItalicTtf, monoItalicWoff2),
    face(700, 'italic', 'JetBrainsMono-BoldItalic.ttf', monoBoldItalicTtf, monoBoldItalicWoff2),
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
    face(400, 'normal', 'Caveat-Regular.ttf', caveatRegularTtf, caveatRegularWoff2),
    face(700, 'normal', 'Caveat-Bold.ttf', caveatBoldTtf, caveatBoldWoff2),
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
  woff2: interVariableWoff2,
  weights: '100 900',
} as const;
