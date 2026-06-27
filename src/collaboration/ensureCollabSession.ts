/**
 * Idempotent doc-open activation of the local CRDT engine (JP-108 step 3,
 * Stage 2 — "the Y.Doc is the source of truth").
 *
 * The collaboration session used to be created only on an explicit Cloud
 * sign-in (`completeCloudSignIn`). That made the Y.Doc a transient sync layer:
 * a doc opened offline had no engine, so anything typed before connecting was
 * adopted-clobbered on the first sync. This inverts the model — whenever a
 * *relay* document becomes the active doc we bring up its **engine** (Y.Doc +
 * `y-indexeddb` + the view binding), regardless of connectivity. Edits are CRDT
 * ops from the first keystroke and persist locally; the WS provider attaches
 * later (on sign-in, which restarts the session *with* a token onto the same
 * `y-indexeddb` room) and merges via the normal Yjs handshake.
 *
 * The engine never depends on the network — `collaborationStore.startSession`
 * only attaches the provider when a token is present, so a token-less start is
 * engine-only (no "not syncing" toast).
 */

import { useCollaborationStore } from './collaborationStore';
import { isOfflineFirstEngineEnabled } from './offlineFirstEngine';
import { useDocumentRegistry } from '../store/documentRegistry';
import { useConnectionStore } from '../store/connectionStore';
import { loadConnection } from '../api/relayConnection';
import { restUrlToWsUrl } from '../api/completeCloudSignIn';

/**
 * Placeholder awareness identity used until the provider authenticates and
 * `onAuthenticated` adopts the token's `sub` (awareness only matters once
 * connected, so a placeholder is harmless offline).
 */
const PLACEHOLDER_USER = { id: 'pending', name: 'You', color: '#4a90d9' };

/**
 * Ensure the local CRDT engine is live for `docId` (a relay-backed document).
 *
 * - No-op if a session is already active for this exact doc (so it's safe to
 *   call on every doc-open path, including the on-connect reattach which loads
 *   the doc that's already the session's target — avoids tearing down the
 *   provider whose callback is running).
 * - If a session is active for a *different* doc, switch to this one (a per-doc
 *   engine restart that re-keys the `y-indexeddb` room — see
 *   `collaborationStore.switchDocument`), preserving the live token so an online
 *   collaborator stays connected across the switch.
 * - If no session is active, start a session from the persisted relay URL with
 *   the best available token (JP-324):
 *     1. the live in-memory token when still valid — the user signed in this run
 *        and then left a doc (JP-190); or
 *     2. the **persisted** token from `loadConnection()` when it's still
 *        unexpired — a cold boot where `connectionStore` is empty but a prior
 *        sign-in's token survives on disk. Restoring it means reopening a relay
 *        doc on startup is authenticated/online (and the REST doc-list loads)
 *        instead of forcing a fresh sign-in every launch.
 *   When neither is available (no token / expired), start **engine-only** so
 *   offline editing still works immediately. A restored token is asserted back
 *   into `connectionStore` after `startSession` so the auth/expiry/REST paths
 *   stay coherent (mirrors `completeCloudSignIn`).
 *
 * Callers must only pass relay-backed doc ids; local-only docs are
 * renderer-owned and never get an engine (guarded here as a safety net).
 */
/**
 * Purge a document's local prose CRDT room (the `host:docId` y-indexeddb DB) so a
 * subsequent (re)join adopts the relay's authoritative state instead of merging a
 * stale copy.
 *
 * Used on the **promote-to-Cloud boundary**: a doc previously moved Cloud→Personal
 * keeps its room on disk (leaveDocument/stopSession close the connection but leave
 * the data — it's the durability store), so on re-promote the client reloads that
 * stale prose while the relay re-seeds the same prose fresh from `richTextPages`
 * (`json_prose_to_ydoc`) — a different CRDT lineage. The two merge and duplicate
 * every page (JP-282). Purging first makes the client start empty and adopt.
 *
 * Safe: `richTextPages` is the durable prose source (the relay re-seeds from it),
 * and a local doc has no live engine, so its room isn't open. No-op when there's
 * no relay configured or the room doesn't exist. Best-effort on error/blocked.
 */
export async function purgeLocalDocRoom(docId: string): Promise<void> {
  if (!docId || typeof indexedDB === 'undefined') return;
  const conn = await loadConnection();
  if (!conn?.relayUrl) return;
  let host: string;
  try {
    // The y-indexeddb room key is `${wsUrlHost}:${docId}`; the WS host equals the
    // REST host (restUrlToWsUrl only swaps the scheme), so derive it from relayUrl.
    host = new URL(conn.relayUrl).host;
  } catch {
    return;
  }
  await new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(`${host}:${docId}`);
    req.onsuccess = () => resolve();
    req.onerror = () => resolve();
    req.onblocked = () => resolve();
  });
}

export async function ensureCollabSessionForDoc(docId: string): Promise<void> {
  if (!docId) return;

  const collab = useCollaborationStore.getState();

  // Already the live engine for this doc. If it came up engine-only (no WS provider —
  // started before a token was available, e.g. an expired-session boot) and a valid
  // token is now available — the user just signed in (JP-392) — force-restart it WITH
  // the token so the provider attaches, instead of leaving the active doc offline
  // until a manual doc switch. switchDocument re-keys the same `host:docId` room and
  // carries the freshest connectionStore token. Otherwise no-op: an already-online
  // session must not be torn down here (the on-connect reattach calls this for the
  // doc whose provider callback is running).
  const active = collab.config;
  if (collab.isActive && active && active.documentId === docId) {
    const conn = useConnectionStore.getState();
    if (!active.token && conn.token && conn.isTokenValid()) {
      collab.switchDocument(docId);
    }
    return;
  }

  // A local-only doc must never get a CRDT engine (it would emit a JOIN_DOC the
  // relay rejects, and risks a cross-client leak — see JP-64). Unknown records
  // are allowed through: the caller vouches it's a relay doc, and the registry
  // may not have caught up on a cold offline boot.
  const record = useDocumentRegistry.getState().getRecord(docId);
  if (record?.type === 'local') {
    // Reaching here with a live session means we've left a relay doc for a
    // local one — leave the doc so it stops broadcasting and the presence frame
    // clears, but stay signed in to the relay (JP-188/JP-190). Defense for any
    // caller that routes a local doc through here; the primary cut is in
    // `persistenceStore.loadDocument`.
    if (collab.isActive) collab.leaveDocument();
    return;
  }

  // A session is live for another doc — switch the engine to this one, carrying
  // the freshest token (connectionStore is updated by the auth path / refresh;
  // fall back to the config's original). This force-restarts even if the new id
  // equals the current (callers gate that with the no-op above).
  if (collab.isActive && collab.config) {
    collab.switchDocument(docId);
    return;
  }

  // Cold start. The kill-switch only gates *starting an engine where none was
  // running* — the switch path above stays correct either way.
  if (!isOfflineFirstEngineEnabled()) return;

  const conn = await loadConnection();
  if (!conn?.relayUrl) return; // No relay configured — leave the doc on the local path.

  // Another path may have started a session while we awaited `loadConnection`.
  const latest = useCollaborationStore.getState();
  if (latest.isActive) {
    if (latest.config?.documentId !== docId) latest.switchDocument(docId);
    return;
  }

  // Pick the session token: live in-memory first (signed-in-then-left, JP-190),
  // else the still-valid persisted token (cold-boot restore, JP-324). Engine-only
  // when neither is available — brings up the Y.Doc + y-indexeddb + view binding
  // without the WS provider.
  const connStore = useConnectionStore.getState();
  const { token, expiresAt, restoredFromDisk } = chooseRelaySessionToken(
    { token: connStore.token, expiresAt: connStore.tokenExpiresAt, valid: connStore.isTokenValid() },
    { jwt: conn.jwt, jwtExpiresAt: conn.jwtExpiresAt },
    Date.now(),
  );

  latest.startSession({
    serverUrl: restUrlToWsUrl(conn.relayUrl),
    documentId: docId,
    ...(token ? { token } : {}),
    user: { ...PLACEHOLDER_USER },
  });

  // Re-assert a disk-restored token into connectionStore so the token-expiry
  // monitor and REST sync subscription read a coherent value. The session's REST
  // client is seeded from `config.token` directly; this keeps the store in sync.
  // Safe to set after startSession: a cold-start start (nothing was active) does
  // NOT reset the store, so the assertion sticks — mirroring completeCloudSignIn.
  if (restoredFromDisk && token) {
    useConnectionStore.getState().setToken(token, expiresAt);
  }
}

/**
 * Choose the token a (re)started relay session should use, given the in-memory
 * connection state and the persisted connection record. Pure so it can be unit
 * tested without the stores.
 *
 * - A valid in-memory token wins (the user signed in this run; JP-190).
 * - Otherwise fall back to a persisted token that hasn't expired (cold-boot
 *   restore; JP-324) and flag it so the caller re-asserts it into the store.
 * - A null/expired token in both yields an engine-only start.
 *
 * Expiry semantics match `connectionStore.isTokenValid`: a null expiry is
 * treated as "no known expiry → assume valid".
 */
export function chooseRelaySessionToken(
  inMemory: { token: string | null; expiresAt: number | null; valid: boolean },
  persisted: { jwt: string | null; jwtExpiresAt: number | null },
  now: number,
): { token: string | null; expiresAt: number | null; restoredFromDisk: boolean } {
  if (inMemory.valid && inMemory.token) {
    return { token: inMemory.token, expiresAt: inMemory.expiresAt, restoredFromDisk: false };
  }
  if (persisted.jwt && (persisted.jwtExpiresAt === null || now < persisted.jwtExpiresAt)) {
    return { token: persisted.jwt, expiresAt: persisted.jwtExpiresAt, restoredFromDisk: true };
  }
  return { token: null, expiresAt: null, restoredFromDisk: false };
}
