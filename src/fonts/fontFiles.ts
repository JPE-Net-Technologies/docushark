/**
 * The bundled font files (DSK-246): each face's TTF, which the PDF embeds, and
 * the WOFF2 generated from it, which the screen loads, keyed by the TTF's file
 * name. Apart from `catalogue.ts`, so code that only needs a font's name
 * imports no font asset.
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

import type { CatalogueFace } from './catalogue';

/** A face's two files: the TTF and the WOFF2 made from it. */
export interface FaceFiles {
  ttf: string;
  woff2: string;
}

const FILES: Readonly<Record<string, FaceFiles>> = {
  'Inter-Regular.ttf': { ttf: interRegularTtf, woff2: interRegularWoff2 },
  'Inter-Bold.ttf': { ttf: interBoldTtf, woff2: interBoldWoff2 },
  'Inter-Italic.ttf': { ttf: interItalicTtf, woff2: interItalicWoff2 },
  'Inter-BoldItalic.ttf': { ttf: interBoldItalicTtf, woff2: interBoldItalicWoff2 },
  'SourceSerif4-Regular.ttf': { ttf: serifRegularTtf, woff2: serifRegularWoff2 },
  'SourceSerif4-Bold.ttf': { ttf: serifBoldTtf, woff2: serifBoldWoff2 },
  'SourceSerif4-It.ttf': { ttf: serifItalicTtf, woff2: serifItalicWoff2 },
  'SourceSerif4-BoldIt.ttf': { ttf: serifBoldItalicTtf, woff2: serifBoldItalicWoff2 },
  'JetBrainsMono-Regular.ttf': { ttf: monoRegularTtf, woff2: monoRegularWoff2 },
  'JetBrainsMono-Bold.ttf': { ttf: monoBoldTtf, woff2: monoBoldWoff2 },
  'JetBrainsMono-Italic.ttf': { ttf: monoItalicTtf, woff2: monoItalicWoff2 },
  'JetBrainsMono-BoldItalic.ttf': { ttf: monoBoldItalicTtf, woff2: monoBoldItalicWoff2 },
  'Caveat-Regular.ttf': { ttf: caveatRegularTtf, woff2: caveatRegularWoff2 },
  'Caveat-Bold.ttf': { ttf: caveatBoldTtf, woff2: caveatBoldWoff2 },
};

/** The files of a catalogue face. */
export function faceFiles(face: CatalogueFace): FaceFiles {
  const files = FILES[face.file];
  if (!files) throw new Error(`No files for the font face ${face.file}`);
  return files;
}

/** The interface font's file: Inter's variable build. */
export const INTERFACE_INTER_WOFF2 = interVariableWoff2;
