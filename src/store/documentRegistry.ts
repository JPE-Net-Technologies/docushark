/**
 * Document Registry Store
 *
 * Unified store for managing all document types (local, remote, cached).
 * Replaces the separate document tracking in persistenceStore and teamDocumentStore.
 *
 * Phase 14.1.2 Collaboration Overhaul
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { DiagramDocument, DocumentMetadata } from '../types/Document';
import {
  type DocumentRecord,
  type LocalDocument,
  type RemoteDocument,
  type CachedDocument,
  type DocumentRegistryEntry,
  type DocumentFilter,
  type SyncState,
  type Permission,
  isLocalDocument,
  isRemoteDocument,
  isCachedDocument,
  toLocalDocument,
  toRemoteDocument,
  toCachedDocument,
  toRemoteFromCached,
} from '../types/DocumentRegistry';
import { RelayDocumentCache } from '../storage/RelayDocumentCache';
import { activeWorkspaceId } from './activeWorkspace';

/**
 * JP-117: resolve the relay a doc belongs to, first-set and never clobbered.
 * A doc's origin is the relay it was first seen on; re-registering it from a
 * different connected relay (a list fetch or broadcast while connected
 * elsewhere) must not re-home it. Priority: an existing record's origin, then
 * the durable cache (cold boot, registry empty), then — only for a genuine
 * first sighting — the passed (connected) relay.
 *
 * `'unknown'` is the sentinel for "relay identity wasn't known at registration"
 * (e.g. a doc registered during a REST-only list fetch, before `connection.host`
 * was set). It must NOT be treated as a real origin — otherwise a stale 'unknown'
 * (in memory or in the durable cache) shadows the real connected relayId forever,
 * so the doc never matches the connected relay and its sync badge sticks on
 * 'idle'. Skip it and adopt the passed (connected) relay instead.
 */
function resolveOriginRelayId(
  existing: DocumentRegistryEntry | undefined,
  id: string,
  passedRelayId: string,
): string {
  const isReal = (r: string | undefined): r is string => !!r && r !== 'unknown';
  const existingId =
    existing && (isRemoteDocument(existing.record) || isCachedDocument(existing.record))
      ? existing.record.relayId
      : undefined;
  if (isReal(existingId)) return existingId;
  const cachedId = RelayDocumentCache.getMeta(activeWorkspaceId(), id)?.relayId;
  if (isReal(cachedId)) return cachedId;
  return passedRelayId;
}

// ============ Types ============

/** Document registry state */
interface DocumentRegistryState {
  /** All documents indexed by ID */
  entries: Record<string, DocumentRegistryEntry>;
  /** Currently active document ID */
  activeDocumentId: string | null;
  /** Current filter for document list */
  filter: DocumentFilter;
  /** Last sync timestamp for remote documents */
  lastSyncAt: number | null;
  /** Whether currently fetching remote document list */
  isFetchingRemote: boolean;
  /** Error message if any */
  error: string | null;
}

/** Document registry actions */
interface DocumentRegistryActions {
  // ============ Document Management ============

  /** Register a local document */
  registerLocal: (metadata: DocumentMetadata) => void;

  /**
   * Reconcile the registry's LOCAL entries against the authoritative local
   * index (`persistenceStore.getDocumentList()`), called when the browser opens
   * / on manual refresh. Upsert-and-refresh only: it picks up renames /
   * creations / metadata drift that an individual `registerLocal` path missed.
   * Never demotes a `remote`/`cached` entry (relay docs are owned by the remote
   * refetch); never removes (deletions go through `removeDocument`).
   */
  reconcileLocalDocuments: (localMetas: DocumentMetadata[]) => void;

  /** Register a remote document */
  registerRemote: (
    metadata: DocumentMetadata,
    relayId: string,
    permission: Permission,
    syncState?: SyncState
  ) => void;

  /** Register multiple remote documents (batch) */
  registerRemoteBatch: (
    documents: DocumentMetadata[],
    relayId: string,
    permission: Permission
  ) => void;

  /** Update a document record */
  updateRecord: (id: string, updates: Partial<DocumentRecord>) => void;

  /** Remove a document from the registry */
  removeDocument: (id: string) => void;

  /**
   * Clear a host's relay documents from the registry. Entries listed in
   * `preserveOfflineIds` are kept as `cached` (a live `remote` entry is demoted)
   * so a hard-disconnect doesn't make offline-available team docs vanish
   * (JP-324); everything else for that relay is dropped. Omitting
   * `preserveOfflineIds` drops them all (legacy behavior). Scoped by `relayId`,
   * so other workspaces are untouched.
   */
  clearRemoteDocuments: (relayId: string, preserveOfflineIds?: ReadonlySet<string>) => void;

  /** Clear all documents */
  clearAll: () => void;

  // ============ Document Content ============

  /** Set document content (after loading) */
  setDocumentContent: (id: string, document: DiagramDocument) => void;

  /** Set loading state for a document */
  setDocumentLoading: (id: string, isLoading: boolean, error?: string) => void;

  /** Get cached document content */
  getDocumentContent: (id: string) => DiagramDocument | undefined;

  /** Invalidate cached document content */
  invalidateContent: (id: string) => void;

  // ============ Sync State ============

  /** Update sync state for a remote document */
  setSyncState: (id: string, syncState: SyncState) => void;

  /** Convert remote to cached (for offline) */
  convertToCached: (id: string) => void;

  /** Promote cached back to remote (when reconnected) */
  promoteCachedToRemote: (id: string) => void;

  /** Increment pending changes for cached document */
  incrementPendingChanges: (id: string) => void;

  /** Reset pending changes after sync */
  resetPendingChanges: (id: string) => void;

  // ============ Active Document ============

  /** Set the active document */
  setActiveDocument: (id: string | null) => void;

  /** Get the active document record */
  getActiveRecord: () => DocumentRecord | null;

  /** Get the active document content */
  getActiveDocument: () => DiagramDocument | undefined;

  // ============ Filtering & Queries ============

  /** Set filter for document list */
  setFilter: (filter: Partial<DocumentFilter>) => void;

  /** Get filtered document list */
  getFilteredDocuments: () => DocumentRecord[];

  /** Get all local documents */
  getLocalDocuments: () => LocalDocument[];

  /** Get all remote documents for a host */
  getRemoteDocuments: (relayId: string) => RemoteDocument[];

  /** Get all cached documents */
  getCachedDocuments: () => CachedDocument[];

  /** Check if a document exists */
  hasDocument: (id: string) => boolean;

  /** Get a document record by ID */
  getRecord: (id: string) => DocumentRecord | undefined;

  /** Check if a document is local */
  isLocalDocument: (id: string) => boolean;

  /** Check if a document is remote */
  isRemoteDocument: (id: string) => boolean;

  // ============ Utility ============

  /** Set fetching state */
  setFetchingRemote: (isFetching: boolean) => void;

  /** Set error */
  setError: (error: string | null) => void;

  /** Set last sync timestamp */
  setLastSyncAt: (timestamp: number) => void;

  /** Reset to initial state */
  reset: () => void;

  // ============ Migration ============

  /** Migrate from legacy persistence store documents */
  migrateFromLegacy: (documents: Record<string, DocumentMetadata>) => void;
}

// ============ Initial State ============

const initialState: DocumentRegistryState = {
  entries: {},
  activeDocumentId: null,
  filter: {
    types: ['local', 'remote', 'cached'],
  },
  lastSyncAt: null,
  isFetchingRemote: false,
  error: null,
};

// ============ Store ============

/**
 * Document registry store for unified document management.
 */
export const useDocumentRegistry = create<DocumentRegistryState & DocumentRegistryActions>()(
  persist(
    (set, get) => ({
      ...initialState,

      // ============ Document Management ============

      registerLocal: (metadata) => {
        const record: LocalDocument = toLocalDocument(metadata);
        set((state) => ({
          entries: {
            ...state.entries,
            [metadata.id]: {
              record,
              isLoading: false,
            },
          },
        }));
      },

      reconcileLocalDocuments: (localMetas) => {
        set((state) => {
          const next = { ...state.entries };
          let changed = false;
          for (const meta of localMetas) {
            // The index includes mirrored relay docs; those are owned by the
            // remote refetch (registerRemote) — skip them here so we never
            // demote a relay-backed doc to local in the UI (the JP-308 class).
            if (meta.isRelayDocument) continue;
            const existing = next[meta.id]?.record;
            if (existing && existing.type !== 'local') continue;
            const record = toLocalDocument(meta);
            // Cheap dirty-check: skip identical entries so we don't churn the
            // `entries` identity (which re-renders every card) when nothing drifted.
            if (
              existing &&
              existing.name === record.name &&
              existing.modifiedAt === record.modifiedAt &&
              existing.pageCount === record.pageCount
            ) {
              continue;
            }
            next[meta.id] = { record, isLoading: false };
            changed = true;
          }
          return changed ? { entries: next } : state;
        });
      },

      registerRemote: (metadata, relayId, permission, syncState = 'synced') => {
        set((state) => {
          const originRelayId = resolveOriginRelayId(state.entries[metadata.id], metadata.id, relayId);
          // JP-370: stamp the active workspace so the browser can scope the list
          // to it (two workspaces can share one relay host).
          const record: RemoteDocument = toRemoteDocument(
            metadata,
            originRelayId,
            activeWorkspaceId(),
            permission,
            syncState,
          );
          return {
            entries: {
              ...state.entries,
              [metadata.id]: {
                record,
                isLoading: false,
              },
            },
          };
        });
      },

      registerRemoteBatch: (documents, relayId, permission) => {
        set((state) => {
          const newEntries = { ...state.entries };
          const ws = activeWorkspaceId();
          for (const doc of documents) {
            const originRelayId = resolveOriginRelayId(state.entries[doc.id], doc.id, relayId);
            const record: RemoteDocument = toRemoteDocument(doc, originRelayId, ws, permission, 'synced');
            newEntries[doc.id] = {
              record,
              isLoading: false,
            };
          }
          return { entries: newEntries, lastSyncAt: Date.now() };
        });
      },

      updateRecord: (id, updates) => {
        set((state) => {
          const entry = state.entries[id];
          if (!entry) return state;

          return {
            entries: {
              ...state.entries,
              [id]: {
                ...entry,
                record: { ...entry.record, ...updates } as DocumentRecord,
              },
            },
          };
        });
      },

      removeDocument: (id) => {
        set((state) => {
          const newEntries = { ...state.entries };
          delete newEntries[id];

          // Clear active document if we're removing it
          const activeDocumentId = state.activeDocumentId === id ? null : state.activeDocumentId;

          return { entries: newEntries, activeDocumentId };
        });
      },

      clearRemoteDocuments: (relayId, preserveOfflineIds) => {
        set((state) => {
          const newEntries: Record<string, DocumentRegistryEntry> = {};

          for (const [id, entry] of Object.entries(state.entries)) {
            const record = entry.record;
            const isRelayDoc = isRemoteDocument(record) || isCachedDocument(record);

            // Local docs, and relay docs from a different host, are untouched.
            if (!isRelayDoc || record.relayId !== relayId) {
              newEntries[id] = entry;
              continue;
            }

            // This relay's docs: keep the offline-available ones so a
            // hard-disconnect doesn't make cached team docs disappear (JP-324).
            // A live `remote` entry is demoted to `cached` (still browsable, but
            // clearly offline); an already-`cached` entry is kept as-is. Entries
            // with no offline copy are dropped — nothing to show offline, and we
            // must not retain titles past a full sign-out.
            if (preserveOfflineIds?.has(id)) {
              newEntries[id] = isRemoteDocument(record)
                ? { ...entry, record: toCachedDocument(record) }
                : entry;
            }
            // else: drop (omit from newEntries)
          }

          return { entries: newEntries };
        });
      },

      clearAll: () => {
        set({ entries: {}, activeDocumentId: null });
      },

      // ============ Document Content ============

      setDocumentContent: (id, document) => {
        set((state) => {
          const entry = state.entries[id];
          if (!entry) return state;

          const newEntry: DocumentRegistryEntry = {
            record: entry.record,
            document,
            isLoading: false,
          };

          return {
            entries: {
              ...state.entries,
              [id]: newEntry,
            },
          };
        });
      },

      setDocumentLoading: (id, isLoading, error) => {
        set((state) => {
          const entry = state.entries[id];
          if (!entry) return state;

          const newEntry: DocumentRegistryEntry = {
            record: entry.record,
            isLoading,
          };
          // Only set document if it exists
          if (entry.document !== undefined) {
            newEntry.document = entry.document;
          }
          if (error !== undefined) {
            newEntry.loadError = error;
          }

          return {
            entries: {
              ...state.entries,
              [id]: newEntry,
            },
          };
        });
      },

      getDocumentContent: (id) => {
        return get().entries[id]?.document;
      },

      invalidateContent: (id) => {
        set((state) => {
          const entry = state.entries[id];
          if (!entry) return state;

          const newEntry: DocumentRegistryEntry = {
            record: entry.record,
            isLoading: entry.isLoading,
          };
          if (entry.loadError !== undefined) {
            newEntry.loadError = entry.loadError;
          }

          return {
            entries: {
              ...state.entries,
              [id]: newEntry,
            },
          };
        });
      },

      // ============ Sync State ============

      setSyncState: (id, syncState) => {
        set((state) => {
          const entry = state.entries[id];
          if (!entry || !isRemoteDocument(entry.record)) return state;

          return {
            entries: {
              ...state.entries,
              [id]: {
                ...entry,
                record: {
                  ...entry.record,
                  syncState,
                  lastSyncedAt: syncState === 'synced' ? Date.now() : entry.record.lastSyncedAt,
                },
              },
            },
          };
        });
      },

      convertToCached: (id) => {
        set((state) => {
          const entry = state.entries[id];
          if (!entry || !isRemoteDocument(entry.record)) return state;

          const cachedRecord = toCachedDocument(entry.record);

          return {
            entries: {
              ...state.entries,
              [id]: {
                ...entry,
                record: cachedRecord,
              },
            },
          };
        });
      },

      promoteCachedToRemote: (id) => {
        set((state) => {
          const entry = state.entries[id];
          if (!entry || !isCachedDocument(entry.record)) return state;

          const remoteRecord = toRemoteFromCached(entry.record, 'syncing');

          return {
            entries: {
              ...state.entries,
              [id]: {
                ...entry,
                record: remoteRecord,
              },
            },
          };
        });
      },

      incrementPendingChanges: (id) => {
        set((state) => {
          const entry = state.entries[id];
          if (!entry || !isCachedDocument(entry.record)) return state;

          return {
            entries: {
              ...state.entries,
              [id]: {
                ...entry,
                record: {
                  ...entry.record,
                  pendingChanges: entry.record.pendingChanges + 1,
                },
              },
            },
          };
        });
      },

      resetPendingChanges: (id) => {
        set((state) => {
          const entry = state.entries[id];
          if (!entry || !isCachedDocument(entry.record)) return state;

          return {
            entries: {
              ...state.entries,
              [id]: {
                ...entry,
                record: {
                  ...entry.record,
                  pendingChanges: 0,
                },
              },
            },
          };
        });
      },

      // ============ Active Document ============

      setActiveDocument: (id) => {
        set({ activeDocumentId: id });
      },

      getActiveRecord: () => {
        const state = get();
        if (!state.activeDocumentId) return null;
        return state.entries[state.activeDocumentId]?.record ?? null;
      },

      getActiveDocument: () => {
        const state = get();
        if (!state.activeDocumentId) return undefined;
        return state.entries[state.activeDocumentId]?.document;
      },

      // ============ Filtering & Queries ============

      setFilter: (filter) => {
        set((state) => ({
          filter: { ...state.filter, ...filter },
        }));
      },

      getFilteredDocuments: () => {
        const state = get();
        const { filter, entries } = state;
        // JP-370: scope relay-backed docs to the ACTIVE workspace. Two
        // workspaces can be served by the same relay host, and the registry
        // persists every workspace's entries across switches/sessions, so
        // without this the browser would mix them. Local docs are unscoped.
        const ws = activeWorkspaceId();

        return Object.values(entries)
          .map((entry) => entry.record)
          .filter((record) => {
            // Filter by type
            if (!filter.types.includes(record.type)) return false;

            // Workspace scope (remote/cached only).
            if (isRemoteDocument(record) && record.workspaceId !== ws) return false;
            if (isCachedDocument(record) && record.workspaceId !== ws) return false;

            // Filter by host (for remote/cached)
            if (filter.relayId) {
              if (isRemoteDocument(record) && record.relayId !== filter.relayId) return false;
              if (isCachedDocument(record) && record.relayId !== filter.relayId) return false;
            }

            // Filter by search query
            if (filter.searchQuery) {
              const query = filter.searchQuery.toLowerCase();
              if (!record.name.toLowerCase().includes(query)) return false;
            }

            return true;
          })
          .sort((a, b) => b.modifiedAt - a.modifiedAt);
      },

      getLocalDocuments: () => {
        const state = get();
        return Object.values(state.entries)
          .map((entry) => entry.record)
          .filter(isLocalDocument)
          .sort((a, b) => b.modifiedAt - a.modifiedAt);
      },

      getRemoteDocuments: (relayId) => {
        const state = get();
        return Object.values(state.entries)
          .map((entry) => entry.record)
          .filter((record): record is RemoteDocument =>
            isRemoteDocument(record) && record.relayId === relayId
          )
          .sort((a, b) => b.modifiedAt - a.modifiedAt);
      },

      getCachedDocuments: () => {
        const state = get();
        return Object.values(state.entries)
          .map((entry) => entry.record)
          .filter(isCachedDocument)
          .sort((a, b) => b.modifiedAt - a.modifiedAt);
      },

      hasDocument: (id) => {
        return id in get().entries;
      },

      getRecord: (id) => {
        return get().entries[id]?.record;
      },

      isLocalDocument: (id) => {
        const record = get().entries[id]?.record;
        return record ? isLocalDocument(record) : false;
      },

      isRemoteDocument: (id) => {
        const record = get().entries[id]?.record;
        return record ? isRemoteDocument(record) || isCachedDocument(record) : false;
      },

      // ============ Utility ============

      setFetchingRemote: (isFetching) => {
        set({ isFetchingRemote: isFetching });
      },

      setError: (error) => {
        set({ error });
      },

      setLastSyncAt: (timestamp) => {
        set({ lastSyncAt: timestamp });
      },

      reset: () => {
        set(initialState);
      },

      // ============ Migration ============

      migrateFromLegacy: (documents) => {
        set((state) => {
          const newEntries = { ...state.entries };

          for (const [id, metadata] of Object.entries(documents)) {
            // Skip if already exists
            if (newEntries[id]) continue;

            // Check if it's a relay document
            if (metadata.isRelayDocument) {
              // We don't know the relayId in migration, so we'll skip remote docs
              // They will be re-fetched from the host when connected
              continue;
            }

            // Register as local document
            const record: LocalDocument = toLocalDocument(metadata);
            newEntries[id] = {
              record,
              isLoading: false,
            };
          }

          return { entries: newEntries };
        });
      },
    }),
    {
      name: 'docushark-document-registry',
      // v2 (JP-370): relay records gained `workspaceId`. Pre-v2 remote/cached
      // entries have none, so they'd be filtered out of the (now
      // workspace-scoped) browser anyway; drop them on merge so the registry
      // doesn't carry un-scoped ghosts. They re-register with a workspaceId on
      // the next fetch. Local entries are unaffected.
      version: 2,
      // No structural transform needed (the drop of pre-v2 relay ghosts happens
      // in `merge`, which runs on every rehydrate). Present only so a v1→v2 bump
      // doesn't log zustand's "no migrate function" warning. Matches the
      // version-bump pattern in uiPreferencesStore / settingsStore.
      migrate: (persisted) => persisted as DocumentRegistryState,
      partialize: (state) => ({
        // Persist entries (record metadata) and filter preferences
        entries: state.entries,
        filter: state.filter,
        // Don't persist: activeDocumentId, lastSyncAt, isFetchingRemote, error
      }),
      // Only persist the record, not the full document content
      merge: (persisted, current) => {
        const persistedState = persisted as Partial<DocumentRegistryState>;

        // Rebuild entries without document content (will be re-fetched), dropping
        // pre-v2 relay records that predate workspace scoping (JP-370).
        const cleanedEntries: Record<string, DocumentRegistryEntry> = {};
        for (const [id, entry] of Object.entries(persistedState.entries ?? {})) {
          const rec = entry.record;
          if (
            (rec.type === 'remote' || rec.type === 'cached') &&
            typeof (rec as { workspaceId?: unknown }).workspaceId !== 'string'
          ) {
            continue; // un-scoped relay ghost → drop; refetch re-registers it
          }
          cleanedEntries[id] = {
            record: entry.record,
            isLoading: false,
          };
        }

        return {
          ...current,
          ...persistedState,
          entries: cleanedEntries,
        };
      },
    }
  )
);

// ============ Selectors ============

/**
 * JP-370: whether the active document is read-only for this user — a relay doc
 * (remote/cached) on which they hold only `viewer` permission. The relay is the
 * authority (it drops a non-editor's writes on the live path); this drives the
 * editor's read-only UX so a viewer doesn't make edits that just get reverted.
 * Local documents and owner/editor docs are editable.
 *
 * Non-hook form for imperative call-sites (the canvas Engine, CommandRegistry
 * keyboard guards) that need the same answer outside React render. The hook
 * below delegates to it so there's a single source of truth.
 */
export function isActiveDocReadOnly(): boolean {
  const state = useDocumentRegistry.getState();
  const rec = state.activeDocumentId ? state.entries[state.activeDocumentId]?.record : undefined;
  if (!rec) return false;
  return (rec.type === 'remote' || rec.type === 'cached') && rec.permission === 'viewer';
}

/** Reactive hook form of {@link isActiveDocReadOnly} for React components. */
export function useActiveDocReadOnly(): boolean {
  return useDocumentRegistry((state) => {
    const rec = state.activeDocumentId ? state.entries[state.activeDocumentId]?.record : undefined;
    if (!rec) return false;
    return (rec.type === 'remote' || rec.type === 'cached') && rec.permission === 'viewer';
  });
}

/**
 * Get the active document ID.
 */
export function useActiveDocumentId(): string | null {
  return useDocumentRegistry((state) => state.activeDocumentId);
}

/**
 * Get the active document record.
 */
export function useActiveDocumentRecord(): DocumentRecord | null {
  return useDocumentRegistry((state) =>
    state.activeDocumentId ? state.entries[state.activeDocumentId]?.record ?? null : null
  );
}

/**
 * Get the count of local documents.
 */
export function useLocalDocumentCount(): number {
  return useDocumentRegistry((state) =>
    Object.values(state.entries).filter((e) => isLocalDocument(e.record)).length
  );
}

/**
 * Get the count of remote documents.
 */
export function useRemoteDocumentCount(): number {
  return useDocumentRegistry((state) =>
    Object.values(state.entries).filter((e) => isRemoteDocument(e.record) || isCachedDocument(e.record)).length
  );
}

/**
 * Get fetching state.
 */
export function useIsFetchingRemote(): boolean {
  return useDocumentRegistry((state) => state.isFetchingRemote);
}

/**
 * Get error state.
 */
export function useRegistryError(): string | null {
  return useDocumentRegistry((state) => state.error);
}

export default useDocumentRegistry;