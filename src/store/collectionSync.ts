/**
 * collectionSync — the seam between the client `collectionStore` (canonical,
 * network-free) and the relay's per-workspace collection registry (JP-159).
 *
 * Two directions:
 *  - **Write-through** (`syncedActions`): after a local collection mutation,
 *    push it to the connected workspace. Definitions use **read-modify-write**
 *    against the relay's current set (`GET` → mutate → `PUT`) so we only ever
 *    touch ids that belong to that workspace — the global client store is never
 *    PUT wholesale (all Cloud workspaces share a relay origin, so that would
 *    corrupt other workspaces' registries). Membership uses the per-doc endpoint.
 *  - **Reconcile** (`reconcileFromRelay`): on doc-list fetch, pull the relay's
 *    definitions + each relay doc's `collectionId` and hydrate them in — the
 *    relay is authoritative for relay-hosted docs; local-only docs are untouched.
 *
 * All network calls are best-effort: offline/errors are swallowed+logged and
 * self-heal on the next reconcile (definitions) or the queued content-save,
 * which carries `collectionId` in its body (persistenceStore stamp).
 */

import type { RelayCollectionDef } from '../api/relayClient';
import type { DocumentMetadata } from '../types/Document';
import { getSyncStateManager } from '../collaboration/SyncStateManager';
import { isRelayAuthenticated } from './connectionStore';
import { useCollectionStore, type Collection } from './collectionStore';
import { getDocProvider, useRelayDocumentStore } from './relayDocumentStore';

/** Ids of the connected workspace's collections, refreshed on every relay read.
 *  Used to skip pushing a membership to a collection the workspace doesn't have
 *  (which would leave a dangling `collectionId`). */
let knownCollectionIds = new Set<string>();

/** Serialize relay-definition read-modify-writes so concurrent mutations can't
 *  interleave their GET/PUT and clobber each other. */
let chain: Promise<unknown> = Promise.resolve();
function serialize<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(fn, fn);
  chain = run.catch(() => undefined);
  return run;
}

function toDef(col: Collection): RelayCollectionDef {
  return {
    id: col.id,
    name: col.name,
    order: col.order,
    ...(col.color !== undefined ? { color: col.color } : {}),
  };
}

/**
 * Read the connected workspace's definition set, apply `transform`, write it
 * back. Best-effort + serialized + auth-gated. Refreshes `knownCollectionIds`.
 */
function mutateRelayDefs(
  transform: (defs: RelayCollectionDef[]) => RelayCollectionDef[],
): Promise<void> {
  return serialize(async () => {
    const provider = getDocProvider();
    if (!provider?.getCollections || !provider.setCollections) return;
    if (!isRelayAuthenticated()) return;
    try {
      const current = await provider.getCollections();
      const next = transform(current);
      knownCollectionIds = new Set(next.map((d) => d.id));
      await provider.setCollections(next);
    } catch (e) {
      console.warn('[collectionSync] definitions push failed (best-effort):', e);
    }
  });
}

async function pushMembership(documentId: string, collectionId: string | null): Promise<void> {
  if (!useRelayDocumentStore.getState().isRelayDocument(documentId)) return; // local doc → no relay membership
  const provider = getDocProvider();
  if (!provider?.setDocumentCollection) return;
  if (!isRelayAuthenticated()) return;
  // Don't create a dangling reference: if we know this workspace's set and the
  // target isn't in it, it's a local/other-workspace collection — skip.
  if (collectionId !== null && knownCollectionIds.size > 0 && !knownCollectionIds.has(collectionId)) {
    console.warn(
      `[collectionSync] skipping membership push for ${documentId}: collection ${collectionId} not in connected workspace`,
    );
    return;
  }
  try {
    await provider.setDocumentCollection(documentId, collectionId);
  } catch (e) {
    console.warn('[collectionSync] membership push failed (best-effort):', e);
  }
}

/**
 * Sync-wrapped collection actions. UI should call these instead of the raw
 * store so every mutation (incl. future slice-4 UI) writes through to the relay.
 */
export const syncedActions = {
  createCollection(name: string, color?: string): string {
    const id = useCollectionStore.getState().createCollection(name, color);
    if (id) {
      const col = useCollectionStore.getState().collections[id];
      if (col) {
        void mutateRelayDefs((defs) =>
          defs.some((d) => d.id === col.id) ? defs : [...defs, toDef(col)],
        );
      }
    }
    return id;
  },

  renameCollection(id: string, name: string): void {
    useCollectionStore.getState().renameCollection(id, name);
    void reprojectDefinition(id);
  },

  recolorCollection(id: string, color: string | undefined): void {
    useCollectionStore.getState().recolorCollection(id, color);
    void reprojectDefinition(id);
  },

  reorderCollections(orderedIds: string[]): void {
    useCollectionStore.getState().reorderCollections(orderedIds);
    // Refresh order/content for the workspace's ids from the store; leave ids
    // this client doesn't know (another client's collections) untouched.
    void mutateRelayDefs((defs) =>
      defs.map((d) => {
        const col = useCollectionStore.getState().collections[d.id];
        return col ? toDef(col) : d;
      }),
    );
  },

  deleteCollection(id: string): void {
    useCollectionStore.getState().deleteCollection(id);
    void mutateRelayDefs((defs) => defs.filter((d) => d.id !== id));
  },

  /** Assign/unassign documents; pushes membership for relay docs only. */
  assignDocuments(documentIds: string[], collectionId: string | null): void {
    useCollectionStore.getState().assignMany(documentIds, collectionId);
    for (const documentId of documentIds) {
      void pushMembership(documentId, collectionId);
    }
  },
};

/** Push a single definition's current store content to the workspace set, only
 *  if it already exists there (rename/recolor never re-adds a deleted/foreign id). */
function reprojectDefinition(id: string): Promise<void> {
  return mutateRelayDefs((defs) =>
    defs.map((d) => {
      if (d.id !== id) return d;
      const col = useCollectionStore.getState().collections[id];
      return col ? toDef(col) : d;
    }),
  );
}

/**
 * Pull the connected workspace's collections + relay-doc memberships and
 * reconcile them into the store. Called from `fetchDocumentList`. Best-effort:
 * a failure here must not fail the doc-list fetch.
 */
export async function reconcileFromRelay(relayDocs: DocumentMetadata[]): Promise<void> {
  const provider = getDocProvider();
  if (!provider?.getCollections) return;

  let relaySet: RelayCollectionDef[];
  try {
    relaySet = await provider.getCollections();
  } catch (e) {
    console.warn('[collectionSync] reconcile getCollections failed (best-effort):', e);
    return;
  }
  knownCollectionIds = new Set(relaySet.map((d) => d.id));

  const store = useCollectionStore.getState();
  const definitions: Collection[] = relaySet.map((d) => {
    const existing = store.collections[d.id];
    return {
      id: d.id,
      name: d.name,
      order: d.order,
      createdAt: existing?.createdAt ?? Date.now(),
      ...(d.color !== undefined ? { color: d.color } : {}),
    };
  });

  // Membership: relay is authoritative for relay docs. Clear an absent
  // membership only when there's no pending queued save for that doc — an
  // offline assign that reconnects before its content-save replays would
  // otherwise be reverted by a stale reconcile.
  const sync = getSyncStateManager();
  const memberships: Record<string, string | null> = {};
  for (const doc of relayDocs) {
    const cid = doc.collectionId;
    if (typeof cid === 'string') {
      memberships[doc.id] = cid;
    } else if (!sync.hasPendingChanges(doc.id)) {
      memberships[doc.id] = null;
    }
  }

  store.hydrateFromRelay({ definitions, memberships });
}
