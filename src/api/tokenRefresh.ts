/**
 * Token refresh seam (JP-100).
 *
 * The relay app token is a 30-day RS256 JWT with **no refresh token** — a
 * "refresh" means re-running the `docushark-web` exchange against a still-valid
 * Supabase session. That session only exists on the (deferred) PWA web-OAuth
 * path, so this module ships the *plumbing* now and registers no concrete
 * strategy yet: with no refresher registered, `attemptTokenRefresh()` resolves
 * `false` and callers fall back to today's behavior (drop the session + prompt
 * re-auth). The web bridge wires a real `TokenRefresher` later.
 */

import { useConnectionStore } from '../store/connectionStore';

/** A fresh relay app token + its absolute expiry (Unix ms), or unknown expiry. */
export interface RefreshedToken {
  token: string;
  expiresAt: number | null;
}

/**
 * Pluggable strategy that silently obtains a fresh relay app token. Returns the
 * new token, or `null` when it can't refresh (no live session, network error).
 */
export type TokenRefresher = () => Promise<RefreshedToken | null>;

let refresher: TokenRefresher | null = null;
let inFlight: Promise<boolean> | null = null;

/** Register (or clear, with `null`) the silent-refresh strategy. */
export function registerTokenRefresher(fn: TokenRefresher | null): void {
  refresher = fn;
}

/**
 * Attempt a single-flight token refresh. Concurrent callers (e.g. a 401 and the
 * expiry timer firing together) share one in-flight attempt. On success the new
 * token is committed to `connectionStore` and `true` is returned; with no
 * refresher registered — or on failure — returns `false` and leaves state
 * untouched.
 */
export function attemptTokenRefresh(): Promise<boolean> {
  if (inFlight) return inFlight;
  if (!refresher) return Promise.resolve(false);

  const run = refresher;
  inFlight = (async () => {
    try {
      const result = await run();
      if (!result) return false;
      useConnectionStore.getState().setToken(result.token, result.expiresAt);
      return true;
    } catch {
      return false;
    } finally {
      inFlight = null;
    }
  })();
  return inFlight;
}

/** Test-only: clear the registered refresher and any in-flight attempt. */
export function __resetForTests(): void {
  refresher = null;
  inFlight = null;
}
