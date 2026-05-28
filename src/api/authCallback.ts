/**
 * PWA web OAuth callback (JP-100) — **INERT until the docushark-web web-OAuth
 * bridge ships** (tracked as a companion issue). Gated by `AUTH_CALLBACK_ENABLED`
 * so it compiles and is unit-tested against the documented exchange contract
 * without being reachable: the web side does not yet redirect here, and today's
 * device-code sign-in remains the live path.
 *
 * Flow when enabled: a full-page redirect through docushark-web lands on
 * `/auth/callback` carrying the Supabase session (hash or query); we exchange it
 * for a relay app token via `POST /api/v1/auth/exchange`, complete sign-in via
 * the shared [[completeCloudSignIn]] path, then clean the URL.
 */

import { completeCloudSignIn } from './completeCloudSignIn';
import { loadConnection, DEFAULT_CLOUD_BASE_URL } from './relayConnection';

/** Flip to true once docushark-web ships the `/auth/callback` redirect + exchange CORS. */
export const AUTH_CALLBACK_ENABLED = false;

/** SPA path the web OAuth redirect lands on. */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/** Parsed return from the web OAuth redirect. */
export interface AuthCallbackParams {
  /** Supabase access token to exchange for a relay app token, if present. */
  accessToken: string | null;
  /** OAuth/exchange error code, if the redirect carried one. */
  error: string | null;
}

/**
 * Parse a callback URL. Supabase's redirect flows put the token in the hash
 * fragment (`#access_token=...`); errors arrive as `?error=...` or `#error=...`.
 * Pure and side-effect free.
 */
export function parseAuthCallback(url: string): AuthCallbackParams {
  let search = '';
  let hash = '';
  try {
    const parsed = new URL(url);
    search = parsed.search;
    hash = parsed.hash.startsWith('#') ? parsed.hash.slice(1) : parsed.hash;
  } catch {
    return { accessToken: null, error: 'invalid_callback_url' };
  }
  const hashParams = new URLSearchParams(hash);
  const searchParams = new URLSearchParams(search);
  return {
    accessToken: hashParams.get('access_token') ?? searchParams.get('access_token'),
    error: hashParams.get('error') ?? searchParams.get('error'),
  };
}

/** Is the given pathname the auth-callback route? */
export function isAuthCallbackRoute(pathname: string): boolean {
  return pathname === AUTH_CALLBACK_PATH;
}

/** Success payload from docushark-web `POST /api/v1/auth/exchange`. */
interface ExchangeResponse {
  token: string;
  expires_at: number; // Unix seconds
}

/** Exchange a Supabase access token for a relay app token. Throws on failure. */
async function exchangeForRelayToken(
  cloudBaseUrl: string,
  accessToken: string,
): Promise<{ token: string; expiresAt: number }> {
  const res = await fetch(`${cloudBaseUrl.replace(/\/+$/, '')}/api/v1/auth/exchange`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) throw new Error(`exchange failed: ${res.status}`);
  const data = (await res.json()) as Partial<ExchangeResponse>;
  if (typeof data.token !== 'string' || typeof data.expires_at !== 'number') {
    throw new Error('exchange returned malformed payload');
  }
  return { token: data.token, expiresAt: data.expires_at * 1000 };
}

/**
 * If we're on the auth-callback route and the feature is enabled, complete the
 * web OAuth exchange and sign-in. Returns `true` if it consumed the route (so
 * the caller can decide how to proceed). Always cleans the URL via
 * `history.replaceState` so tokens/errors don't linger in history.
 *
 * Returns `false` immediately while `AUTH_CALLBACK_ENABLED` is off.
 */
export async function handleAuthCallbackIfPresent(): Promise<boolean> {
  if (!AUTH_CALLBACK_ENABLED) return false;
  if (typeof window === 'undefined' || !isAuthCallbackRoute(window.location.pathname)) {
    return false;
  }

  const { accessToken, error } = parseAuthCallback(window.location.href);
  window.history.replaceState(null, '', '/');

  if (error || !accessToken) {
    console.warn('[authCallback] web OAuth returned no token:', error ?? 'missing access_token');
    return true;
  }

  try {
    const persisted = await loadConnection();
    const cloudBaseUrl = persisted?.cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL;
    const relayUrl = persisted?.relayUrl ?? '';
    const { token, expiresAt } = await exchangeForRelayToken(cloudBaseUrl, accessToken);
    await completeCloudSignIn({ relayUrl, cloudBaseUrl, token, expiresAt });
  } catch (err) {
    console.warn('[authCallback] exchange failed:', err);
  }
  return true;
}
