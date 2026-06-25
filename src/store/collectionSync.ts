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
import {
  useCollectionStore,
  isWorkspaceCollection,
  type Collection,
  type CollectionScope,
} from './collectionStore';
import { useNotificationStore } from './notificationStore';
import { getDocProvider, useRelayDocumentStore } from './relayDocumentStore';
import { useDocumentRegistry } from './documentRegistry';

/** Ids of the connected workspace's collections, refreshed on every relay read.
 *  Used to skip pushing a membership to a collection the workspace doesn't have
 *  (which would leave a dangling `collectionId`). */
let knownCollectionIds = new Set<string>();

/** Forget the connected workspace's collection set. Called when leaving a
 *  workspace (full sign-out / Remove Workspace) so a stale set can't gate the
 *  next workspace's membership pushes. */
export function resetWorkspaceSync(): void {
  knownCollectionIds = new Set();
}

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
  /**
   * Create a collection. Scope follows where it's born: connected to a workspace
   * → `workspace` (pushed to the relay registry); otherwise `local` (personal,
   * client-only). Pass an explicit `scope` to override (e.g. a per-card create
   * that must match the document's scope).
   */
  createCollection(name: string, color?: string, scope?: CollectionScope): string {
    const resolvedScope: CollectionScope = scope ?? (isRelayAuthenticated() ? 'workspace' : 'local');
    const id = useCollectionStore.getState().createCollection(name, color, resolvedScope);
    if (id && resolvedScope === 'workspace') {
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

/**
 * A document's scope from its registry record: `local` for personal docs,
 * `workspace` for relay docs (remote *or* cached-offline — a cached doc is still
 * a workspace doc). Falls back to live relay membership when the record is
 * unknown. Kept in lockstep with the per-card menu's `record.type` derivation.
 */
export function docScopeOf(documentId: string): CollectionScope {
  const rec = useDocumentRegistry.getState().getRecord(documentId);
  if (rec) return rec.type === 'local' ? 'local' : 'workspace';
  return useRelayDocumentStore.getState().isRelayDocument(documentId) ? 'workspace' : 'local';
}

/**
 * The single choke point for assigning documents to a collection. Enforces that
 * a document and its collection share scope — a workspace document can only join
 * a workspace collection and a local document only a local collection. Matching
 * documents are assigned (and synced); mismatched ones are skipped with a
 * warning toast. Removal (`null`) is scope-agnostic and always applies.
 *
 * Every assign entry point (per-card, bulk, new-collection-for-doc) must go
 * through here — calling `syncedActions.assignDocuments` with a non-null target
 * directly would bypass the guard.
 */
export function assignDocumentsScoped(documentIds: string[], collectionId: string | null): void {
  if (collectionId === null) {
    syncedActions.assignDocuments(documentIds, null);
    return;
  }
  const collection = useCollectionStore.getState().collections[collectionId];
  if (!collection) return;
  const target: CollectionScope = isWorkspaceCollection(collection) ? 'workspace' : 'local';

  const matched: string[] = [];
  let skipped = 0;
  for (const id of documentIds) {
    if (docScopeOf(id) === target) matched.push(id);
    else skipped += 1;
  }

  if (matched.length > 0) syncedActions.assignDocuments(matched, collectionId);

  if (skipped > 0) {
    useNotificationStore
      .getState()
      .warning(
        target === 'workspace'
          ? "Local documents can't be added to a workspace collection."
          : "Workspace documents can't be added to a local collection.",
      );
  }
}

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
