/**
 * Hard-remove the current relay workspace (JP-237).
 *
 * The destructive counterpart to Disconnect: where Disconnect is the *soft* path
 * (stays signed out but keeps cached team docs browsable offline), Remove
 * Workspace means the user wants this relay and its local footprint GONE. It
 * tears down the live session, purges the host's registry entries + durable
 * offline copies + local CRDT rooms, and forgets the persisted connection.
 *
 * Everything is scoped to the host/`relayId`, so when connection management grows
 * to multiple concurrent workspaces this removes only the targeted relay.
 */
import { useConnectionStore } from '../store/connectionStore';
import { useCollaborationStore } from '../collaboration/collaborationStore';
import { useDocumentRegistry } from '../store/documentRegistry';
import { RelayDocumentCache } from '../storage/RelayDocumentCache';
import { activeWorkspaceId, clearRememberedWorkspaceId } from '../store/activeWorkspace';
import { purgeLocalDocRoom } from '../collaboration/ensureCollabSession';
import { clearConnection } from '../api/relayConnection';

export async function removeCurrentWorkspace(): Promise<void> {
  const host = useConnectionStore.getState().host?.address ?? null;
  // JP-370: the durable offline cache is now workspace-scoped, so removing one
  // workspace never purges a sibling workspace cached on the same relay host.
  const workspaceId = activeWorkspaceId();
  // Capture the workspace's doc ids BEFORE any teardown clears the caches —
  // they're needed to purge the local CRDT rooms below.
  const docIds = RelayDocumentCache.getCachedIds(workspaceId);

  // 1. Tear down the live session + in-memory relay identity.
  useCollaborationStore.getState().stopSession();

  if (host) {
    // 2. Drop ALL registry entries for the host — an explicit full purge (never
    //    preserve cached entries here; this is the hard path, unlike disconnect).
    useDocumentRegistry.getState().clearRemoteDocuments(host);
    // 3. Delete the durable offline copies for this workspace.
    await RelayDocumentCache.clearForWorkspace(workspaceId);
  }

  // 4. Purge the local CRDT rooms (y-indexeddb `host:docId`) for those docs.
  //    Done before step 5 — `purgeLocalDocRoom` derives the room host from the
  //    still-persisted relay URL.
  await Promise.all(docIds.map((id) => purgeLocalDocRoom(id)));

  // 5. Forget the relay connection entirely (URLs + token).
  await clearConnection();

  // 6. JP-390: forget the durable workspace-scope fallback last — after the
  //    workspace-scoped teardown above has consumed it — so we never restore
  //    into a workspace whose caches we just purged.
  clearRememberedWorkspaceId();
}
