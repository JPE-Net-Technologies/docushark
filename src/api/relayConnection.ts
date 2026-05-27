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
 * once; a 401 drops it and forces a fresh sign-in. No silent retry, no
 * auto-login.
 *
 * NOTE (slice scope): the relay token is persisted via `platform.secureStore`,
 * which is `localStorage`-backed on both shells today — same durability as the
 * legacy JWT. The OS-keychain / `stronghold`-backed `secureStore` impl is the
 * deferred hardening step; routing through the seam now means that swap is
 * localized to `platform/secureStore.ts`.
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

/** Read the persisted connection, or null if none / malformed. */
export function loadConnection(): RelayConnection | null {
  try {
    const raw = secureStore.getItem(STORAGE_KEY);
    if (!raw) return null;
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
 * Persist URL + JWT. Pass `jwt: null` to record a logged-out URL. Fields
 * in `extra` (cloudBaseUrl, jwtExpiresAt) override the persisted values
 * when provided, and are otherwise preserved from the existing record —
 * so frequent token-only saves don't wipe the Cloud URL.
 */
export function saveConnection(
  relayUrl: string,
  jwt: string | null,
  extra: RelayConnectionExtra = {},
): void {
  try {
    const existing = loadConnection();
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
    secureStore.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (err) {
    console.warn('[relayConnection] Failed to persist:', err);
  }
}

/** Clear the cached JWT but keep the URLs so the form stays pre-filled. */
export function clearJwt(): void {
  const current = loadConnection();
  if (!current) return;
  saveConnection(current.relayUrl, null, {
    cloudBaseUrl: current.cloudBaseUrl,
    jwtExpiresAt: null,
  });
}

/** Wipe the entry entirely. */
export function clearConnection(): void {
  secureStore.removeItem(STORAGE_KEY);
}
