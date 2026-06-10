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
 * - If no session is active, start a session from the persisted relay URL. When
 *   `connectionStore` holds a still-valid token — i.e. the user signed in this
 *   run and then left a doc (JP-190) — reconnect **with** it so reopening a
 *   relay doc is authenticated/online. Otherwise (cold boot: `connectionStore`
 *   is empty until `completeCloudSignIn` runs) start **engine-only** (no token),
 *   so offline editing works immediately without auto-asserting an on-disk
 *   token. The distinction is safe because `connectionStore` is in-memory: a
 *   non-null token there means an actual sign-in happened this session.
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

  // Already the live engine for this doc.
  if (collab.isActive && collab.config?.documentId === docId) return;

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

  // Reconnect with the live in-session token when we have a valid one (the
  // signed-in-then-left-a-doc case, JP-190) so reopening a relay doc is
  // authenticated/online; otherwise start engine-only (cold boot — no token —
  // brings up the Y.Doc + y-indexeddb + view binding without the WS provider).
  const connStore = useConnectionStore.getState();
  const token = connStore.isTokenValid() ? connStore.token : null;
  latest.startSession({
    serverUrl: restUrlToWsUrl(conn.relayUrl),
    documentId: docId,
    ...(token ? { token } : {}),
    user: { ...PLACEHOLDER_USER },
  });
}
