/**
 * Tauri implementation of {@link Opener}. Drives the Rust-side IPC commands
 * via `@tauri-apps/api/core`'s `invoke`. This module is only imported in the
 * desktop build (gated by `__IS_TAURI__` in `./opener`).
 *
 * `openDocs` falls back to the online docs in a new tab if the bundled-docs
 * command throws, preserving the previous caller-side fallback.
 *
 * `applyCustomChrome` does not return on success — the process restarts so
 * the main window is rebuilt with the new decoration setting from creation
 * time (needed for Linux WMs that ignore runtime `setDecorations`).
 */

import { invoke } from '@tauri-apps/api/core';
import type { Opener } from './opener';
import { DOCS_URL } from './opener';

export function createTauriOpener(): Opener {
  return {
    async openDocs() {
      try {
        await invoke<void>('open_docs');
      } catch (err) {
        console.error('[opener] open_docs failed; falling back to online docs:', err);
        if (typeof window !== 'undefined') {
          window.open(DOCS_URL, '_blank', 'noopener,noreferrer');
        }
      }
    },
    openExternalUrl(url) {
      return invoke<void>('open_external_url', { url });
    },
    applyCustomChrome(enabled) {
      return invoke<void>('apply_custom_chrome', { enabled });
    },
    persistCustomChrome(enabled) {
      return invoke<void>('persist_custom_chrome', { enabled });
    },
  };
}
