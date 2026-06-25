/**
 * Switch the active Cloud workspace (JP-370).
 *
 * The editor holds ONE live relay connection at a time (a WS is expensive — we
 * never run two). Switching = re-scope the relay token to the target workspace,
 * tear the current session down, then stand the new one up REST-only. The doc
 * browser is workspace-scoped (documentRegistry filters by the active
 * workspace), so the target's documents appear and the previous workspace's
 * disappear without clearing anything — switching back is instant.
 *
 * The workspace list itself comes from `webClient.listWorkspaces()`; this just
 * performs the activation.
 */
import { useCollaborationStore } from '../collaboration/collaborationStore';
import { usePersistenceStore } from '../store/persistenceStore';
import { useDocumentRegistry } from '../store/documentRegistry';
import { activeWorkspaceId } from '../store/activeWorkspace';
import { loadConnection, DEFAULT_CLOUD_BASE_URL } from '../api/relayConnection';
import { completeCloudSignIn } from '../api/completeCloudSignIn';
import { webClient } from '../api/webClient';

/**
 * Activate `workspaceId`. No-op if it's already the active workspace. Throws
 * (WebClientError) if the token re-scope fails — the caller surfaces it; the
 * existing session is left intact because teardown happens only after the token
 * is in hand.
 */
export async function switchWorkspace(workspaceId: string): Promise<void> {
  if (workspaceId === activeWorkspaceId()) return;

  // 1. Re-scope the relay token to the target FIRST. If this throws (network /
  //    not-a-member), we haven't touched the live session yet.
  const wt = await webClient.getWorkspaceToken(workspaceId);
  const conn = await loadConnection();

  // 2. If a relay doc is open, leave it — it belongs to the workspace we're
  //    leaving and must not linger in the editor against the new workspace.
  const currentDocId = usePersistenceStore.getState().currentDocumentId;
  const currentRecord = currentDocId
    ? useDocumentRegistry.getState().getRecord(currentDocId)
    : undefined;
  const wasViewingRelayDoc =
    !!currentRecord && (currentRecord.type === 'remote' || currentRecord.type === 'cached');

  // 3. Tear down the current live session (drops the single WS + relay auth) —
  //    one WS at a time.
  useCollaborationStore.getState().stopSession();
  if (wasViewingRelayDoc) {
    // Reset the editor to a blank local doc so we're not showing a document
    // from the workspace we just left.
    usePersistenceStore.getState().newDocument();
  }

  // 4. Stand the target up REST-only: persists the connection (token + relay pod
  //    + display identity for THIS workspace) and refetches its doc list. No
  //    documentId → no WS session until the user opens a doc. The web returns
  //    `expiresAt` in seconds; the connection record stores Unix ms (matches the
  //    device-code path's `expires_at * 1000`).
  await completeCloudSignIn({
    relayUrl: wt.relayUrl,
    cloudBaseUrl: conn?.cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL,
    token: wt.token,
    expiresAt: wt.expiresAt * 1000,
    workspaceName: wt.workspaceName,
    workspaceSlug: wt.workspaceSlug,
  });
}
