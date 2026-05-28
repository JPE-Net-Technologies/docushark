/**
 * PWA web OAuth callback (JP-100) — **inert until JP-103 ships** in
 * `docushark-web`, then flip [[AUTH_CALLBACK_ENABLED]] to true. The
 * docushark-web bridge owns the OAuth round-trip end-to-end and delivers a
 * single-use **handoff code** as `?handoff_code=…` (chosen over an
 * implicit-grant `#access_token` so PKCE stays on docushark.app and no relay
 * JWT ever lives in a URL — see Final OSS App Design §2).
 *
 * Flow when enabled:
 *   1. Land on `/auth/callback?handoff_code=…` (Supabase OAuth has already
 *      completed on `docushark.app/auth/callback`).
 *   2. POST the code to `${cloudBaseUrl}/api/v1/auth/web-handoff/consume`
 *      (CORS-enabled on the docushark-web side).
 *   3. Consume route mints + returns the relay app token; we hand it to
 *      [[completeCloudSignIn]] which reuses the device-code completion path.
 *   4. Clean the URL via `history.replaceState`.
 */

import { completeCloudSignIn } from './completeCloudSignIn';
import { loadConnection, DEFAULT_CLOUD_BASE_URL } from './relayConnection';

/** Flip to `true` once JP-103 (docushark-web web OAuth bridge) is deployed. */
export const AUTH_CALLBACK_ENABLED = false;

/** SPA path the web OAuth redirect lands on. */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/** Parsed return from the web OAuth redirect. */
export interface AuthCallbackParams {
  /** Single-use handoff code minted by docushark-web, if present. */
  handoffCode: string | null;
  /** OAuth/exchange error code, if the redirect carried one. */
  error: string | null;
}

/**
 * Parse a callback URL. The docushark-web bridge places the handoff code in
 * `?handoff_code=…`; errors arrive as `?error=…`. Pure and side-effect free.
 */
export function parseAuthCallback(url: string): AuthCallbackParams {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { handoffCode: null, error: 'invalid_callback_url' };
  }
  return {
    handoffCode: parsed.searchParams.get('handoff_code'),
    error: parsed.searchParams.get('error'),
  };
}

/** Is the given pathname the auth-callback route? */
export function isAuthCallbackRoute(pathname: string): boolean {
  return pathname === AUTH_CALLBACK_PATH;
}

/** Success payload from docushark-web `POST /api/v1/auth/web-handoff/consume`. */
interface ConsumeResponse {
  token: string;
  expires_at: number; // Unix seconds
}

/**
 * Swap the single-use handoff code for a relay app token. Throws on a non-200
 * or malformed payload — the caller logs + bails (today's "Session expired"
 * UX, since the user can retry sign-in).
 */
async function consumeHandoff(
  cloudBaseUrl: string,
  handoffCode: string,
): Promise<{ token: string; expiresAt: number }> {
  const res = await fetch(
    `${cloudBaseUrl.replace(/\/+$/, '')}/api/v1/auth/web-handoff/consume`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ handoff_code: handoffCode }),
    },
  );
  if (!res.ok) throw new Error(`handoff consume failed: ${res.status}`);
  const data = (await res.json()) as Partial<ConsumeResponse>;
  if (typeof data.token !== 'string' || typeof data.expires_at !== 'number') {
    throw new Error('handoff consume returned malformed payload');
  }
  return { token: data.token, expiresAt: data.expires_at * 1000 };
}

/**
 * If we're on the auth-callback route and the feature is enabled, complete the
 * web OAuth handoff and sign-in. Returns `true` if it consumed the route (so
 * the caller can decide how to proceed). Always cleans the URL via
 * `history.replaceState` so the handoff code doesn't linger in history.
 *
 * Returns `false` immediately while `AUTH_CALLBACK_ENABLED` is off.
 */
export async function handleAuthCallbackIfPresent(): Promise<boolean> {
  if (!AUTH_CALLBACK_ENABLED) return false;
  if (typeof window === 'undefined' || !isAuthCallbackRoute(window.location.pathname)) {
    return false;
  }

  const { handoffCode, error } = parseAuthCallback(window.location.href);
  window.history.replaceState(null, '', '/');

  if (error || !handoffCode) {
    console.warn(
      '[authCallback] web OAuth returned no handoff code:',
      error ?? 'missing handoff_code',
    );
    return true;
  }

  try {
    const persisted = await loadConnection();
    const cloudBaseUrl = persisted?.cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL;
    const relayUrl = persisted?.relayUrl ?? '';
    const { token, expiresAt } = await consumeHandoff(cloudBaseUrl, handoffCode);
    await completeCloudSignIn({ relayUrl, cloudBaseUrl, token, expiresAt });
  } catch (err) {
    console.warn('[authCallback] handoff consume failed:', err);
  }
  return true;
}
