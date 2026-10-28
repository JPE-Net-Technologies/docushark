/**
 * PWA web OAuth callback. The `docushark-web` bridge owns the OAuth round-trip
 * end-to-end and delivers a single-use **handoff code** as `?handoff_code=…`
 * (chosen over an implicit-grant `#access_token` so PKCE stays on docushark.app
 * and no relay JWT ever lives in a URL — see Final OSS App Design §2).
 *
 * Flow:
 *   1. Land on `/auth/callback?handoff_code=…` (Supabase OAuth has already
 *      completed on `docushark.app/auth/callback`).
 *   2. POST the code to `${cloudBaseUrl}/api/v1/auth/web-handoff/consume`
 *      (CORS-enabled on the docushark-web side).
 *   3. The consume route mints + returns the relay app token **and** the relay
 *      URL for the user's primary workspace (region resolved server-side — the
 *      editor never decodes the JWT). We hand both to [[completeCloudSignIn]],
 *      which reuses the device-code completion path. This makes the *first-time*
 *      user case work: there's no persisted relay URL to fall back on.
 *   4. Clean the URL via `history.replaceState`.
 */

import { completeCloudSignIn } from './completeCloudSignIn';
import { loadConnection, DEFAULT_CLOUD_BASE_URL } from './relayConnection';
import { showStorageInfoToastOnce } from './storageInfoToast';

/**
 * The web one-click handoff is live (docushark-web bridge deployed). The
 * `cloudBaseUrl` the consume call targets comes from [[DEFAULT_CLOUD_BASE_URL]]
 * (build-time `VITE_CLOUD_BASE_URL`) when no connection is yet persisted.
 */
export const AUTH_CALLBACK_ENABLED = true;

/** SPA path the web OAuth redirect lands on. */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/** A page to import once signed in, from the account site's "Import a page" (DSK-194). */
export interface ImportIntent {
  provider: string;
  externalId: string;
  /** The workspace whose card the page was chosen on (`?ws=`). A hand-off opens
   *  the user's primary workspace, so the import refuses to run in another. */
  workspaceId?: string;
}

/** Parsed return from the web OAuth redirect. */
export interface AuthCallbackParams {
  /** Single-use handoff code minted by docushark-web, if present. */
  handoffCode: string | null;
  /** OAuth/exchange error code, if the redirect carried one. */
  error: string | null;
  /** `?import=<provider>:<externalId>` (and `?ws=`), when the hand-off carries an import. */
  importIntent: ImportIntent | null;
}

/**
 * Parse `<provider>:<externalId>`. Strict, since it comes from a URL: a provider
 * id is lowercase letters, digits and dashes, and an id is word characters and
 * dashes (a Notion page id, with or without its dashes). Anything else is no
 * intent at all.
 */
export function parseImportIntent(value: string | null): ImportIntent | null {
  if (!value) return null;
  const sep = value.indexOf(':');
  const provider = value.slice(0, sep);
  const externalId = value.slice(sep + 1);
  if (sep <= 0 || !/^[a-z][a-z0-9-]{0,31}$/.test(provider) || !/^[\w-]{1,200}$/.test(externalId)) return null;
  return { provider, externalId };
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
    return { handoffCode: null, error: 'invalid_callback_url', importIntent: null };
  }
  return {
    handoffCode: parsed.searchParams.get('handoff_code'),
    error: parsed.searchParams.get('error'),
    importIntent: withWorkspace(parseImportIntent(parsed.searchParams.get('import')), parsed.searchParams.get('ws')),
  };
}

/** Attach a well-formed `ws` to an intent; a malformed one drops the whole intent. */
function withWorkspace(intent: ImportIntent | null, ws: string | null): ImportIntent | null {
  if (!intent || ws === null) return intent;
  return /^[\w-]{1,64}$/.test(ws) ? { ...intent, workspaceId: ws } : null;
}

/** Is the given pathname the auth-callback route? */
export function isAuthCallbackRoute(pathname: string): boolean {
  return pathname === AUTH_CALLBACK_PATH;
}

/** Success payload from docushark-web `POST /api/v1/auth/web-handoff/consume`. */
interface ConsumeResponse {
  token: string;
  expires_at: number; // Unix seconds
  relay_url: string; // relay pod for the user's primary workspace
  workspace_name?: string; // display name for the relay page (JP-343)
  workspace_slug?: string; // space.docushark.app/<slug>
}

/**
 * Swap the single-use handoff code for a relay app token + the relay URL to
 * connect it to. Throws on a non-200 or malformed payload — the caller logs +
 * bails (today's "Session expired" UX, since the user can retry sign-in).
 */
async function consumeHandoff(
  cloudBaseUrl: string,
  handoffCode: string,
): Promise<{
  token: string;
  expiresAt: number;
  relayUrl: string;
  workspaceName?: string;
  workspaceSlug?: string;
}> {
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
  if (
    typeof data.token !== 'string' ||
    typeof data.expires_at !== 'number' ||
    typeof data.relay_url !== 'string'
  ) {
    throw new Error('handoff consume returned malformed payload');
  }
  return {
    token: data.token,
    expiresAt: data.expires_at * 1000,
    relayUrl: data.relay_url,
    ...(typeof data.workspace_name === 'string' ? { workspaceName: data.workspace_name } : {}),
    ...(typeof data.workspace_slug === 'string' ? { workspaceSlug: data.workspace_slug } : {}),
  };
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

  const { handoffCode, error, importIntent } = parseAuthCallback(window.location.href);
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
    // The relay URL comes from the consume response (region resolved by
    // docushark-web), not the persisted record — a first-time user has none.
    const { token, expiresAt, relayUrl, workspaceName, workspaceSlug } = await consumeHandoff(
      cloudBaseUrl,
      handoffCode,
    );
    await completeCloudSignIn({
      relayUrl,
      cloudBaseUrl,
      token,
      expiresAt,
      ...(workspaceName !== undefined ? { workspaceName } : {}),
      ...(workspaceSlug !== undefined ? { workspaceSlug } : {}),
    });
    // First-connect explainer of the storage model (once per browser).
    showStorageInfoToastOnce();
    if (importIntent) void runImportIntent(importIntent);
  } catch (err) {
    console.warn('[authCallback] handoff consume failed:', err);
  }
  return true;
}

/** How long a fresh sign-in gets to reach the workspace before an import gives up. */
const RELAY_READY_TIMEOUT_MS = 20_000;

/**
 * Run the account site's "Import a page" here (DSK-194): the page becomes a new
 * workspace document, exactly as the document browser's New > From <provider>
 * makes one. It runs only after a hand-off has signed this editor in, and the
 * code is single-use and minted for the signed-in user, so a crafted link
 * cannot start an import on its own.
 */
async function runImportIntent(intent: ImportIntent): Promise<void> {
  const [{ useNotificationStore }, { isRelayAuthenticated }, { importAsNewDocument }, { activeWorkspaceId }] =
    await Promise.all([
      import('../store/notificationStore'),
      import('../store/connectionStore'),
      import('../services/mirrorPageService'),
      import('../store/activeWorkspace'),
    ]);
  const notifications = useNotificationStore.getState();
  try {
    const started = Date.now();
    while (!isRelayAuthenticated()) {
      if (Date.now() - started > RELAY_READY_TIMEOUT_MS) {
        throw new Error("Signed in, but your workspace didn't answer in time, so the page was not imported.");
      }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (intent.workspaceId && intent.workspaceId !== activeWorkspaceId()) {
      throw new Error(
        'That page was chosen for another workspace. Switch to it here, then use New > From the source to import it.',
      );
    }
    const { pageId, warnings } = await importAsNewDocument(intent.provider, intent.externalId);
    const { useRichTextPagesStore } = await import('../store/richTextPagesStore');
    const name = useRichTextPagesStore.getState().pages[pageId]?.name ?? 'the page';
    const dropped = warnings.reduce((n, w) => n + (w.count ?? 1), 0);
    notifications.success(
      dropped > 0
        ? `Imported "${name}" as a new document — ${dropped} element(s) could not be mirrored`
        : `Imported "${name}" as a new document`,
    );
  } catch (err) {
    notifications.error(err instanceof Error ? err.message : 'Could not import the page.');
  }
}
