/// <reference types="vite/client" />

/**
 * Build-time flags injected by `vite.config.ts` via `define`.
 *
 * `__IS_TAURI__` lets platform-specific modules be tree-shaken out of
 * the PWA bundle when they're guarded by `if (__IS_TAURI__) { ... }` —
 * Vite replaces the literal at build time, then Rollup drops the
 * unreachable branch and any module that was only imported from it.
 */
declare const __APP_VERSION__: string;
declare const __IS_TAURI__: boolean;

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
