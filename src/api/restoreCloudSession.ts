/**
 * Boot auto-sign-in (Lean) — actually USE the saved relay token on app restart.
 *
 * On boot the persisted relay token (a 30-day JWT) is loaded but otherwise idle.
 * Reopening a *cloud doc* already auto-signs-in (JP-324 `chooseRelaySessionToken`
 * restores the persisted token into the WS session). This covers the other boot
 * surfaces — a local doc or the Documents home — by:
 *   1. asserting the saved token into the in-memory connection store, and
 *   2. (when asked) standing up a REST-only document provider to load the LIVE
 *      cloud doc list so Documents→Cloud is fresh on startup.
 *
 * Deliberately REST-only: NO WebSocket session, NO Y.Doc engine, NO view binding.
 * That sidesteps the JP-340/341 corruption class (the collab view-bind has no
 * doc-id guard) and the auth-timing race a placeholder WS session would hit. The
 * full live-sync session still comes up the moment the user opens a cloud doc.
 *
 * Multi-workspace (future, light): this operates on the singleton connection
 * record from `loadConnection()`. An enterprise multi-workspace variant would map
 * a `restoreCloudSessions()` over N persisted records — a mechanical lift; not
 * built here.
 */

import { loadConnection } from './relayConnection';
import { RelayClient } from './relayClient';
import { RestDocumentProvider } from './restDocumentProvider';
import { relayFetch } from '../platform/relayFetch';
import { useConnectionStore } from '../store/connectionStore';
import { useRelayDocumentStore } from '../store/relayDocumentStore';
import { useNotificationStore } from '../store/notificationStore';

export type RestoreCloudSessionStatus = 'none' | 'expired' | 'restored';

export interface RestoreCloudSessionOptions {
  /**
   * When true, proactively stand up a REST-only provider and load the live cloud
   * doc list. Pass `false` for a relay-doc boot — JP-324 Slice 1's `startSession`
   * loads the list itself (its `onAuthenticated → fetchDocumentList`), so a REST
   * provider here would just churn — and `true` for a local/no-doc boot.
   */
  proactiveList: boolean;
  /** Injectable clock for expiry checks (tests). Defaults to `Date.now`. */
  now?: () => number;
}

/**
 * Friendly "your Cloud session expired — sign in again" notice. Reused for a
 * boot-time expiry and a REST 401. Opens the relay quick-connect surface (the
 * JP-237 `docushark:open-cloud-connect` event) rather than auto-launching the
 * device-code flow — the user chooses to re-pair.
 */
export function notifyCloudSessionExpired(): void {
  useNotificationStore.getState().info(
    'Your Cloud session expired. Sign in again to reconnect your workspace.',
    {
      category: 'permanent',
      actionLabel: 'Sign in',
      onAction: () => window.dispatchEvent(new CustomEvent('docushark:open-cloud-connect')),
    },
  );
}

export async function restoreCloudSession(
  opts: RestoreCloudSessionOptions,
): Promise<{ status: RestoreCloudSessionStatus }> {
  const now = opts.now ?? Date.now;

  const conn = await loadConnection();
  if (!conn?.relayUrl || !conn.jwt) return { status: 'none' };

  // Expiry semantics match `connectionStore.isTokenValid`: a null expiry is
  // treated as "no known expiry → assume valid".
  if (conn.jwtExpiresAt !== null && now() >= conn.jwtExpiresAt) {
    return { status: 'expired' };
  }

  // The literal "the app actually uses the saved token on restart": put it into
  // the in-memory connection store so it's live immediately (and so
  // `chooseRelaySessionToken` prefers it for any subsequent relay-doc reopen).
  useConnectionStore.getState().setToken(conn.jwt, conn.jwtExpiresAt);

  // Always stand up the REST provider when the cached token is valid, so the
  // editor counts as signed in (`isCloudSignedIn()` = authenticated + provider)
  // — without this, a cached-REST boot left `authenticated` false and
  // `docProvider` null, so transferring a local doc to the workspace silently
  // no-op'd (the gate `isAuthenticated()` was false). `proactiveList` now only
  // gates the *eager list fetch*: a relay-doc boot skips it (the WS handshake
  // loads the list), a local/no-doc boot does it here.
  standUpRestProvider(conn.relayUrl, conn.jwt, { fetchList: opts.proactiveList });

  return { status: 'restored' };
}

/**
 * Stand up a REST-only document provider for a relay + token and load the live
 * cloud doc list — **no WebSocket session, no Y.Doc engine, no view binding**.
 * This is the "signed in, no doc open" state shared by boot auto-sign-in
 * (`restoreCloudSession`) and an explicit Cloud sign-in (`completeCloudSignIn`).
 * Deliberately avoids a placeholder WS session, which would emit a JOIN_DOC for
 * a doc the relay has no record of (→ ERR_UNKNOWN_DOC) and risk the
 * doc-id-guardless collab view-bind (JP-340/341). The full live-sync session
 * comes up when the user opens a cloud doc (`ensureCollabSessionForDoc`).
 *
 * Sets `authenticated` true (so `isCloudSignedIn()` is true and the transfer
 * gate passes) and, when `fetchList` is set, fires `fetchDocumentList` (+
 * stale-cache refresh, JP-324) so the live list loads. Either way it reflects
 * "the relay accepted our token" (REST-verified). The WS `connectionStore.status`
 * stays disconnected until a cloud doc is opened.
 *
 * `fetchList` defaults to `true` (an explicit Cloud sign-in wants the list now);
 * a relay-doc boot passes `false` so the WS handshake's own `onAuthenticated`
 * fetch isn't doubled.
 */
export function standUpRestProvider(
  relayUrl: string,
  token: string,
  opts: { fetchList?: boolean } = {},
): void {
  const fetchList = opts.fetchList ?? true;
  const relayStore = useRelayDocumentStore.getState();
  const client = new RelayClient({
    baseUrl: relayUrl,
    token,
    fetchImpl: relayFetch,
    onUnauthorized: () => {
      // The token was rejected — drop the REST provider and prompt a friendly
      // re-sign-in instead of failing silently.
      const s = useRelayDocumentStore.getState();
      s.setProvider(null);
      s.setAuthenticated(false);
      notifyCloudSessionExpired();
    },
  });
  relayStore.setProvider(new RestDocumentProvider(client));
  relayStore.setAuthenticated(true, { skipFetch: !fetchList });
}
