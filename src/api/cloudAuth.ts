/**
 * Cloud sign-in via the OAuth Device Authorization Grant (RFC 8628).
 *
 * This is the editor's entry point into the DocuShark Cloud auth chain:
 * it asks `docushark-web` for a device + user code, opens the system
 * browser to the `/auth/device` verification page, and polls until the
 * user authorizes — at which point `docushark-web` returns a relay app
 * token (RS256 JWT with workspace claims) that the WS/REST layers send
 * to the relay as a Bearer.
 *
 * **Replaceable seam.** Browser launches go through `platform.opener`
 * (no direct Tauri reach); everything Cloud-auth lives behind
 * `beginCloudSignIn`. A future `platform/auth.ts` `OAuthFlow` contract will
 * adopt this module as its desktop implementation — nothing else changes.
 */

import { opener } from '../platform/opener';

/** RFC 8628 public client id for the desktop shell. */
export const DEVICE_CLIENT_ID = 'docushark-desktop';

/** RFC 8628 §3.4 grant type for the device-code token request. */
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** The relay app token + its absolute expiry (Unix ms). */
export interface CloudSignInResult {
  token: string;
  expiresAt: number;
  /** Cloud workspace display identity from the device-token response (JP-343);
   *  for the relay page. Persisted in the connection record, never the JWT claim. */
  workspaceName?: string;
  workspaceSlug?: string;
}

/**
 * A terminal sign-in failure. `code` is the RFC 8628 error
 * (`access_denied`, `expired_token`, …), `cancelled`, or an
 * `http_<status>` fallback.
 */
export class CloudAuthError extends Error {
  constructor(
    public readonly code: string,
    message?: string,
  ) {
    super(message ?? code);
    this.name = 'CloudAuthError';
  }
}

/** Injectable dependencies — defaults are production; tests override. */
export interface CloudAuthDeps {
  fetchImpl?: typeof fetch;
  openExternal?: (url: string) => void | Promise<void>;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/** In-flight handle: the codes to display now + the eventual token. */
export interface CloudSignInHandle {
  /** Human-typed code, formatted `XXXX-XXXX` (for display). */
  userCode: string;
  /** Bare verification page URL (shown so the user can open it manually). */
  verificationUri: string;
  /** Verification URL with `user_code` pre-filled (what we open). */
  verificationUriComplete: string;
  /** Resolves with the relay token, or rejects with a `CloudAuthError`. */
  result: Promise<CloudSignInResult>;
  /** Stop polling; `result` rejects with code `cancelled`. */
  cancel(): void;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  interval: number;
  expires_in: number;
}

interface DeviceTokenSuccess {
  token: string;
  jti: string;
  /** Epoch *seconds* (relay token `exp`). */
  expires_at: number;
  token_type: string;
  workspace_name?: string;
  workspace_slug?: string;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function defaultOpenExternal(url: string): Promise<void> {
  // platform.opener opens via the system browser on desktop and a new tab
  // on web (the device-code verification page).
  return opener.openExternalUrl(url);
}

/**
 * Kick off the device-code flow against `webBaseUrl` (the docushark-web
 * origin, e.g. `http://localhost:3000`). Resolves once the code is
 * issued and the browser launch has been attempted; poll for the token
 * via the returned handle's `result`.
 */
export async function beginCloudSignIn(
  webBaseUrl: string,
  deps: CloudAuthDeps = {},
): Promise<CloudSignInHandle> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const openExternal = deps.openExternal ?? defaultOpenExternal;
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  const base = webBaseUrl.replace(/\/+$/, '');

  const code = await postJson<DeviceCodeResponse>(
    fetchImpl,
    `${base}/api/v1/auth/device/code`,
    { client_id: DEVICE_CLIENT_ID },
  );

  // Best-effort browser launch. A failure here isn't fatal — the UI
  // surfaces the verification URL + code so the user can open it by hand.
  try {
    await openExternal(code.verification_uri_complete);
  } catch {
    /* ignore — user can open the URL manually */
  }

  let cancelled = false;
  const cancel = (): void => {
    cancelled = true;
  };

  const result = pollForToken({ fetchImpl, sleep, now, base, code, isCancelled: () => cancelled });

  return {
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    verificationUriComplete: code.verification_uri_complete,
    result,
    cancel,
  };
}

interface PollArgs {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  base: string;
  code: DeviceCodeResponse;
  isCancelled: () => boolean;
}

async function pollForToken(args: PollArgs): Promise<CloudSignInResult> {
  const { fetchImpl, sleep, now, base, code, isCancelled } = args;

  // Relay enforces `slow_down` from a per-row `last_polled_at`; we honor
  // the advertised interval (min 1s) and back off +5s on `slow_down`.
  let intervalMs = Math.max(1, code.interval) * 1000;
  const deadline = now() + code.expires_in * 1000;

  // The user has to switch to the browser first, so wait one interval
  // before the first poll rather than burning a guaranteed pending hit.
  await sleep(intervalMs);

  while (!isCancelled()) {
    if (now() >= deadline) {
      throw new CloudAuthError('expired_token', 'Device code expired before authorization.');
    }

    const res = await postJsonRaw(fetchImpl, `${base}/api/v1/auth/device/token`, {
      grant_type: DEVICE_GRANT_TYPE,
      device_code: code.device_code,
      client_id: DEVICE_CLIENT_ID,
    });

    if (res.ok) {
      const body = (await res.json()) as DeviceTokenSuccess;
      return {
        token: body.token,
        expiresAt: body.expires_at * 1000,
        ...(typeof body.workspace_name === 'string' ? { workspaceName: body.workspace_name } : {}),
        ...(typeof body.workspace_slug === 'string' ? { workspaceSlug: body.workspace_slug } : {}),
      };
    }

    const err = await readError(res);
    switch (err) {
      case 'authorization_pending':
        break;
      case 'slow_down':
        intervalMs += 5000;
        break;
      case 'access_denied':
        throw new CloudAuthError('access_denied', 'Authorization was denied in the browser.');
      case 'expired_token':
        throw new CloudAuthError('expired_token', 'Device code expired. Please try again.');
      default:
        throw new CloudAuthError(err, `Sign-in failed (${err}).`);
    }

    await sleep(intervalMs);
  }

  throw new CloudAuthError('cancelled', 'Sign-in cancelled.');
}

function postJsonRaw(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
): Promise<Response> {
  return fetchImpl(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify(body),
  });
}

async function postJson<T>(
  fetchImpl: typeof fetch,
  url: string,
  body: unknown,
): Promise<T> {
  const res = await postJsonRaw(fetchImpl, url, body);
  if (!res.ok) {
    const err = await readError(res);
    throw new CloudAuthError(err, `Request failed (${err}).`);
  }
  return (await res.json()) as T;
}

async function readError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (typeof body.error === 'string' && body.error.length > 0) {
      return body.error;
    }
  } catch {
    /* fall through to status-based code */
  }
  return `http_${res.status}`;
}
