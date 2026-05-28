/**
 * `platform.opener` — open external URLs / the docs site, and apply the
 * custom-chrome window preference.
 *
 * Replaces the old `src/tauri/commands.ts` shell. The desktop impl drives
 * Tauri IPC commands (`open_docs`, `open_external_url`, `apply_custom_chrome`,
 * `persist_custom_chrome`); the web impl uses `window.open` / a reload. The
 * `@tauri-apps/api/core` `invoke` import lives in `./opener.tauri` so it is
 * tree-shaken out of the PWA bundle.
 */

/** Canonical online docs URL, used as the web/desktop-fallback target. */
export const DOCS_URL = 'https://JPE-Net-Technologies.github.io/docushark/';

export interface Opener {
  /**
   * Open the DocuShark docs. Desktop launches the bundled/offline docs via
   * the system browser, falling back to {@link DOCS_URL} on failure; web
   * opens {@link DOCS_URL} in a new tab.
   */
  openDocs(): Promise<void>;
  /** Open an arbitrary http(s) URL in the system browser / a new tab. */
  openExternalUrl(url: string): Promise<void>;
  /**
   * Persist the custom-chrome flag and apply it (desktop restarts so the
   * window is rebuilt with the new decoration setting). No-op on web — the
   * caller reloads to re-mount the in-app titlebar.
   */
  applyCustomChrome(enabled: boolean): Promise<void>;
  /** Persist the custom-chrome flag without applying/restarting. No-op on web. */
  persistCustomChrome(enabled: boolean): Promise<void>;
}

let cached: Promise<Opener> | null = null;

function resolve(): Promise<Opener> {
  if (!cached) {
    // `__IS_TAURI__` is a build-time literal — the false branch (and its
    // `@tauri-apps` import) is dead-code-eliminated from the PWA bundle.
    cached = __IS_TAURI__
      ? import('./opener.tauri').then((m) => m.createTauriOpener())
      : import('./opener.web').then((m) => m.createWebOpener());
  }
  return cached;
}

export const opener: Opener = {
  openDocs: () => resolve().then((o) => o.openDocs()),
  openExternalUrl: (url) => resolve().then((o) => o.openExternalUrl(url)),
  applyCustomChrome: (enabled) => resolve().then((o) => o.applyCustomChrome(enabled)),
  persistCustomChrome: (enabled) => resolve().then((o) => o.persistCustomChrome(enabled)),
};
