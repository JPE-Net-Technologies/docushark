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
import { purgeLocalDocRoom } from '../collaboration/ensureCollabSession';
import { clearConnection } from '../api/relayConnection';

export async function removeCurrentWorkspace(): Promise<void> {
  const host = useConnectionStore.getState().host?.address ?? null;
  // Capture the host's doc ids BEFORE any teardown clears the caches — they're
  // needed to purge the local CRDT rooms below.
  const docIds = host ? RelayDocumentCache.getCachedIdsForHost(host) : [];

  // 1. Tear down the live session + in-memory relay identity.
  useCollaborationStore.getState().stopSession();

  if (host) {
    // 2. Drop ALL registry entries for the host — an explicit full purge (never
    //    preserve cached entries here; this is the hard path, unlike disconnect).
    useDocumentRegistry.getState().clearRemoteDocuments(host);
    // 3. Delete the durable offline copies for the host.
    await RelayDocumentCache.clearForHost(host);
  }

  // 4. Purge the local CRDT rooms (y-indexeddb `host:docId`) for those docs.
  //    Done before step 5 — `purgeLocalDocRoom` derives the room host from the
  //    still-persisted relay URL.
  await Promise.all(docIds.map((id) => purgeLocalDocRoom(id)));

  // 5. Forget the relay connection entirely (URLs + token).
  await clearConnection();
}
