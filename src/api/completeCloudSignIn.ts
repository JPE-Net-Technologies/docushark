/**
 * Shared tail of a successful Cloud sign-in: persist the connection record,
 * commit the relay app token, and establish the **REST-only** signed-in state
 * (token + live cloud doc list).
 *
 * It deliberately does NOT start a WebSocket collab session. Sign-in's job is
 * connect → authenticate → load the doc list — not open a document. A
 * placeholder session would emit a `JOIN_DOC` for a doc the relay has no record
 * of (→ `ERR_UNKNOWN_DOC`, a scary WS error + toasts) and risk the
 * doc-id-guardless collab view-bind (JP-340/341). The live-sync session for a
 * specific doc comes up via `ensureCollabSessionForDoc` — invoked here only for a
 * confirmed relay doc the caller was already viewing.
 *
 * Shared by the device-code flow (`CloudConnectPanel`) and the web `/auth/callback`
 * handoff (`authCallback`) so both drive the same proven path
 * (mirrors `restoreCloudSession`'s REST-only boot sign-in).
 */

import { useConnectionStore } from '../store/connectionStore';
import { useDocumentRegistry } from '../store/documentRegistry';
import { saveConnection } from './relayConnection';
import { standUpRestProvider } from './restoreCloudSession';

/** Convert a REST origin (http://host:port) to the matching WS URL (ws://host:port/ws). */
export function restUrlToWsUrl(restUrl: string): string {
  return restUrl
    .replace(/\/+$/, '')
    .replace(/^http:\/\//, 'ws://')
    .replace(/^https:\/\//, 'wss://')
    .concat('/ws');
}

export interface CompleteCloudSignInArgs {
  /** Relay REST origin, e.g. `http://localhost:9876`. */
  relayUrl: string;
  /** docushark-web origin — persisted so it pre-fills the sign-in form next time. */
  cloudBaseUrl: string;
  /** Relay app token (RS256 JWT). */
  token: string;
  /** Absolute token expiry (Unix ms), or null if unknown. */
  expiresAt: number | null;
  /**
   * The doc the user is currently viewing, if any. Its live session is opened
   * ONLY when it's a known relay doc (`remote`/`cached`); a local/scratch/unknown
   * id stays REST-only (no WS JOIN). Omit for a plain sign-in.
   */
  documentId?: string | null;
  /**
   * Cloud workspace display name + slug from the sign-in response (JP-343), for
   * the relay page. Persisted in the connection record, never in the JWT claim.
   * Omit on the cached-key-reuse path — `saveConnection` preserves the prior values.
   */
  workspaceName?: string | null;
  workspaceSlug?: string | null;
}

export async function completeCloudSignIn(args: CompleteCloudSignInArgs): Promise<void> {
  const { relayUrl, cloudBaseUrl, token, expiresAt, documentId, workspaceName, workspaceSlug } = args;

  // Persist URLs + token (+ workspace display identity), then assert the token
  // into the in-memory connection store so the token-expiry monitor + any later
  // relay-doc reopen read it. Pass workspace name/slug only when present so the
  // cached-reuse path doesn't clobber previously-persisted values.
  await saveConnection(relayUrl, token, {
    cloudBaseUrl,
    jwtExpiresAt: expiresAt,
    ...(workspaceName !== undefined ? { workspaceName } : {}),
    ...(workspaceSlug !== undefined ? { workspaceSlug } : {}),
  });
  useConnectionStore.getState().setToken(token, expiresAt);

  // REST-only signed-in state: token + live cloud doc list. No WS session, no
  // Y.Doc engine, no view binding — so no phantom JOIN_DOC and no view-bind risk.
  standUpRestProvider(relayUrl, token);

  // If the user was already viewing a relay doc, bring its live session up now —
  // correctly gated (local/unknown ids never get a CRDT engine, JP-64). This is
  // the only path that opens a WS session at sign-in, and only for a real relay
  // doc. Lazy import avoids a module cycle (ensureCollabSession imports
  // `restUrlToWsUrl` from here).
  if (documentId) {
    const record = useDocumentRegistry.getState().getRecord(documentId);
    // A live collab engine for this exact doc also makes it a confirmed relay doc:
    // the engine only ever exists for relay docs (local docs never get one, JP-64),
    // and an expired-session boot brings the active doc up engine-only BEFORE its
    // registry record loads (warmupCache stores content, not a record; the REST list
    // re-fetch is async). Without this the active doc stayed offline until a manual
    // doc switch (JP-392). Lazy import mirrors the ensureCollabSession import below.
    const { useCollaborationStore } = await import('../collaboration/collaborationStore');
    const collab = useCollaborationStore.getState();
    const engineLiveForDoc = collab.isActive && collab.config?.documentId === documentId;
    const knownRelayDoc = record !== undefined && (record.type === 'remote' || record.type === 'cached');
    if (engineLiveForDoc || knownRelayDoc) {
      const { ensureCollabSessionForDoc } = await import('../collaboration/ensureCollabSession');
      await ensureCollabSessionForDoc(documentId);
    }
  }
}
