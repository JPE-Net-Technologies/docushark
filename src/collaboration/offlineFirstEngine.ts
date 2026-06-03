/**
 * Kill-switch for the offline-first local CRDT engine (JP-108 step 3, Stage 2).
 *
 * When enabled (the default), a relay document's Y.Doc engine activates on
 * doc-open — even with no connection — so edits are CRDT ops from the first
 * keystroke and survive offline (see `ensureCollabSession.ts`). Set the
 * localStorage key to `'0'` to fall back to the pre-Stage-2 behavior (a collab
 * session only starts on an explicit connect/sign-in), without reverting code.
 *
 * Defaults ON: only an explicit `'0'` disables it, so a hosted build with the
 * key unset still gets the feature.
 */
const FLAG_KEY = 'docushark:flags:offlineFirstEngine';

export function isOfflineFirstEngineEnabled(): boolean {
  try {
    return localStorage.getItem(FLAG_KEY) !== '0';
  } catch {
    // No localStorage (SSR / locked-down env) — default to the feature being on.
    return true;
  }
}
