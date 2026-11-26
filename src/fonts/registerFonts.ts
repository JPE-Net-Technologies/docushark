/**
 * Register the bundled fonts at startup (DSK-246): every face, with the FontFace
 * API, which fetches nothing until a face is used. Apart from `fontLoader.ts`
 * because it imports the font files' URLs; only startup needs them.
 */

import { FONT_CATALOGUE, INTERFACE_INTER } from './catalogue';
import { faceFiles, INTERFACE_INTER_WOFF2 } from './fontFiles';
import { fontSet, notifyFontLoad } from './fontLoader';

let registered = false;

/** Register every bundled face (no network). Later calls do nothing. */
export function registerBundledFonts(): void {
  if (registered) return;
  registered = true;
  const fonts = fontSet();
  if (!fonts) return;
  for (const font of FONT_CATALOGUE) {
    for (const face of font.faces) {
      fonts.add(
        new FontFace(font.family, `url(${faceFiles(face).woff2}) format('woff2')`, {
          weight: String(face.weight),
          style: face.style,
          display: 'swap',
        }),
      );
    }
  }
  fonts.add(
    new FontFace(INTERFACE_INTER.family, `url(${INTERFACE_INTER_WOFF2}) format('woff2')`, {
      weight: INTERFACE_INTER.weights,
      style: 'normal',
      display: 'swap',
    }),
  );
  fonts.addEventListener('loadingdone', notifyFontLoad);
}
