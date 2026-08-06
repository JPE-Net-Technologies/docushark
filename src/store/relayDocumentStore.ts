/**
 * Relay Document Store
 *
 * Manages documents fetched from a relay server. Works alongside
 * persistenceStore which handles local documents.
 *
 * Relay documents are stored on the relay and synced to clients;
 * this store maintains the client-side view.
 *
 * Phase 14.1: Updated to work with UnifiedSyncProvider.
 * Phase 14.9.2: Added persistent offline cache support.
 * Phase 20.3 Slice B: Renamed from `teamDocumentStore` (JP-290 finished the tail).
 */

import { create } from 'zustand';
import type { DocumentMetadata, DiagramDocument } from '../types/Document';
import type { DocEvent } from '../collaboration/protocol';
import { webClient } from '../api/webClient';
import { useDocumentRegistry } from './documentRegistry';
import { useConnectionStore } from './connectionStore';
import { useUserStore } from './userStore';
import type { Permission } from '../types/DocumentRegistry';
import {
  bundleDocumentWithAssets,
  collectBlobReferences,
  extractAssetsFromBundle,
  hasBlobReferences,
  hasEmbeddedAssets,
} from '../storage/AssetBundler';
import { RelayDocumentCache } from '../storage/RelayDocumentCache';
import { activeWorkspaceId } from './activeWorkspace';
import { registerBlobDownloader } from '../storage/blobResolver';
import { getSyncStateManager } from '../collaboration/SyncStateManager';
import { isCollabContentDoc, useCollaborationStore } from '../collaboration/collaborationStore';
import { usePersistenceStore } from './persistenceStore';
import { usePendingSyncPages } from './pendingSyncPages';
import { serializeDocForRest } from './serializeDocForRest';
import { useNotificationStore } from './notificationStore';
import { useTrashStore } from './trashStore';
import type { TrashOrigin } from '../storage/TrashStorage';
import type { BlobSyncProgress, BlobSyncResult } from '../collaboration/BlobSyncService';
import { RelayError } from '../api/relayClient';
import type {
  RelayCollectionDef,
  RelayRecoveryPoint,
  RelayStyleProfileDef,
  RelayUsage,
  RestoreRecoveryAck,
} from '../api/relayClient';
import { useUploadStatusStore } from './uploadStatusStore';

/**
 * The editor's mirror of the relay's document authorization (JP-458).
 *
 * The relay is the authority — `permissions::resolve` in
 * `relay/src/server/permissions.rs`. This exists so the UI can predict what the
 * server will allow (which actions to offer, whether to open read-only) without
 * a round trip. It must not be more permissive than the relay, or the editor
 * offers actions that fail.
 *
 * The two are pinned together by a shared table,
 * `relay/tests/fixtures/permission-matrix.json`, which both this function's
 * test and the Rust resolver's test read. Before that existed the two had
 * silently diverged in both directions: this function fell through to
 * `'viewer'` where the relay returns none, and it granted on `userRole ===
 * 'admin'`, a value the relay never sends.
 *
 * Sources are applied in the relay's order — highest grant wins, then the
 * workspace-viewer cap clamps.
 */
export function getEffectivePermission(
  doc: DocumentMetadata,
  userId: string | undefined,
  userRole: string | undefined
): Permission {
  // Identity not loaded. This is reachable, not hypothetical: `currentUser`
  // mirrors the *WebSocket* auth state, while the document list is fetched over
  // REST with a stored token — so a boot that lists documents before (or
  // without) connecting has no `userId` here.
  //
  // Resolving to 'none' in that window would mark every document inaccessible
  // and flip the editor read-only. The relay has already filtered its listing
  // to documents this token may read, so presence in the list is itself
  // evidence of at least read access; an unowned document keeps the same
  // Editor grant the relay's legacy carve-out gives it. Both are floors — the
  // real level is computed as soon as identity arrives.
  if (!userId) return doc.ownerId ? 'viewer' : 'editor';

  const role = normalizeWorkspaceRole(userRole);
  let granted: Permission = 'none';

  // The document's owner.
  if (doc.ownerId === userId) granted = maxPermission(granted, 'owner');

  // Workspace owners manage every document in the workspace — the inheritance
  // the access panel draws as "via workspace".
  if (role === 'owner') granted = maxPermission(granted, 'owner');

  // Legacy documents with no recorded owner stay workspace-visible. The relay
  // stamps an owner on every write now, so this set drains; until it does, an
  // unowned document must not read as inaccessible.
  if (!doc.ownerId) granted = maxPermission(granted, 'editor');

  // Explicit per-document shares.
  if (doc.sharedWith) {
    for (const share of doc.sharedWith) {
      if (share.userId !== userId) continue;
      if (share.permission === 'edit') granted = maxPermission(granted, 'editor');
      if (share.permission === 'view') granted = maxPermission(granted, 'viewer');
    }
  }

  // The workspace viewer role is a ceiling: a share cannot promote a read-only
  // member to a writer.
  if (role === 'viewer') return minPermission(granted, 'viewer');

  return granted;
}

/** Rank for comparing permissions; higher is more privileged. */
const PERMISSION_RANK: Record<Permission, number> = {
  none: 0,
  viewer: 1,
  editor: 2,
  owner: 3,
};

function maxPermission(a: Permission, b: Permission): Permission {
  return PERMISSION_RANK[a] >= PERMISSION_RANK[b] ? a : b;
}

function minPermission(a: Permission, b: Permission): Permission {
  return PERMISSION_RANK[a] <= PERMISSION_RANK[b] ? a : b;
}

/**
 * The workspace role as the relay spells it (`WorkspaceRole::as_str`).
 *
 * `'admin'` is accepted as a legacy alias for `'owner'`: it is the value the
 * client used to test for, and tolerating it means this can ship independently
 * of the relay change rather than depending on deploy order.
 */
function normalizeWorkspaceRole(role: string | undefined): 'owner' | 'member' | 'viewer' | null {
  switch (role) {
    case 'owner':
    case 'admin':
      return 'owner';
    case 'member':
    case 'user':
      return 'member';
    case 'viewer':
      return 'viewer';
    default:
      return null;
  }
}

/** Relay document store state */
interface RelayDocumentState {
  /** Relay documents from host (metadata only until loaded) */
  relayDocuments: Record<string, DocumentMetadata>;

  /** Currently loading document IDs */
  loadingDocs: Set<string>;

  /** Cached full documents (for quick switching) */
  documentCache: Record<string, DiagramDocument>;

  /** Connection status to host */
  hostConnected: boolean;

  /** Whether authenticated with host */
  authenticated: boolean;

  /** Last sync timestamp */
  lastSyncAt: number | null;

  /** Error state */
  error: string | null;

  /** Loading state for document list */
  isLoadingList: boolean;
}

/**
 * Provider interface that the store calls for CRUD. As of 20.3 Slice E.2
 * this is satisfied by `RestDocumentProvider` wrapping `RelayClient`;
 * the legacy WS-multiplexed implementation on `UnifiedSyncProvider`
 * stays in place but is no longer wired in here.
 */
/**
 * Thrown by `loadRelayDocument` when a relay doc can't be opened because we're
 * offline and it was never cached (not "made available offline"). Typed so the
 * open path can show a specific "not available offline" message rather than a
 * generic failure.
 */
export class RelayDocumentUnavailableOfflineError extends Error {
  constructor(public readonly docId: string) {
    super('Document is not available offline');
    this.name = 'RelayDocumentUnavailableOfflineError';
  }
}

/**
 * Thrown when the relay refuses a document the caller used to be able to open
 * (JP-459) — a share revoked, or ownership transferred away. Distinct from the
 * offline error because the remedy is different: waiting won't help, and the
 * document has been removed from the browser rather than left looking stale.
 */
export class RelayDocumentAccessRevokedError extends Error {
  constructor(public readonly docId: string) {
    super('You no longer have access to this document');
    this.name = 'RelayDocumentAccessRevokedError';
  }
}

/**
 * Forget a document the relay now denies: drop it from the registry so it stops
 * being listed, and drop its offline copy so a stale snapshot can't resurrect
 * the title on the next boot.
 *
 * **Unsynced work is never destroyed.** A share can be revoked while the holder
 * is offline with edits still queued, and purging the cache would silently take
 * those with it — the one outcome that is worse than a stale row. When there are
 * pending changes the bytes stay put and the caller is told; losing access to
 * the server's copy is not permission to delete the user's own writing.
 */
async function forgetDeniedDocument(docId: string): Promise<void> {
  const registry = useDocumentRegistry.getState();
  const hasUnsynced = getSyncStateManager().hasPendingChanges(docId);

  registry.removeDocument(docId);
  useRelayDocumentStore.setState((state) => {
    const { [docId]: _dropped, ...documentCache } = state.documentCache;
    const { [docId]: _meta, ...relayDocuments } = state.relayDocuments;
    return { documentCache, relayDocuments };
  });

  if (hasUnsynced) {
    useNotificationStore
      .getState()
      .error(
        'Access to a document was revoked, but it has unsaved changes — its offline copy has been kept.',
      );
    return;
  }
  await RelayDocumentCache.remove(activeWorkspaceId(), docId).catch(() => {
    /* best-effort: the registry removal is what stops it being listed */
  });
}

export interface DocumentProvider {
  listDocuments(): Promise<DocumentMetadata[]>;
  getDocument(docId: string): Promise<DiagramDocument | { document: DiagramDocument; serverVersion?: number }>;
  saveDocument(
    doc: DiagramDocument,
    expectedVersion?: number,
    opts?: { overrideTombstone?: boolean },
  ): Promise<void | { newVersion?: number }>;
  deleteDocument(docId: string): Promise<void>;
  updateDocumentShares?(
    docId: string,
    shares: Array<{ userId: string; userName: string; permission: string }>
  ): Promise<void>;
  transferDocumentOwnership?(
    docId: string,
    newOwnerId: string,
    newOwnerName: string
  ): Promise<void>;
  /**
   * Public projection (JP-464). Optional so non-REST providers opt out.
   * Publish writes the sanitized artifact server-side (owner-only there);
   * status carries the configured artifact cap so no client hardcodes it.
   */
  publishDocument?(docId: string): Promise<import('../api/relayClient').RelayPublishAck>;
  unpublishDocument?(docId: string): Promise<{ success: boolean; removed: boolean }>;
  getPublishStatus?(docId: string): Promise<import('../api/relayClient').RelayPublishStatus>;
  /**
   * Upload referenced blobs to the relay blob store before a doc save.
   * Optional: when absent the store falls back to base64-embedding assets
   * in the doc (legacy path). When present, assets are stored as deduped,
   * metered blobs and the doc keeps blob:// references (JP-118).
   */
  uploadBlobs?(
    hashes: string[],
    onProgress?: (progress: BlobSyncProgress) => void,
  ): Promise<BlobSyncResult>;
  /** Download referenced blobs missing locally after a doc load. */
  downloadBlobs?(hashes: string[]): Promise<BlobSyncResult>;
  /** Caller's own workspace usage + effective limits (`GET /api/v1/usage`). */
  getUsage?(): Promise<RelayUsage>;
  /**
   * Document recovery (JP-183). Optional so non-REST providers opt out. List a
   * doc's recovery points, fetch one's content (non-destructive, for
   * download-to-local), or restore one (→ a new doc id; tombstones the source).
   */
  listRecoveryPoints?(docId: string): Promise<RelayRecoveryPoint[]>;
  /** Capture a recovery point now (JP-428) — best-effort freshness for the panel. */
  captureRecoveryPoint?(docId: string): Promise<{ captured: boolean }>;
  getRecoveryPointContent?(docId: string, pointId: string): Promise<DiagramDocument>;
  /**
   * JP-422: fetch a document's authoritative binary Y.Doc sidecar (raw
   * lib0-v1 full-state bytes) so it can be seeded into the local Y.Doc room for
   * offline editing. Optional so non-REST providers opt out; null = no sidecar.
   */
  getYdoc?(docId: string): Promise<Uint8Array | null>;
  restoreRecoveryPoint?(docId: string, pointId: string): Promise<RestoreRecoveryAck>;
  /**
   * Collection sync (JP-159). Optional so non-REST providers opt out. The relay
   * scopes all three to the connected workspace from the bearer token. The
   * registry `version` + `expectedVersion` pair is the JP-424 optimistic-
   * concurrency handshake; `version` is absent on pre-JP-424 relays and an
   * omitted `expectedVersion` degrades to the legacy blind replace.
   */
  getCollections?(): Promise<{ collections: RelayCollectionDef[]; version?: number }>;
  setCollections?(collections: RelayCollectionDef[], expectedVersion?: number): Promise<void>;
  setDocumentCollection?(docId: string, collectionId: string | null): Promise<void>;
  /**
   * Style-profile sync (JP-301). Same optional-and-workspace-scoped contract as
   * the collection registry above, and the same version/`expectedVersion`
   * handshake. Unlike collections, a `set` can be refused for quota (507) —
   * the registry is metered storage — so callers must surface that rather than
   * treating every failure as a transient best-effort miss.
   */
  getStyleProfiles?(): Promise<{ profiles: RelayStyleProfileDef[]; version?: number }>;
  setStyleProfiles?(profiles: RelayStyleProfileDef[], expectedVersion?: number): Promise<void>;
}

/** Relay document store actions */
interface RelayDocumentActions {
  /** Set the document provider used for all CRUD operations. */
  setProvider: (provider: DocumentProvider | null) => void;

  /** Fetch document list from host */
  fetchDocumentList: () => Promise<void>;

  /** Load a relay document's content */
  loadRelayDocument: (docId: string) => Promise<DiagramDocument>;

  /** 
   * Save a document to host as relay document.
   * Uses optimistic locking if expectedVersion is provided.
   * @throws VersionConflictError if version mismatch detected
   */
  saveToHost: (
    doc: DiagramDocument,
    expectedVersion?: number,
    opts?: { overrideTombstone?: boolean },
  ) => Promise<{ newVersion?: number }>;

  /**
   * JP-234: upload the blob bytes a document references to the relay blob
   * store **without** a doc save. The collab/CRDT path (JP-108) suppresses
   * `saveToHost` for the active collab doc, but its referenced blob bytes must
   * still reach the relay or collaborators (and the same client after a cache
   * clear) get a 404. Blobs are content-addressed + immutable, so uploading
   * them never touches the relay's authoritative doc state / `serverVersion` /
   * Y.Doc sidecar — the relay-sole-writer invariant holds. Best-effort: only
   * blobs the relay is missing are sent (deduped); resolves to the upload
   * result, or `undefined` when there's nothing to do (no provider / no refs).
   */
  uploadCollabBlobs: (doc: DiagramDocument) => Promise<BlobSyncResult | undefined>;

  /** Delete a relay document from host */
  deleteFromHost: (docId: string) => Promise<void>;

  /**
   * "Delete" a relay document (non-permanent): hard-delete it on the relay
   * (there's no relay-side soft-delete yet — that's JP-294) but keep the
   * deleter a recoverable copy in their own Trash as a stranded entry (JP-292).
   * Other connected editors strand it via the broadcast `Deleted` event; the
   * self-broadcast back to us is skipped by the self-initiated guard, so this
   * is the single place the deleter's own copy is preserved.
   */
  trashRelayDocument: (docId: string) => Promise<void>;

  /** Update document sharing permissions */
  updateDocumentShares: (
    docId: string,
    shares: Array<{ userId: string; userName: string; permission: string }>
  ) => Promise<void>;

  /** Transfer document ownership */
  transferDocumentOwnership: (
    docId: string,
    newOwnerId: string,
    newOwnerName: string
  ) => Promise<void>;

  /** Handle document events from host */
  handleDocumentEvent: (event: DocEvent) => void;

  /**
   * React to a relay document that's gone from the workspace (JP-175) — either
   * a `DocEvent::Deleted` broadcast or a JOIN_DOC `ERR_UNKNOWN_DOC` rejection.
   * The client never silently drops it:
   *  - if it's the **open** doc → demote it to a local document so the user
   *    keeps editing (saves go local), stop relay sync, and notify;
   *  - otherwise, if we hold a copy → **strand** it into Trash (recoverable);
   *  - clean up the relay bookkeeping either way.
   * Skips preservation when *we* initiated the deletion (`deletedByUserId` is us).
   */
  strandOrDemoteDeletedDoc: (
    docId: string,
    deletedByUserId?: string,
    /**
     * Why the doc is being stranded — drives the user-facing copy. `'deleted'`
     * (default): the relay removed it. `'access-revoked'` (JP-370): the doc
     * still exists but we lost read access (un-shared / removed from workspace).
     */
    reason?: 'deleted' | 'access-revoked',
  ) => void;

  /** Set host connection status */
  setHostConnected: (connected: boolean) => void;

  /**
   * Set authenticated status. By default, flipping to `true` eagerly fetches the
   * document list (+ refreshes stale cached docs). Pass `{ skipFetch: true }` to
   * set the flag without the fetch — used by the REST-only relay-doc boot, where
   * the WS `onAuthenticated` will fetch once on its own (avoids a double-fetch).
   */
  setAuthenticated: (authenticated: boolean, opts?: { skipFetch?: boolean }) => void;

  /** Clear relay documents (on disconnect) */
  clearRelayDocuments: () => void;

  /** Set error state */
  setError: (error: string | null) => void;

  /** Check if a document is known to this store (relay-backed). */
  isRelayDocument: (docId: string) => boolean;

  /** Get metadata for a relay document. */
  getMetadata: (docId: string) => DocumentMetadata | undefined;

  /** Get cached document content */
  getCachedDocument: (docId: string) => DiagramDocument | undefined;
  
  /** Check if a document is available in offline cache */
  isAvailableOffline: (docId: string) => boolean;
  
  /** Get list of document IDs available offline */
  getOfflineDocumentIds: () => string[];
  
  /** Refresh stale cached documents from server (call after reconnect) */
  refreshStaleCachedDocuments: () => Promise<void>;

  /**
   * Best-effort refresh of the relay document list + stale cached docs. No-ops
   * unless authenticated with a live provider, so it's safe to fire from
   * focus/visibility/online listeners (JP-324 #10): a doc transferred from
   * another session shows up without a manual reload, even while the user sits
   * idle on a local/offline document with no live WS to drive a reconnect
   * refetch. The reconnect path itself is already covered (the relay re-auths on
   * every WS reconnect → `setAuthenticated` → `fetchDocumentList`).
   */
  refreshDocumentList: () => void;

  /** Preload cached documents into memory (call on app start) */
  warmupCache: () => Promise<void>;
}

/** Document provider instance (module-level singleton) */
let docProvider: DocumentProvider | null = null;

// Let the blob resolver pull a blob that's missing locally (e.g. a viewer
// opening a file whose bytes were never downloaded, or one a collaborator
// uploaded after this client loaded the doc). Routes through the same provider
// + platform fetch seam as the eager doc-load pull. A local-only doc (no
// provider, or a provider without blob sync) resolves to "not downloadable",
// so the viewer falls back to its recovery UI rather than hanging (JP-129).
registerBlobDownloader(async (hash) => {
  if (!docProvider?.downloadBlobs) return false;
  const result = await docProvider.downloadBlobs([hash]);
  return result.success > 0;
});

/** Create the relay document store */
export const useRelayDocumentStore = create<RelayDocumentState & RelayDocumentActions>(
  (set, get) => ({
    // Initial state
    relayDocuments: {},
    loadingDocs: new Set(),
    documentCache: {},
    hostConnected: false,
    authenticated: false,
    lastSyncAt: null,
    error: null,
    isLoadingList: false,

    // Actions
    setProvider: (provider) => {
      docProvider = provider;

      // Note: Document events are handled by collaborationStore's onDocumentEvent callback
      // which calls handleDocumentEvent directly, so no subscription needed here
    },

    fetchDocumentList: async () => {
      if (!docProvider) {
        set({ error: 'Not connected to host' });
        return;
      }

      set({ isLoadingList: true, error: null });

      try {
        const documents = await docProvider.listDocuments();

        // Convert to record
        const relayDocuments: Record<string, DocumentMetadata> = {};
        for (const doc of documents) {
          relayDocuments[doc.id] = doc;
        }

        set({
          relayDocuments,
          lastSyncAt: Date.now(),
          isLoadingList: false,
        });

        // Register remote documents in the registry with proper permissions
        const registry = useDocumentRegistry.getState();
        const connection = useConnectionStore.getState();
        const userState = useUserStore.getState();
        const relayId = connection.host?.address ?? 'unknown';
        const userId = userState.currentUser?.id;
        const userRole = userState.currentUser?.role;

        // Register each document with its calculated effective permission
        for (const doc of documents) {
          const permission = getEffectivePermission(doc, userId, userRole);
          registry.registerRemote(doc, relayId, permission, 'synced');
        }

        // JP-459: the rows we just registered carry account ids where a person's
        // name belongs, so warm the workspace directory that resolves them.
        // Lazy + fire-and-forget: names are decoration, and a listing must never
        // wait on (or fail because of) the control plane.
        void import('./workspaceDirectoryStore')
          .then((m) => m.useWorkspaceDirectory.getState().ensureLoaded())
          .catch(() => {
            /* self-host / offline — names fall back, the list still renders */
          });

        // JP-159: reconcile this workspace's collection definitions + per-doc
        // membership into the client store. Lazy import breaks the module cycle
        // (collectionSync imports this store); best-effort — never fails the list.
        void import('./collectionSync')
          .then((m) => m.reconcileFromRelay(documents))
          .catch((err) => console.warn('[relayDocumentStore] collection reconcile failed:', err));

        // JP-301: hydrate this workspace's style profiles once per connection.
        // Deliberately NOT a per-fetch reconcile like collections above — the
        // registry is the user's own working set, so re-pulling it mid-session
        // would silently revert a local edit. Refreshing again is explicit.
        void import('./styleProfileSync')
          .then((m) => m.ensureStyleProfilesHydrated())
          .catch((err) => console.warn('[relayDocumentStore] style profile hydrate failed:', err));
      } catch (e) {
        const error = e instanceof Error ? e.message : 'Failed to fetch documents';
        set({ error, isLoadingList: false });
        throw e;
      }
    },

    loadRelayDocument: async (docId) => {
      const registry = useDocumentRegistry.getState();

      // Cache freshness gate. `relayDocuments[id]` carries the latest
      // metadata we've seen from the server — both via fetchDocumentList
      // and via DocEvent::Updated broadcasts. If a cached copy predates
      // that timestamp, skip the cache and force a fresh fetch.
      const remoteMeta = get().relayDocuments[docId];
      const isFresh = (cachedModifiedAt: number): boolean =>
        !remoteMeta || cachedModifiedAt >= remoteMeta.modifiedAt;

      // Check in-memory cache first (fastest)
      const memoryCached = get().documentCache[docId];
      if (memoryCached && isFresh(memoryCached.modifiedAt)) {
        return memoryCached;
      }

      // Check registry content cache
      const registryCached = registry.getDocumentContent(docId);
      if (registryCached && isFresh(registryCached.modifiedAt)) {
        // Also update our in-memory cache
        set((state) => ({
          documentCache: {
            ...state.documentCache,
            [docId]: registryCached,
          },
        }));
        return registryCached;
      }

      // A real network outage counts as offline even while a provider is
      // configured: `docProvider` stays set on a mere disconnect, so it can't
      // be the offline signal on its own. `navigator.onLine === false` catches
      // the internet-disconnected case the provider misses.
      const offline =
        !docProvider || (typeof navigator !== 'undefined' && navigator.onLine === false);

      // Check persistent offline cache. Trust it whenever we're offline — a
      // possibly-stale local copy beats failing to open, and the CRDT layer
      // reconciles on reconnect. Online, still require freshness so we don't
      // serve a pre-server-update snapshot over a reachable newer one.
      const persistentCached = await RelayDocumentCache.get(activeWorkspaceId(), docId);
      if (persistentCached && (offline || isFresh(persistentCached.modifiedAt))) {
        console.log('[relayDocumentStore] Loaded from offline cache:', docId);

        // Update in-memory caches
        set((state) => ({
          documentCache: {
            ...state.documentCache,
            [docId]: persistentCached,
          },
        }));
        registry.setDocumentContent(docId, persistentCached);

        return persistentCached;
      }

      // No usable cache. Offline → don't attempt a doomed network fetch (it
      // spews `net::ERR_INTERNET_DISCONNECTED` + a raw `TypeError: Failed to
      // fetch`); throw a clear, catchable signal the open path turns into a
      // friendly "not available offline" message instead of a silent no-op.
      if (offline || !docProvider) {
        throw new RelayDocumentUnavailableOfflineError(docId);
      }

      // Mark as loading
      set((state) => ({
        loadingDocs: new Set(state.loadingDocs).add(docId),
        error: null,
      }));
      registry.setDocumentLoading(docId, true);

      try {
        const result = await docProvider.getDocument(docId);
        
        // Handle both old format (DiagramDocument) and new format ({ document, serverVersion })
        let doc: DiagramDocument;
        let serverVersion: number | undefined;
        
        if ('document' in result && result.document) {
          doc = result.document;
          serverVersion = result.serverVersion;
        } else {
          doc = result as DiagramDocument;
        }

        // Store serverVersion on document for version tracking
        if (serverVersion !== undefined) {
          doc = { ...doc, serverVersion };
        }

        if (hasEmbeddedAssets(doc)) {
          // Legacy embedded doc: convert base64 data URLs to local blob://
          // references in IndexedDB. This is the lazy-migration read path —
          // the next saveToHost uploads these to the blob store and drops the
          // base64 (see JP-118).
          console.log('[relayDocumentStore] Extracting embedded assets from document:', docId);
          const assetResult = await extractAssetsFromBundle(doc);
          doc = assetResult.document;
          // Preserve serverVersion after extraction
          if (serverVersion !== undefined) {
            doc = { ...doc, serverVersion };
          }
          console.log(`[relayDocumentStore] Extracted ${assetResult.assetCount} assets`);
        }
        // Reference docs (JP-118) no longer eagerly pull every referenced blob
        // here (JP-129): that blocked doc-open on the network and — when a
        // presigned R2 GET is CORS-blocked in the browser — spun the
        // BlobSyncService retry loop on every blob, hanging the open entirely.
        // Blobs now load lazily on demand: the canvas self-fetches a thumbnail
        // when it renders, and the file viewer / rich-text images resolve
        // through blobResolver's download-on-miss when shown. The offline cache
        // warms with whatever the user actually views. `docProvider.downloadBlobs`
        // stays — the resolver's downloader seam calls it per-blob.

        // Cache the document in memory
        set((state) => {
          const loadingDocs = new Set(state.loadingDocs);
          loadingDocs.delete(docId);
          return {
            loadingDocs,
            documentCache: {
              ...state.documentCache,
              [docId]: doc,
            },
          };
        });

        // Also cache in registry
        registry.setDocumentContent(docId, doc);

        // Persist to offline cache for future offline access
        const connection = useConnectionStore.getState();
        const relayId = connection.host?.address ?? 'unknown';
        await RelayDocumentCache.put(doc, relayId, activeWorkspaceId());

        return doc;
      } catch (e) {
        // Remove from loading
        set((state) => {
          const loadingDocs = new Set(state.loadingDocs);
          loadingDocs.delete(docId);
          return {
            loadingDocs,
            error: e instanceof Error ? e.message : 'Failed to load document',
          };
        });

        // JP-459: a 403 is not a transient failure — access to this document is
        // gone. Leaving the entry made it render as an offline/idle document
        // that could never load, which both misdescribes the state and leaves
        // the title on screen; a title is itself exposure.
        if (e instanceof RelayError && e.isForbidden) {
          await forgetDeniedDocument(docId);
          throw new RelayDocumentAccessRevokedError(docId);
        }

        registry.setDocumentLoading(docId, false, e instanceof Error ? e.message : 'Failed to load');
        throw e;
      }
    },

    saveToHost: async (doc, expectedVersion, opts) => {
      if (!docProvider) {
        throw new Error('Not connected to host');
      }

      const registry = useDocumentRegistry.getState();

      // Set sync state to syncing
      registry.setSyncState(doc.id, 'syncing');

      try {
        // Get referenced asset hashes (rich-text images + FileShape blobRefs +
        // the explicit GC list) via the canonical whole-doc walk.
        const blobHashes = collectBlobReferences(doc);

        let docToSave = doc;
        if (docProvider.uploadBlobs) {
          // JP-118: route assets to the relay blob store. Upload any blobs the
          // relay is missing *before* the doc save so collaborators never load
          // a doc that references blobs the relay doesn't have, and the doc
          // keeps lightweight blob:// refs (no base64 — the storage meter sees
          // real bytes). Keep the doc's GC list accurate at the same time.
          if (blobHashes.length > 0) {
            doc = { ...doc, blobReferences: blobHashes };
            console.log('[relayDocumentStore] Uploading assets to blob store for document:', doc.id);
            const uploadStatus = useUploadStatusStore.getState();
            let uploadResult: BlobSyncResult;
            try {
              uploadResult = await docProvider.uploadBlobs(blobHashes, uploadStatus.report);
            } finally {
              uploadStatus.clear();
            }
            if (uploadResult.failed > 0) {
              const detail = Array.from(uploadResult.errors.values())[0] ?? 'unknown error';
              throw new Error(
                `Failed to upload ${uploadResult.failed} of ${uploadResult.total} asset(s) to the relay: ${detail}`,
              );
            }
            if (uploadResult.skipped > 0) {
              // Pre-existing dangling references (bytes missing locally + not on
              // the relay). Don't block the save — a missing asset must not brick
              // the document; log it so the gap is visible.
              console.warn(
                `[relayDocumentStore] ${uploadResult.skipped} of ${uploadResult.total} asset(s) for ${doc.id} ` +
                  `are missing locally and not on the relay — saving without them`,
              );
            }
            const bundleResult = await bundleDocumentWithAssets(doc, { mode: 'reference' });
            docToSave = bundleResult.document;
            console.log(
              `[relayDocumentStore] Assets for ${doc.id}: ${uploadResult.total} referenced, ` +
                `${uploadResult.uploaded} uploaded (rest already present); saving with blob:// refs`,
            );
          }
        } else if (hasBlobReferences(doc)) {
          // Legacy fallback (provider without blob sync): embed assets as
          // base64 data URLs so other clients can access them.
          console.log('[relayDocumentStore] Bundling assets for document:', doc.id);
          const bundleResult = await bundleDocumentWithAssets(doc);
          docToSave = bundleResult.document;
          console.log(`[relayDocumentStore] Bundled ${bundleResult.assetCount} assets (${bundleResult.totalSize} bytes)`);
        }

        // Save with optional version check (+ JP-375 tombstone override).
        // serializeDocForRest applies at the wire ONLY (JP-423): the cache /
        // registry puts below must keep the full body.
        const saveResult = await docProvider.saveDocument(
          serializeDocForRest(docToSave),
          expectedVersion,
          opts,
        );
        const newVersion = saveResult && typeof saveResult === 'object' && 'newVersion' in saveResult
          ? saveResult.newVersion
          : undefined;

        // Update cache with the original doc (with blob:// references)
        // The bundled version is only for transmission
        // Also update serverVersion if returned
        const updatedDoc = newVersion !== undefined
          ? { ...doc, serverVersion: newVersion }
          : doc;
        
        set((state) => ({
          documentCache: {
            ...state.documentCache,
            [doc.id]: updatedDoc,
          },
        }));

        // Update registry
        registry.setDocumentContent(doc.id, updatedDoc);
        registry.setSyncState(doc.id, 'synced');

        // Update persistent offline cache
        const connection = useConnectionStore.getState();
        const relayId = connection.host?.address ?? 'unknown';
        await RelayDocumentCache.put(updatedDoc, relayId, activeWorkspaceId());

        // Return result with proper optional property handling
        const result: { newVersion?: number } = {};
        if (newVersion !== undefined) {
          result.newVersion = newVersion;
        }
        return result;
      } catch (e) {
        const error = e instanceof Error ? e.message : 'Failed to save document';
        set({ error });
        registry.setSyncState(doc.id, 'error');
        throw e;
      }
    },

    uploadCollabBlobs: async (doc) => {
      // No blob-store provider (filesystem/legacy backend) → nothing to do; the
      // legacy base64-embedding path only runs through `saveToHost`.
      if (!docProvider?.uploadBlobs) {
        console.log('[JP-234] uploadCollabBlobs: no uploadBlobs on provider — skip', {
          docId: doc.id,
          hasProvider: !!docProvider,
        });
        return undefined;
      }
      const hashes = collectBlobReferences(doc);
      console.log('[JP-234] uploadCollabBlobs:', doc.id, 'referenced blobs:', hashes);
      if (hashes.length === 0) return undefined;
      // Reuse the upload-progress channel so the indicator works for collab
      // uploads too (JP-126/JP-234). `ensureBlobsUploaded` HEADs each hash first,
      // so already-present blobs are skipped — safe to call on the autosave tick.
      const uploadStatus = useUploadStatusStore.getState();
      try {
        const result = await docProvider.uploadBlobs(hashes, uploadStatus.report);
        console.log('[JP-234] uploadCollabBlobs result:', doc.id, result);
        return result;
      } catch (e) {
        console.error('[JP-234] uploadCollabBlobs error:', doc.id, e);
        throw e;
      } finally {
        uploadStatus.clear();
      }
    },

    deleteFromHost: async (docId) => {
      if (!docProvider) {
        throw new Error('Not connected to host');
      }

      // JP-470: darken the public link with the document. Row first (mirrors
      // unpublish — the URL must die even if the rest fails), swallowed on
      // failure: the relay's own teardown deletes the artifact with the doc,
      // so readers fail closed regardless; the row is the tidiness half.
      // This is the single choke point every delete path funnels through
      // (trash, browser, transfer), so no caller needs its own revoke.
      try {
        await webClient.revokeShareLink(docId);
      } catch {
        /* self-host without a control plane, or transient — teardown covers readers */
      }

      try {
        await docProvider.deleteDocument(docId);

        // Remove from local state
        set((state) => {
          const relayDocuments = { ...state.relayDocuments };
          delete relayDocuments[docId];

          const documentCache = { ...state.documentCache };
          delete documentCache[docId];

          return { relayDocuments, documentCache };
        });

        // Remove from registry
        useDocumentRegistry.getState().removeDocument(docId);

        // Delete succeeded on the relay — drop any pending-sync markers for
        // the doc (JP-423). Only on success: a failed delete keeps the doc,
        // so its markers must keep protecting queued saves.
        usePendingSyncPages.getState().clearDoc(docId);

        // Remove from persistent offline cache
        await RelayDocumentCache.remove(activeWorkspaceId(), docId);
      } catch (e) {
        const error = e instanceof Error ? e.message : 'Failed to delete document';
        set({ error });
        throw e;
      }
    },

    trashRelayDocument: async (docId) => {
      const registry = useDocumentRegistry.getState();
      const connection = useConnectionStore.getState();
      const meta = get().relayDocuments[docId];

      // Capture a copy to keep recoverable in the deleter's Trash. Prefer what's
      // already in memory; otherwise pull it from the relay before deleting.
      let copy = get().documentCache[docId] ?? registry.getDocumentContent(docId);
      if (!copy) {
        try {
          copy = await get().loadRelayDocument(docId);
        } catch {
          // No copy reachable — proceed with the delete anyway; we just can't
          // offer a local recovery copy.
        }
      }

      const origin: TrashOrigin = { relayId: connection.host?.address ?? 'unknown' };
      if (meta?.ownerId) origin.ownerId = meta.ownerId;
      if (meta?.modifiedAt) origin.lastSyncedAt = meta.modifiedAt;

      // Hard-delete on the relay (clears our relay maps + offline cache + the
      // Deleted broadcast). The self-broadcast back here is skipped by the
      // self-initiated guard in strandOrDemoteDeletedDoc.
      await get().deleteFromHost(docId);

      if (copy) {
        useTrashStore.getState().trashStranded(copy, origin);
      }
    },

    updateDocumentShares: async (docId, shares) => {
      if (!docProvider) {
        throw new Error('Not connected to host');
      }

      if (!docProvider.updateDocumentShares) {
        throw new Error('Provider does not support share updates');
      }

      try {
        await docProvider.updateDocumentShares(docId, shares);
        // Reflect the saved shares in local metadata so the share dialog (which
        // derives its list from relayDocuments[docId].sharedWith) updates
        // immediately — without this, a revoke/add persists on the relay but the
        // UI keeps showing the pre-save list (looks like it did nothing). The
        // relay is canonical; a later DocEvent::Updated reconciles sharedAt.
        set((state) => {
          const meta = state.relayDocuments[docId];
          if (!meta) return {};
          const now = Date.now();
          const relayDocuments = { ...state.relayDocuments };
          relayDocuments[docId] = {
            ...meta,
            sharedWith: shares.map((s) => ({
              userId: s.userId,
              userName: s.userName,
              permission: s.permission as 'view' | 'edit',
              sharedAt: now,
            })),
          };
          return { relayDocuments };
        });
      } catch (e) {
        const error = e instanceof Error ? e.message : 'Failed to update shares';
        set({ error });
        throw e;
      }
    },

    transferDocumentOwnership: async (docId, newOwnerId, newOwnerName) => {
      if (!docProvider) {
        throw new Error('Not connected to host');
      }

      if (!docProvider.transferDocumentOwnership) {
        throw new Error('Provider does not support ownership transfer');
      }

      try {
        await docProvider.transferDocumentOwnership(docId, newOwnerId, newOwnerName);
      } catch (e) {
        const error = e instanceof Error ? e.message : 'Failed to transfer ownership';
        set({ error });
        throw e;
      }
    },

    handleDocumentEvent: (event) => {
      const registry = useDocumentRegistry.getState();
      const connection = useConnectionStore.getState();
      const userState = useUserStore.getState();
      const relayId = connection.host?.address ?? 'unknown';
      const userId = userState.currentUser?.id;
      const userRole = userState.currentUser?.role;

      // A deletion isn't a silent drop — preserve the user's copy (JP-175).
      if (event.eventType === 'deleted') {
        get().strandOrDemoteDeletedDoc(event.docId, event.userId);
        return;
      }

      set((state) => {
        const relayDocuments = { ...state.relayDocuments };
        const documentCache = { ...state.documentCache };

        switch (event.eventType) {
          case 'created':
          case 'updated':
            if (event.metadata) {
              relayDocuments[event.docId] = event.metadata;
              // Calculate proper permission for this user
              const permission = getEffectivePermission(event.metadata, userId, userRole);
              // Update registry
              registry.registerRemote(event.metadata, relayId, permission, 'synced');
            }
            // Invalidate cache on update (will be refetched when needed)
            if (event.eventType === 'updated') {
              delete documentCache[event.docId];
              registry.invalidateContent(event.docId);
            }
            break;
        }

        return { relayDocuments, documentCache };
      });
    },

    strandOrDemoteDeletedDoc: (docId, deletedByUserId, reason = 'deleted') => {
      const registry = useDocumentRegistry.getState();
      const connection = useConnectionStore.getState();
      const persistence = usePersistenceStore.getState();
      const userId = useUserStore.getState().currentUser?.id;

      const meta = get().relayDocuments[docId];
      const origin: TrashOrigin = { relayId: connection.host?.address ?? 'unknown' };
      if (meta?.ownerId) origin.ownerId = meta.ownerId;
      if (meta?.modifiedAt) origin.lastSyncedAt = meta.modifiedAt;

      // A self-initiated delete (we asked for it) is intentional — nothing to
      // preserve, just drop our bookkeeping below.
      const selfInitiated =
        deletedByUserId != null && userId != null && deletedByUserId === userId;
      const isOpen = persistence.currentDocumentId === docId;

      // Clear the in-memory relay maps for this doc (the registry + offline
      // cache are handled per-branch below).
      const clearRelayMaps = () => {
        set((state) => {
          const relayDocuments = { ...state.relayDocuments };
          const documentCache = { ...state.documentCache };
          delete relayDocuments[docId];
          delete documentCache[docId];
          return { relayDocuments, documentCache };
        });
      };

      // Capture a recoverable copy (in-memory) BEFORE we drop any bookkeeping.
      const copy = get().documentCache[docId] ?? registry.getDocumentContent(docId);

      // Viewing the deleted doc → stop relay sync now; the editor is reset off it
      // below once we've preserved a copy.
      if (isOpen) useCollaborationStore.getState().leaveDocument();
      clearRelayMaps();

      // We deleted it on purpose — nothing to preserve, just drop bookkeeping.
      if (selfInitiated) {
        registry.removeDocument(docId);
        void RelayDocumentCache.remove(activeWorkspaceId(), docId);
        if (isOpen) persistence.newDocument();
        return;
      }

      // Stranded relay docs go to Trash (recoverable), whether or not they're the
      // open doc — demotion to local is only the edge-case fallback below when
      // there's genuinely no copy to snapshot. trashStranded captures the bytes,
      // so the offline cache entry is then safe to drop.
      const strandToTrash = (doc: DiagramDocument): void => {
        useTrashStore.getState().trashStranded(doc, origin);
        registry.removeDocument(docId);
        void RelayDocumentCache.remove(activeWorkspaceId(), docId);
        useNotificationStore
          .getState()
          .info(
            reason === 'access-revoked'
              ? `You no longer have access to “${doc.name}”. Your local copy was moved to Trash.`
              : `“${doc.name}” was deleted from the relay and moved to Trash.`,
          );
        // Leave the now-trashed doc — the editor resets to a blank document (the
        // copy is recoverable from Trash).
        if (isOpen) persistence.newDocument();
      };

      if (copy) {
        strandToTrash(copy);
        return;
      }

      // No in-memory copy — try the persistent offline cache (read BEFORE remove).
      void RelayDocumentCache.get(activeWorkspaceId(), docId).then((cached) => {
        if (cached) {
          strandToTrash(cached);
          return;
        }
        // EDGE-CASE FALLBACK: the relay genuinely has no record AND we have no
        // snapshot to preserve in Trash. If it's the open doc, demote the loaded
        // copy to a local document so the user keeps their work; otherwise just
        // drop the stale bookkeeping.
        if (isOpen) {
          persistence.demoteCurrentDocumentToLocal();
          useNotificationStore
            .getState()
            .warning(
              'This document is no longer on the relay. Your copy is now a local document.',
            );
        } else {
          registry.removeDocument(docId);
        }
        void RelayDocumentCache.remove(activeWorkspaceId(), docId);
      });
    },

    setHostConnected: (connected) => {
      set({ hostConnected: connected });

      if (!connected) {
        // Clear state on disconnect
        set({
          authenticated: false,
          error: null,
        });
      }
    },

    setAuthenticated: (authenticated, opts) => {
      set({ authenticated });

      // Fetch document list when authenticated, then refresh any stale cached
      // docs — unless the caller opts out (relay-doc boot, where the WS handshake
      // fetches once on its own).
      if (authenticated && docProvider && !opts?.skipFetch) {
        get().fetchDocumentList()
          .then(() => get().refreshStaleCachedDocuments())
          .catch(console.error);
      }
    },

    refreshDocumentList: () => {
      // Guard: nothing to refresh when signed out or without a live provider.
      // Keeps focus/visibility/online listeners cheap and side-effect-free in
      // the common signed-out / local-only-doc case.
      if (!docProvider || !get().authenticated) return;
      get()
        .fetchDocumentList()
        .then(() => get().refreshStaleCachedDocuments())
        .catch((e) => console.error('[relayDocumentStore] auto-refresh failed:', e));
    },

    clearRelayDocuments: () => {
      // Clear this host's relay docs from the registry, but keep the
      // offline-available ones visible (as cached) so a hard-disconnect doesn't
      // make cached relay docs disappear (JP-324). Their durable copies in
      // RelayDocumentCache outlive this clear; reconnect re-promotes them to
      // live. Scoped by host so other workspaces are untouched.
      const connection = useConnectionStore.getState();
      const host = connection.host?.address;
      if (host) {
        const offlineIds = new Set(RelayDocumentCache.getCachedIds(activeWorkspaceId()));
        useDocumentRegistry.getState().clearRemoteDocuments(host, offlineIds);
      }

      set({
        relayDocuments: {},
        loadingDocs: new Set(),
        documentCache: {},
        hostConnected: false,
        authenticated: false,
        lastSyncAt: null,
        error: null,
        isLoadingList: false,
      });
    },

    setError: (error) => {
      set({ error });
    },

    isRelayDocument: (docId) => {
      return docId in get().relayDocuments;
    },

    getMetadata: (docId) => {
      return get().relayDocuments[docId];
    },

    getCachedDocument: (docId) => {
      return get().documentCache[docId];
    },
    
    isAvailableOffline: (docId) => {
      // Check in-memory cache first
      if (get().documentCache[docId]) return true;
      // Check registry cache
      if (useDocumentRegistry.getState().getDocumentContent(docId)) return true;
      // Check persistent cache
      return RelayDocumentCache.has(activeWorkspaceId(), docId);
    },
    
    getOfflineDocumentIds: () => {
      return RelayDocumentCache.getCachedIds(activeWorkspaceId());
    },
    
    refreshStaleCachedDocuments: async () => {
      if (!docProvider) {
        console.log('[relayDocumentStore] Cannot refresh: not connected');
        return;
      }

      // Only consider docs cached *from the currently connected relay*.
      // Cached entries from a different host are left alone so switching
      // relays doesn't wipe their offline copies.
      const cachedIds = RelayDocumentCache.getCachedIds(activeWorkspaceId());
      if (cachedIds.length === 0) {
        return;
      }

      console.log(
        `[relayDocumentStore] Checking ${cachedIds.length} cached documents for staleness`,
      );

      // Get document list to check versions
      const relayDocs = get().relayDocuments;
      let refreshed = 0;
      let stranded = 0;

      for (const docId of cachedIds) {
        // JP-108: never stale-refresh the doc in an active collab session — its
        // content is owned by the live CRDT (relay-mediated + relay-persisted).
        // Invalidating/re-fetching its REST body would race the merge.
        if (isCollabContentDoc(docId)) continue;

        const remoteMeta = relayDocs[docId];
        if (!remoteMeta) {
          // The cache entry was recorded under this host, but the server
          // no longer lists it — deleted, wiped, or share revoked. The
          // offline copy is unreachable through the normal UX, so drop
          // it rather than logging on every reconnect forever.
          //
          // EXCEPT when the cached copy has offline edits still queued for
          // replay (JP-106). Evicting it here would destroy unsynced work
          // before the sync queue gets a chance to push it — and a doc
          // that diverged to a relay-unknown id is exactly the case the
          // server "doesn't list." Preserve it; the queue will reconcile.
          if (getSyncStateManager().hasPendingChanges(docId)) {
            console.warn(
              `[relayDocumentStore] Keeping cached doc ${docId} not listed by relay: ` +
                'it has unsynced offline edits queued for replay.',
            );
            continue;
          }
          // The relay lists it no longer, but we hold a cached copy — it was
          // deleted (or access revoked) while we were away. Don't silently drop
          // it: route through the same reaction as a live Deleted event (JP-175)
          // so the copy is preserved in Trash (or, if it's the open doc, demoted
          // to local) instead of vanishing on reconnect. strandOrDemoteDeletedDoc
          // reads the cached/in-memory copy, trashes it, and clears the relay
          // bookkeeping + offline cache. No deleter id → treated as foreign.
          try {
            get().strandOrDemoteDeletedDoc(docId);
            stranded++;
          } catch (error) {
            console.warn(
              `[relayDocumentStore] Failed to strand orphaned cache entry ${docId}:`,
              error,
            );
          }
          continue;
        }

        const cachedMeta = RelayDocumentCache.getMeta(activeWorkspaceId(), docId);
        if (!cachedMeta) continue;

        // Check if cache is stale (compare modifiedAt timestamps)
        const isStale = remoteMeta.modifiedAt > cachedMeta.cachedAt;

        if (isStale) {
          console.log(`[relayDocumentStore] Refreshing stale cached document: ${docId}`);
          try {
            // Clear memory cache to force re-fetch
            set((state) => {
              const documentCache = { ...state.documentCache };
              delete documentCache[docId];
              return { documentCache };
            });
            useDocumentRegistry.getState().invalidateContent(docId);

            // Re-fetch from server (this will update the cache)
            await get().loadRelayDocument(docId);
            refreshed++;
          } catch (error) {
            console.warn(`[relayDocumentStore] Failed to refresh ${docId}:`, error);
          }
        }
      }

      if (refreshed > 0) {
        console.log(`[relayDocumentStore] Refreshed ${refreshed} stale cached documents`);
      }
      if (stranded > 0) {
        console.log(
          `[relayDocumentStore] Stranded ${stranded} cached document(s) no longer on the relay into Trash`,
        );
      }
    },
    
    warmupCache: async () => {
      console.log('[relayDocumentStore] Warming up cache from IndexedDB...');
      
      try {
        // Preload all cached documents into memory
        const preloaded = await RelayDocumentCache.preloadAll(activeWorkspaceId());
        
        if (preloaded.size === 0) {
          console.log('[relayDocumentStore] No cached documents to warm up');
          return;
        }
        
        // Add to in-memory cache and registry
        const registry = useDocumentRegistry.getState();
        const documentCache: Record<string, DiagramDocument> = {};
        
        for (const [docId, doc] of preloaded) {
          documentCache[docId] = doc;
          registry.setDocumentContent(docId, doc);
        }
        
        set((state) => ({
          documentCache: {
            ...state.documentCache,
            ...documentCache,
          },
        }));
        
        console.log(`[relayDocumentStore] Warmed up ${preloaded.size} documents`);
      } catch (error) {
        console.error('[relayDocumentStore] Cache warmup failed:', error);
      }
    },
  })
);

/** Get the current document provider */
export function getDocProvider(): DocumentProvider | null {
  return docProvider;
}

/**
 * True when there's a usable Cloud session: a REST/live-authenticated provider
 * AND a present, unexpired relay token. This is the single "signed in to cloud"
 * gate for list / refresh / transfer / connected-UI — it counts a REST-only
 * (cached) session as well as a live WS one, unlike `isRelayAuthenticated()`
 * (`connectionStore.status`, WS-only). Mirrors the gate `refreshDocumentList`
 * already uses (`docProvider && authenticated`), now shared so the manual
 * refresh, the transfer execution gate, and the connect menu agree.
 *
 * Imperative variant for closures (e.g. the transfer-service `isAuthenticated`).
 */
export function isCloudSignedIn(): boolean {
  if (!useRelayDocumentStore.getState().authenticated) return false;
  const conn = useConnectionStore.getState();
  return conn.token !== null && (conn.tokenExpiresAt === null || Date.now() < conn.tokenExpiresAt);
}

/**
 * Reactive hook for `isCloudSignedIn` — subscribes to BOTH the relay-doc auth
 * flag and the connection token/expiry so components re-render on change.
 * (Expiry-by-elapsed-time isn't reactive, same as the prior `relaySessionUsable`;
 * a real expiry surfaces via the 401 → `onUnauthorized` path that clears auth.)
 */
export function useIsCloudSignedIn(): boolean {
  const authed = useRelayDocumentStore((s) => s.authenticated);
  const tokenUsable = useConnectionStore(
    (s) => s.token !== null && (s.tokenExpiresAt === null || Date.now() < s.tokenExpiresAt),
  );
  return authed && tokenUsable;
}

export default useRelayDocumentStore;
