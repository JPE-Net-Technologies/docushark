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
 * - If no session is active, start an **engine-only** session (no token) from
 *   the persisted relay URL, so offline editing works immediately. We do NOT
 *   auto-assert a saved token here — connecting stays an explicit user action;
 *   `completeCloudSignIn` restarts this session with the token when they do.
 *
 * Callers must only pass relay-backed doc ids; local-only docs are
 * renderer-owned and never get an engine (guarded here as a safety net).
 */
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
  if (record?.type === 'local') return;

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

  // Engine-only start: no token, so `startSession` brings up the Y.Doc +
  // `y-indexeddb` + view binding without attaching the WS provider.
  latest.startSession({
    serverUrl: restUrlToWsUrl(conn.relayUrl),
    documentId: docId,
    user: { ...PLACEHOLDER_USER },
  });
}
