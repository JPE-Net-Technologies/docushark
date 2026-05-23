/**
 * Persistence helper for the user's relay connection details.
 *
 * Phase 20.3 Slice E.2 Commit 3.
 *
 * Decision #2 from the v2 relay plan (Todo.md Phase 20.3): only the
 * relay URL is silently re-applied on boot (it pre-fills the login
 * form). The cached JWT is loaded but *not* silently re-asserted —
 * the user must click "Connect," at which point we try it once; a 401
 * drops it and forces a fresh login. No silent retry, no auto-login.
 */

const STORAGE_KEY = 'docushark-relay-connection';

export interface RelayConnection {
  /** Origin of the relay (e.g. `http://localhost:9876`). */
  relayUrl: string;
  /** Last JWT received from a successful login, or null if logged out. */
  jwt: string | null;
}

/** Read the persisted connection, or null if none / malformed. */
export function loadConnection(): RelayConnection | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<RelayConnection>;
    if (typeof parsed.relayUrl !== 'string') return null;
    return {
      relayUrl: parsed.relayUrl,
      jwt: typeof parsed.jwt === 'string' ? parsed.jwt : null,
    };
  } catch {
    return null;
  }
}

/** Persist URL + JWT. Pass `jwt: null` to record a logged-out URL. */
export function saveConnection(relayUrl: string, jwt: string | null): void {
  try {
    const payload: RelayConnection = { relayUrl, jwt };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('[relayConnection] Failed to persist:', err);
  }
}

/** Clear the cached JWT but keep the URL so the login form stays pre-filled. */
export function clearJwt(): void {
  const current = loadConnection();
  if (!current) return;
  saveConnection(current.relayUrl, null);
}

/** Wipe the entry entirely. */
export function clearConnection(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore */
  }
}
