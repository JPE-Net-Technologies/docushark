/**
 * `platform.secureStore` — small key→string store for sensitive values
 * (today: the relay app token + connection record).
 *
 * **Current backing is `localStorage` on both shells.** The name signals
 * *intent*, not present-day hardening: the desktop OS-keychain /
 * `tauri-plugin-stronghold` (Mac/Win) + encrypted-file-fallback (Linux)
 * implementation is a deliberately deferred hardening step. When it lands it
 * will likely make this contract async, which is why callers should treat
 * this as the single seam for secret persistence rather than touching
 * `localStorage` directly.
 *
 * Errors are swallowed (returns `null` / no-ops) so a storage-disabled
 * context (private mode, blocked storage) degrades gracefully — matching the
 * previous inline `localStorage` try/catch behavior.
 */

export interface SecureStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export const secureStore: SecureStore = {
  getItem(key) {
    try {
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      localStorage.setItem(key, value);
    } catch (err) {
      console.warn('[secureStore] Failed to persist:', err);
    }
  },
  removeItem(key) {
    try {
      localStorage.removeItem(key);
    } catch {
      /* ignore */
    }
  },
};
