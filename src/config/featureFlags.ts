/**
 * Experimental feature flags.
 *
 * These gate **in-progress** features that aren't ready to ship to everyone —
 * distinct from user-facing settings in `settingsStore`. They're read from
 * `localStorage` so a developer/tester can flip them per-device without a UI,
 * and they default OFF.
 *
 * Toggle in the browser console, then reload:
 *   localStorage.setItem('docushark:flags:collabProse', '1')   // enable
 *   localStorage.removeItem('docushark:flags:collabProse')      // disable
 *
 * Reads are non-reactive by design — set the flag and reload to apply.
 */

function readFlag(name: string): boolean {
  try {
    return localStorage.getItem(`docushark:flags:${name}`) === '1';
  } catch {
    // SSR / private-mode / disabled storage → feature stays off.
    return false;
  }
}

/**
 * Collaborative prose (live Tiptap ↔ Y.Doc sync for relay documents).
 * Work in progress — see the "Collaborative prose" plan.
 */
export function isCollabProseEnabled(): boolean {
  return readFlag('collabProse');
}
