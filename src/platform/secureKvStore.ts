/**
 * `secureKvStore` — async key→string persistence backing `platform.secureStore`
 * (today: the relay app token + connection record).
 *
 * IndexedDB-first — durable and the natural home for the relay app token on the
 * PWA — with a **localStorage fallback** when IndexedDB is unavailable (private
 * mode, the jsdom test env) so storage-disabled contexts degrade gracefully
 * rather than throwing. All errors are swallowed: reads resolve `null`, writes
 * resolve with no effect, matching the previous inline localStorage try/catch.
 *
 * Browser-only (no `@tauri-apps/*`), so the `importBoundary` rule stays intact
 * and the deferred OS-keychain / `stronghold` Tauri impl can slot behind the
 * same async interface later.
 */

const DB_NAME = 'docushark-secure';
const DB_VERSION = 1;
const STORE_NAME = 'kv';
/** Prefix for the localStorage fallback so keys can't collide with other state. */
const LS_PREFIX = 'docushark-secure:';

function idbAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;

  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onerror = () => {
      dbPromise = null;
      reject(request.error);
    };
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Out-of-line keys: the string key is passed per put/get/delete.
        db.createObjectStore(STORE_NAME);
      }
    };
  });

  return dbPromise;
}

// ============ localStorage fallback ============

function lsGet(key: string): string | null {
  try {
    return localStorage.getItem(LS_PREFIX + key);
  } catch {
    return null;
  }
}

function lsSet(key: string, value: string): void {
  try {
    localStorage.setItem(LS_PREFIX + key, value);
  } catch {
    /* ignore — storage blocked */
  }
}

function lsRemove(key: string): void {
  try {
    localStorage.removeItem(LS_PREFIX + key);
  } catch {
    /* ignore */
  }
}

// ============ Public async API ============

export async function getItem(key: string): Promise<string | null> {
  if (!idbAvailable()) return lsGet(key);
  try {
    const db = await openDB();
    return await new Promise<string | null>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(key);
      req.onerror = () => reject(req.error);
      req.onsuccess = () => resolve(typeof req.result === 'string' ? req.result : null);
    });
  } catch {
    return lsGet(key);
  }
}

export async function setItem(key: string, value: string): Promise<void> {
  if (!idbAvailable()) {
    lsSet(key, value);
    return;
  }
  try {
    const db = await openDB();
    await new Promise<void>((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put(value, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } catch {
    lsSet(key, value);
  }
}

export async function removeItem(key: string): Promise<void> {
  // Best-effort delete from both backings so a value can't linger in the
  // fallback after an IndexedDB clear (or vice versa).
  if (idbAvailable()) {
    try {
      const db = await openDB();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, 'readwrite');
        tx.objectStore(STORE_NAME).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error);
      });
    } catch {
      /* fall through to fallback cleanup */
    }
  }
  lsRemove(key);
}

/** Test-only: reset the cached DB handle so a fresh open is forced. */
export function __resetForTests(): void {
  dbPromise = null;
}
