/**
 * Shim for Vite compile-time `define` constants (see vite.config.ts) so the
 * editor source can be imported by headless `bun` scripts. These are normally
 * string-replaced at build time; under bun they'd be undefined bare identifiers.
 * Import this module FIRST, before any `../src/**` import.
 */
const g = globalThis as Record<string, unknown>;
g.__IS_TAURI__ ??= false;
g.__APP_VERSION__ ??= '0.0.0-headless';
g.__GIT_SHA__ ??= 'headless';
g.__BUILD_TIME__ ??= new Date(0).toISOString();
