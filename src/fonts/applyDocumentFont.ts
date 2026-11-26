/**
 * The document font in CSS (DSK-246): `--doc-font` and `--doc-font-mono` on the
 * root, which prose reads (`TiptapEditor.css`). Runs at module load and keeps
 * tracking the open document, like `applyAppearance`.
 */

import { CODE_FONT } from './catalogue';
import { documentFont, onDocumentFontChange } from './documentFont';

function apply(font: string): void {
  if (typeof document === 'undefined') return;
  const root = document.documentElement;
  root.style.setProperty('--doc-font', font);
  root.style.setProperty('--doc-font-mono', CODE_FONT.css);
}

apply(documentFont());
onDocumentFontChange(apply);
