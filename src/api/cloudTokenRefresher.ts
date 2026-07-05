/**
 * Cloud sliding-token refresher (JP-420) — the concrete `TokenRefresher`
 * strategy for the seam in `tokenRefresh.ts`.
 *
 * The relay app token is a short-lived RS256 JWT with no refresh token;
 * renewal is a POST to the cloud's `/api/v1/auth/refresh` authenticated with
 * the current, still-valid token (the server re-derives all claims and
 * re-checks membership — an expired or revoked token gets a 401 and the
 * caller falls back to a full re-sign-in prompt).
 *
 * Deployment decoupling: when the cloud doesn't expose the endpoint yet
 * (404/405), that's memoized for the process so we don't re-probe on every
 * expiry tick; any other failure (401/5xx/network) just reports "couldn't
 * refresh" for this attempt.
 */
import { webClient, WebClientError } from './webClient';
import { loadConnection, saveConnection } from './relayConnection';
import { useConnectionStore } from '../store/connectionStore';
import type { RefreshedToken, TokenRefresher } from './tokenRefresh';

let refreshUnsupported = false;

/** Test-only: forget the memoized endpoint-missing probe result. */
export function __resetCloudRefresherForTests(): void {
  refreshUnsupported = false;
}

export function createCloudTokenRefresher(): TokenRefresher {
  return async (): Promise<RefreshedToken | null> => {
    if (refreshUnsupported) return null;

    const conn = await loadConnection();
    if (!conn?.cloudBaseUrl) return null;

    // Prefer the live in-memory token; fall back to the persisted one (the
    // REST-only / cold-boot state). Track whichever expiry belongs to the
    // token actually used.
    const state = useConnectionStore.getState();
    let token = state.token;
    let expiresAt = state.tokenExpiresAt;
    if (!token) {
      token = conn.jwt;
      expiresAt = conn.jwtExpiresAt;
    }
    if (!token) return null;
    // An already-expired token can't renew — the server requires a
    // currently-valid JWT. Don't waste the round-trip.
    if (expiresAt !== null && expiresAt <= Date.now()) return null;

    try {
      const r = await webClient.refreshAppToken({ token });
      const expiresAtMs = r.expiresAt * 1000; // server sends Unix seconds
      await saveConnection(r.relayUrl || conn.relayUrl, r.token, {
        jwtExpiresAt: expiresAtMs,
        ...(r.workspaceName !== null ? { workspaceName: r.workspaceName } : {}),
        ...(r.workspaceSlug !== null ? { workspaceSlug: r.workspaceSlug } : {}),
      });
      return { token: r.token, expiresAt: expiresAtMs };
    } catch (err) {
      if (err instanceof WebClientError && (err.status === 404 || err.status === 405)) {
        refreshUnsupported = true;
      }
      return null;
    }
  };
}
