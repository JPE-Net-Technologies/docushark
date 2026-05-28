/**
 * Persistence helper for the user's relay connection details.
 *
 * Originally Phase 20.3 Slice E.2 Commit 3. As of the Cloud sign-in
 * slice the record also carries the `docushark-web` (Cloud) base URL —
 * which pre-fills the sign-in form — and the relay token's expiry.
 *
 * Decision (carried over): only the URLs are silently re-applied on boot
 * (they pre-fill the form). The cached JWT is loaded but *not* silently
 * re-asserted — the user must click "Connect," at which point we try it
 * once; a 401 drops it and forces a fresh sign-in (or, once a token
 * refresher is registered, a silent re-exchange — see `tokenRefresh.ts`).
 *
 * JP-100: the relay token now lives in IndexedDB via `platform.secureStore`
 * (was `localStorage`). These accessors are therefore async. A one-time
 * migration moves any legacy `localStorage` record into the new store on
 * first read so already-signed-in users aren't stranded.
 */

import { secureStore } from '../platform/secureStore';

const STORAGE_KEY = 'docushark-relay-connection';

/** Default docushark-web (Cloud) origin used when none is persisted. */
export const DEFAULT_CLOUD_BASE_URL = 'http://localhost:3000';

export interface RelayConnection {
  /** Origin of the relay (e.g. `http://localhost:9876`). */
  relayUrl: string;
  /** Origin of docushark-web for Cloud sign-in (e.g. `http://localhost:3000`). */
  cloudBaseUrl: string | null;
  /** Last relay app token received from a successful sign-in, or null. */
  jwt: string | null;
  /** Absolute expiry of `jwt` in Unix ms, or null if unknown. */
  jwtExpiresAt: number | null;
}

/** Extra fields that may be merged on save without being clobbered. */
export interface RelayConnectionExtra {
  cloudBaseUrl?: string | null;
  jwtExpiresAt?: number | null;
}

function parseRecord(raw: string | null): RelayConnection | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<RelayConnection>;
    if (typeof parsed.relayUrl !== 'string') return null;
    return {
      relayUrl: parsed.relayUrl,
      cloudBaseUrl: typeof parsed.cloudBaseUrl === 'string' ? parsed.cloudBaseUrl : null,
      jwt: typeof parsed.jwt === 'string' ? parsed.jwt : null,
      jwtExpiresAt: typeof parsed.jwtExpiresAt === 'number' ? parsed.jwtExpiresAt : null,
    };
  } catch {
    return null;
  }
}

/**
 * One-time migration of the legacy `localStorage` record into the async
 * (IndexedDB-backed) `secureStore`. Runs at most once per process. Writes the
 * record into the new store and only then removes the localStorage copy, so a
 * failed write never strands a signed-in user.
 */
let migrationDone = false;
async function migrateLegacyRecord(): Promise<void> {
  if (migrationDone) return;
  migrationDone = true;
  let legacy: string | null = null;
  try {
    legacy = localStorage.getItem(STORAGE_KEY);
  } catch {
    return; // storage blocked — nothing to migrate
  }
  if (!legacy) return;
  // Only migrate if the new store doesn't already have it (avoid clobbering a
  // fresher value written via the new path).
  const existing = await secureStore.getItem(STORAGE_KEY);
  if (existing === null) {
    await secureStore.setItem(STORAGE_KEY, legacy);
  }
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* ignore — the new store already has the value */
  }
}

/** Read the persisted connection, or null if none / malformed. */
export async function loadConnection(): Promise<RelayConnection | null> {
  await migrateLegacyRecord();
  return parseRecord(await secureStore.getItem(STORAGE_KEY));
}

/**
 * Persist URL + JWT. Pass `jwt: null` to record a logged-out URL. Fields
 * in `extra` (cloudBaseUrl, jwtExpiresAt) override the persisted values
 * when provided, and are otherwise preserved from the existing record —
 * so frequent token-only saves don't wipe the Cloud URL.
 */
export async function saveConnection(
  relayUrl: string,
  jwt: string | null,
  extra: RelayConnectionExtra = {},
): Promise<void> {
  try {
    const existing = await loadConnection();
    const payload: RelayConnection = {
      relayUrl,
      jwt,
      cloudBaseUrl:
        extra.cloudBaseUrl !== undefined ? extra.cloudBaseUrl : existing?.cloudBaseUrl ?? null,
      jwtExpiresAt:
        extra.jwtExpiresAt !== undefined
          ? extra.jwtExpiresAt
          : jwt === null
            ? null
            : existing?.jwtExpiresAt ?? null,
    };
    await secureStore.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('[relayConnection] Failed to persist:', err);
  }
}

/** Clear the cached JWT but keep the URLs so the form stays pre-filled. */
export async function clearJwt(): Promise<void> {
  const current = await loadConnection();
  if (!current) return;
  await saveConnection(current.relayUrl, null, {
    cloudBaseUrl: current.cloudBaseUrl,
    jwtExpiresAt: null,
  });
}

/** Wipe the entry entirely. */
export async function clearConnection(): Promise<void> {
  await secureStore.removeItem(STORAGE_KEY);
}

/** Test-only: re-arm the one-time legacy migration. */
export function __resetMigrationForTests(): void {
  migrationDone = false;
}
