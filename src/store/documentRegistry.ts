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

/**
 * JP-117: resolve the relay a doc belongs to, first-set and never clobbered.
 * A doc's origin is the relay it was first seen on; re-registering it from a
 * different connected relay (a list fetch or broadcast while connected
 * elsewhere) must not re-home it. Priority: an existing record's origin, then
 * the durable cache (cold boot, registry empty), then — only for a genuine
 * first sighting — the passed (connected) relay.
 */
function resolveOriginRelayId(
  existing: DocumentRegistryEntry | undefined,
  id: string,
  passedRelayId: string,
): string {
  if (existing && (isRemoteDocument(existing.record) || isCachedDocument(existing.record))) {
    return existing.record.relayId;
  }
  return RelayDocumentCache.getMeta(id)?.relayId ?? passedRelayId;
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

  /** Clear all remote documents for a host */
  clearRemoteDocuments: (relayId: string) => void;

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

      registerRemote: (metadata, relayId, permission, syncState = 'synced') => {
        set((state) => {
          const originRelayId = resolveOriginRelayId(state.entries[metadata.id], metadata.id, relayId);
          const record: RemoteDocument = toRemoteDocument(metadata, originRelayId, permission, syncState);
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
          for (const doc of documents) {
            const originRelayId = resolveOriginRelayId(state.entries[doc.id], doc.id, relayId);
            const record: RemoteDocument = toRemoteDocument(doc, originRelayId, permission, 'synced');
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

      clearRemoteDocuments: (relayId) => {
        set((state) => {
          const newEntries: Record<string, DocumentRegistryEntry> = {};

          for (const [id, entry] of Object.entries(state.entries)) {
            if (isRemoteDocument(entry.record)) {
              if (entry.record.relayId !== relayId) {
                newEntries[id] = entry;
              }
            } else if (isCachedDocument(entry.record)) {
              if (entry.record.relayId !== relayId) {
                newEntries[id] = entry;
              }
            } else {
              // Keep local documents
              newEntries[id] = entry;
            }
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

        return Object.values(entries)
          .map((entry) => entry.record)
          .filter((record) => {
            // Filter by type
            if (!filter.types.includes(record.type)) return false;

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
      version: 1,
      partialize: (state) => ({
        // Persist entries (record metadata) and filter preferences
        entries: state.entries,
        filter: state.filter,
        // Don't persist: activeDocumentId, lastSyncAt, isFetchingRemote, error
      }),
      // Only persist the record, not the full document content
      merge: (persisted, current) => {
        const persistedState = persisted as Partial<DocumentRegistryState>;

        // Rebuild entries without document content (will be re-fetched)
        const cleanedEntries: Record<string, DocumentRegistryEntry> = {};
        for (const [id, entry] of Object.entries(persistedState.entries ?? {})) {
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