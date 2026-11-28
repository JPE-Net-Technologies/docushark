/**
 * The open document's font as canvas code reads it (DSK-246): a plain value,
 * so shape renderers, which the docs site also loads, import no store.
 * `documentFont.ts` keeps it in step with the document's settings.
 */

import { DEFAULT_DOCUMENT_FONT } from './catalogue';

type Listener = (font: string) => void;

let current = DEFAULT_DOCUMENT_FONT.css;
const listeners = new Set<Listener>();

/** The document font now, resolved: a CSS font-family list. */
export function currentDocumentFont(): string {
  return current;
}

/** Set the document font now; listeners hear only real changes. */
export function setCurrentDocumentFont(font: string): void {
  if (font === current) return;
  current = font;
  for (const listener of listeners) listener(font);
}

/** Call `listener` whenever the document font changes. Returns the unsubscribe. */
export function onCurrentDocumentFontChange(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
