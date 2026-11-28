/**
 * The open document's font (DSK-246): its `settings.font`, resolved to the CSS
 * font-family list that prose and canvas text draw with, unless a shape has a
 * font of its own.
 */

import { useDocumentSettingsStore } from '../store/documentSettingsStore';
import type { DocumentSettings } from '../types/DocumentSettings';
import { setCurrentDocumentFont } from './currentDocumentFont';
import { resolveDocumentFont } from './fontFamily';

/** The setting that holds a document's font. */
export const DOCUMENT_FONT_SETTING = 'font';

let lastSettings: DocumentSettings | null = null;
let lastFont = resolveDocumentFont(undefined);

/**
 * The document font now. Cheap enough to call per shape per frame: it only
 * resolves again when the settings object changes.
 */
export function documentFont(): string {
  const { settings } = useDocumentSettingsStore.getState();
  if (settings !== lastSettings) {
    lastSettings = settings;
    lastFont = resolveDocumentFont(settings[DOCUMENT_FONT_SETTING]);
  }
  return lastFont;
}

/** The document font, for React. */
export function useDocumentFont(): string {
  return useDocumentSettingsStore((state) => resolveDocumentFont(state.settings[DOCUMENT_FONT_SETTING]));
}

/** Set the document's font (a catalogue font's `css`). Shared documents sync it. */
export function setDocumentFont(css: string): void {
  useDocumentSettingsStore.getState().set(DOCUMENT_FONT_SETTING, css);
}

/** Call `listener` whenever the document font changes. Returns the unsubscribe. */
export function onDocumentFontChange(listener: (font: string) => void): () => void {
  let current = documentFont();
  return useDocumentSettingsStore.subscribe(() => {
    const next = documentFont();
    if (next !== current) {
      current = next;
      listener(next);
    }
  });
}

// Keep the canvas's copy (`currentDocumentFont`) in step with the document.
setCurrentDocumentFont(documentFont());
useDocumentSettingsStore.subscribe(() => setCurrentDocumentFont(documentFont()));
