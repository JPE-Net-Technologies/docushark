/**
 * Web implementation of {@link Opener}. No Tauri — URLs open in a new tab
 * and the chrome commands are no-ops (the caller reloads to re-mount the
 * in-app titlebar).
 */

import type { Opener } from './opener';
import { DOCS_URL } from './opener';

function openInNewTab(url: string): void {
  if (typeof window !== 'undefined') {
    window.open(url, '_blank', 'noopener,noreferrer');
  }
}

export function createWebOpener(): Opener {
  return {
    openDocs() {
      openInNewTab(DOCS_URL);
      return Promise.resolve();
    },
    openExternalUrl(url) {
      openInNewTab(url);
      return Promise.resolve();
    },
    applyCustomChrome() {
      return Promise.resolve();
    },
    persistCustomChrome() {
      return Promise.resolve();
    },
  };
}
