/**
 * `platform.secureStore` — small key→string store for sensitive values
 * (today: the relay app token + connection record).
 *
 * **Backing is IndexedDB with a localStorage fallback** via [[secureKvStore]] —
 * the async contract JP-100 moved the relay token onto, and the same shape the
 * deferred desktop OS-keychain / `tauri-plugin-stronghold` (Mac/Win) +
 * encrypted-file-fallback (Linux) impl will adopt. Callers should treat this as
 * the single seam for secret persistence rather than touching `localStorage`
 * directly.
 *
 * Errors are swallowed downstream (reads resolve `null`, writes no-op) so a
 * storage-disabled context (private mode, blocked storage) degrades gracefully.
 */

import * as secureKvStore from './secureKvStore';

export interface SecureStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export const secureStore: SecureStore = {
  getItem: (key) => secureKvStore.getItem(key),
  setItem: (key, value) => secureKvStore.setItem(key, value),
  removeItem: (key) => secureKvStore.removeItem(key),
};
