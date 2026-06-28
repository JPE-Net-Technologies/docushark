/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

/**
 * Build-time flags injected by `vite.config.ts` via `define`.
 *
 * `__IS_TAURI__` lets platform-specific modules be tree-shaken out of
 * the PWA bundle when they're guarded by `if (__IS_TAURI__) { ... }` —
 * Vite replaces the literal at build time, then Rollup drops the
 * unreachable branch and any module that was only imported from it.
 */
declare const __APP_VERSION__: string;
/** Short git SHA of the build, or "unknown" (JP-327). Shown in Settings → About. */
declare const __GIT_SHA__: string;
/** ISO-8601 UTC build timestamp (JP-327). */
declare const __BUILD_TIME__: string;
declare const __IS_TAURI__: boolean;

interface ImportMetaEnv {
  /**
   * Cloud (docushark-web) origin this build pairs with, used as the default
   * when no connection record is persisted (e.g. the web one-click handoff).
   * Optional — falls back to the local dev origin in `relayConnection.ts`.
   */
  readonly VITE_CLOUD_BASE_URL?: string;
  /**
   * Relay origin for the primary region, used as the default location's URL in
   * the Cloud connect switcher. Optional — falls back to the local dev relay
   * (`http://localhost:9876`) in `relayLocations.ts`.
   */
  readonly VITE_RELAY_BASE_URL?: string;
}

declare module 'nspell' {
  interface NSpell {
    correct(word: string): boolean;
    suggest(word: string): string[];
    spell(word: string): { correct: boolean; forbidden: boolean; warn: boolean };
    add(word: string, model?: string): NSpell;
    remove(word: string): NSpell;
    wordCharacters(): string | undefined;
    dictionary(dic: string | Buffer): NSpell;
    personal(personal: string | Buffer): NSpell;
  }
  function nspell(aff: string | Buffer | { aff: string | Buffer; dic?: string | Buffer }, dic?: string | Buffer): NSpell;
  export default nspell;
}
