/**
 * Platform runtime detection.
 *
 * Two distinct mechanisms, used for different jobs:
 *
 * - `IS_TAURI` — the build-time `__IS_TAURI__` define (Vite sets it from
 *   `TAURI_ENV_PLATFORM`). This is the **import boundary**: capability
 *   resolvers branch on it so the PWA build statically tree-shakes the
 *   Tauri implementation modules (and their `@tauri-apps/*` imports) out
 *   entirely. Pure runtime detection can't do that — a `@tauri-apps`
 *   import reached at runtime would still be emitted into the web bundle.
 *
 * - `isTauri()` — runtime detection via the injected globals. Use it for
 *   UI branches and guards that need to behave correctly in a single
 *   bundle (e.g. a dev `bun run dev` build that was compiled with
 *   `__IS_TAURI__ === false` but happens to load some desktop-only path).
 *
 * `src/platform/` is the only place `@tauri-apps/*` may be imported.
 */

/** The build-time desktop flag. `true` only in Tauri renderer builds. */
export const IS_TAURI: boolean = __IS_TAURI__;

/**
 * Check at runtime whether we're inside the Tauri desktop shell. Tauri v2
 * uses `__TAURI_INTERNALS__` instead of v1's `__TAURI__`; the older key is
 * checked too for resilience against older webview snapshots.
 */
export function isTauri(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || '__TAURI__' in window)
  );
}
