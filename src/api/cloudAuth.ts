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
import type { PendingSignIn } from './pendingSignIn';

/** RFC 8628 public client id for the desktop shell. */
export const DEVICE_CLIENT_ID = 'docushark-desktop';

/** RFC 8628 §3.4 grant type for the device-code token request. */
export const DEVICE_GRANT_TYPE = 'urn:ietf:params:oauth:grant-type:device_code';

/** The relay app token + its absolute expiry (Unix ms). */
export interface CloudSignInResult {
  token: string;
  expiresAt: number;
  /**
   * Region-resolved relay origin from the device-token response. The session
   * adopts this as the authoritative relay URL (it overrides the form/switcher
   * default), so a hosted sign-in always lands on the workspace's region relay
   * rather than the local-dev default. Absent on older relays.
   */
  relayUrl?: string;
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
  /** Resolves whether the browser actually opened (false = popup blocked). */
  openExternal?: (url: string) => boolean | Promise<boolean>;
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
  /**
   * The durable half of this grant (JP-455). Persist it so a page teardown
   * mid-flow can resume polling instead of stranding an authorized device.
   * `relayUrl` is filled in by the caller, which owns that choice.
   */
  grant: Omit<PendingSignIn, 'relayUrl'>;
  /**
   * True when the verification page could NOT be opened (popup blocked, or no
   * opener available), so the UI can tell the truth instead of asserting
   * "your browser should have opened".
   */
  browserOpenFailed: boolean;
  /** Resolves with the relay token, or rejects with a `CloudAuthError`. */
  result: Promise<CloudSignInResult>;
  /** Stop polling; `result` rejects with code `cancelled`. */
  cancel(): void;
}

/** Handle for a grant resumed from storage — no codes to re-display beyond the stored ones. */
export interface ResumedSignInHandle {
  result: Promise<CloudSignInResult>;
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
  /** Region-resolved relay origin (docushark-web computes it from the workspace). */
  relay_url?: string;
  workspace_name?: string;
  workspace_slug?: string;
}

/**
 * Minimum of a wait that must elapse before a tab-return may cut it short.
 * Without it, flicking between tabs would fire a poll per switch and trip the
 * relay's `slow_down` backoff — making the flow slower, not faster.
 */
const WAKE_MIN_ELAPSED_MS = 1_000;

/**
 * Sleep that ends early when the tab becomes visible again (JP-455).
 *
 * A backgrounded page can have its timers throttled (Chrome aligns them to ~1
 * minute after ~5 minutes hidden), so a user returning from the verification
 * page could sit in front of an "awaiting" panel whose next poll is far away.
 * Waking on `visibilitychange` collapses that to the moment they come back.
 *
 * Only `visibilitychange` is observed — not `focus` — so one tab return
 * produces one wake rather than the double-fire `connectionWakeWatcher` has to
 * throttle away.
 */
const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    if (typeof document === 'undefined') {
      setTimeout(resolve, ms);
      return;
    }
    const startedAt = Date.now();
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      resolve();
    };
    const onVisibilityChange = (): void => {
      if (
        document.visibilityState === 'visible' &&
        Date.now() - startedAt >= WAKE_MIN_ELAPSED_MS
      ) {
        finish();
      }
    };
    const timer = setTimeout(finish, ms);
    document.addEventListener('visibilitychange', onVisibilityChange);
  });

function defaultOpenExternal(url: string): Promise<boolean> {
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

  // Best-effort browser launch. A failure here isn't fatal — the UI surfaces
  // the verification URL + code so the user can open it by hand — but we do
  // report it, so the panel can say so instead of asserting the browser opened.
  let browserOpenFailed = false;
  try {
    browserOpenFailed = (await openExternal(code.verification_uri_complete)) === false;
  } catch {
    browserOpenFailed = true;
  }

  const grant = {
    deviceCode: code.device_code,
    userCode: code.user_code,
    verificationUri: code.verification_uri_complete,
    intervalMs: Math.max(1, code.interval) * 1000,
    expiresAt: now() + code.expires_in * 1000,
    cloudBaseUrl: base,
  };

  const { result, cancel } = startPoll({ fetchImpl, sleep, now, grant });

  return {
    userCode: code.user_code,
    verificationUri: code.verification_uri,
    verificationUriComplete: code.verification_uri_complete,
    grant,
    browserOpenFailed,
    result,
    cancel,
  };
}

/**
 * Resume polling a grant that was issued earlier and persisted (JP-455) — the
 * path that keeps the authorize page's "it will finish signing in
 * automatically" promise across a page teardown.
 *
 * Unlike `beginCloudSignIn` this opens no browser and requests no new code: the
 * user has already been sent to the verification page, and may well have
 * authorized while the editor was gone. It therefore polls **immediately**
 * rather than waiting out an interval first.
 */
export function resumeCloudSignIn(
  grant: Omit<PendingSignIn, 'relayUrl'>,
  deps: CloudAuthDeps = {},
): ResumedSignInHandle {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const sleep = deps.sleep ?? defaultSleep;
  const now = deps.now ?? Date.now;
  return startPoll({ fetchImpl, sleep, now, grant, pollImmediately: true });
}

interface StartPollArgs {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  grant: Omit<PendingSignIn, 'relayUrl'>;
  /** Skip the leading interval — used when resuming an already-issued grant. */
  pollImmediately?: boolean;
}

/** Shared plumbing: run the poll loop behind a cancel flag. */
function startPoll(args: StartPollArgs): ResumedSignInHandle {
  let cancelled = false;
  const result = pollForToken({
    fetchImpl: args.fetchImpl,
    sleep: args.sleep,
    now: args.now,
    grant: args.grant,
    pollImmediately: args.pollImmediately ?? false,
    isCancelled: () => cancelled,
  });
  return {
    result,
    cancel: () => {
      cancelled = true;
    },
  };
}

interface PollArgs {
  fetchImpl: typeof fetch;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  grant: Omit<PendingSignIn, 'relayUrl'>;
  /** Poll before the first sleep (a resumed grant may already be authorized). */
  pollImmediately: boolean;
  isCancelled: () => boolean;
}

async function pollForToken(args: PollArgs): Promise<CloudSignInResult> {
  const { fetchImpl, sleep, now, grant, pollImmediately, isCancelled } = args;
  const base = grant.cloudBaseUrl;

  // Relay enforces `slow_down` from a per-row `last_polled_at`; we honor
  // the advertised interval (min 1s) and back off +5s on `slow_down`.
  let intervalMs = grant.intervalMs;

  // On a fresh grant the user has to switch to the browser first, so wait one
  // interval rather than burning a guaranteed pending hit. A *resumed* grant
  // skips that: the authorization may already have happened while we were gone,
  // and making the user wait an extra interval for a token that is sitting there
  // is the exact "why isn't it connecting?" feeling this work exists to remove.
  if (!pollImmediately) {
    await sleep(intervalMs);
  }

  while (!isCancelled()) {
    if (now() >= grant.expiresAt) {
      throw new CloudAuthError('expired_token', 'Device code expired before authorization.');
    }

    const res = await postJsonRaw(fetchImpl, `${base}/api/v1/auth/device/token`, {
      grant_type: DEVICE_GRANT_TYPE,
      device_code: grant.deviceCode,
      client_id: DEVICE_CLIENT_ID,
    });

    if (res.ok) {
      const body = (await res.json()) as DeviceTokenSuccess;
      return {
        token: body.token,
        expiresAt: body.expires_at * 1000,
        ...(typeof body.relay_url === 'string' ? { relayUrl: body.relay_url } : {}),
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
