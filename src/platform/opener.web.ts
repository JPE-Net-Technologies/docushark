/**
 * Web implementation of {@link Opener}. No Tauri — URLs open in a new tab
 * and the chrome commands are no-ops (the caller reloads to re-mount the
 * in-app titlebar).
 */

import type { Opener } from './opener';
import { DOCS_URL } from './opener';

/**
 * Open `url` in a new tab. Returns whether it worked: a popup blocker makes
 * `window.open` return `null`, and callers (the device-code sign-in) need to
 * know rather than assume (JP-455).
 */
function openInNewTab(url: string): boolean {
  if (typeof window === 'undefined') return false;
  return window.open(url, '_blank', 'noopener,noreferrer') !== null;
}

export function createWebOpener(): Opener {
  return {
    openDocs() {
      openInNewTab(DOCS_URL);
      return Promise.resolve();
    },
    openExternalUrl(url) {
      return Promise.resolve(openInNewTab(url));
    },
    applyCustomChrome() {
      return Promise.resolve();
    },
    persistCustomChrome() {
      return Promise.resolve();
    },
  };
}
