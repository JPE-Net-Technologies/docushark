/**
 * useDocumentBrowserModel — the headless engine behind the document browser.
 *
 * All the filtering / sorting / grouping / selection / transfer / collection
 * logic that used to live inside `DocumentBrowser.tsx` lives here, so it can be
 * driven by more than one chrome: the (legacy) Settings tab and the first-class
 * `DocumentsHome` surface (JP-218). The component(s) render the model; they own
 * no document logic of their own.
 *
 * Nothing here is presentational — it returns plain data + callbacks. The card
 * rendering lives in `DocumentList`, which consumes this model.
 */

import { useState, useCallback, useMemo, useEffect } from 'react';
import { useDocumentRegistry } from '../../store/documentRegistry';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useConnectionStore, useIsRelayAuthenticated } from '../../store/connectionStore';
import { useRelayDocumentStore, useIsCloudSignedIn } from '../../store/relayDocumentStore';
import { ensureCollabSessionForDoc } from '../../collaboration/ensureCollabSession';
import {
  computeOfflineStatus,
  makeAvailableOffline,
  type OfflineProgress,
  type OfflineStatus,
} from '../../store/offlineAvailability';
import { useUserStore } from '../../store/userStore';
import {
  useUIPreferencesStore,
  type DocumentBrowserSort,
} from '../../store/uiPreferencesStore';
import { useCollectionStore, type Collection } from '../../store/collectionStore';
import { syncedActions, assignDocumentsScoped, docScopeOf } from '../../store/collectionSync';
import { exportAndDownloadDocumentArchive, importDocumentArchive } from '../../storage/DocumentArchiveService';
import { getTransferService } from '../../services/DocumentTransferService';
import { useTransferStore, isTransferRunning } from '../../store/transferStore';
import { purgeLocalDocRoom } from '../../collaboration';
import { getDocumentMetadata } from '../../types/Document';
import type { DocumentRecord } from '../../types/DocumentRegistry';
import { confirmDialog, promptDialog } from '../confirm/confirmStore';

/** Document type axis the nav rail / filter row toggles. */
export type FilterMode = 'all' | 'local' | 'team' | 'cached';

/** Section key for documents that belong to no collection. */
export const UNASSIGNED_KEY = '__unassigned__';

export function compareRecords(a: DocumentRecord, b: DocumentRecord, sort: DocumentBrowserSort): number {
  switch (sort) {
    case 'modified-desc':
      return b.modifiedAt - a.modifiedAt;
    case 'modified-asc':
      return a.modifiedAt - b.modifiedAt;
    case 'name-asc':
      return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    case 'name-desc':
      return b.name.localeCompare(a.name, undefined, { sensitivity: 'base' });
    case 'created-desc':
      return b.createdAt - a.createdAt;
  }
}

/**
 * Map raw transfer error messages (often surfaced verbatim from the relay
 * REST layer) onto something a non-engineer can act on. Falls back to the
 * raw message when nothing matches so we never swallow a useful detail.
 */
export function friendlyTransferError(raw: string | undefined): string {
  if (!raw) return 'Unknown error';
  const lower = raw.toLowerCase();
  if (lower.includes('401') || lower.includes('unauthorized') || lower.includes('token'))
    return 'Relay session expired — please sign in again.';
  if (lower.includes('403') || lower.includes('forbidden') || lower.includes('not owner'))
    return 'Only the document owner can do that.';
  if (lower.includes('413') || lower.includes('too large') || lower.includes('payload'))
    return 'Document is too large for the relay.';
  if (lower.includes('409') || lower.includes('version conflict'))
    return 'The relay copy was changed since you opened it. Please reload and try again.';
  if (lower.includes('network') || lower.includes('fetch') || lower.includes('timed out'))
    return "Couldn't reach the relay. Check your connection and try again.";
  return raw;
}

export const SORT_LABELS: Record<DocumentBrowserSort, string> = {
  'modified-desc': 'Recently modified',
  'modified-asc': 'Least recently modified',
  'name-asc': 'Name (A–Z)',
  'name-desc': 'Name (Z–A)',
  'created-desc': 'Recently created',
};

/** A grouping bucket: a collection (or the synthetic "Unassigned") + its docs. */
export interface GroupedSection {
  key: string;
  collection: Collection | null;
  docs: DocumentRecord[];
}

export interface DocumentBrowserModel {
  // Filtered data
  documentList: DocumentRecord[];
  groupedSections: GroupedSection[] | null;
  documentCounts: { total: number; local: number; team: number; cached: number };
  // Collections
  collections: Collection[];
  collectionsMap: Record<string, Collection>;
  assignments: Record<string, string>;
  accentByDoc: Map<string, { name: string; color?: string }>;
  // Axis / view state
  filterMode: FilterMode;
  setFilterMode: (mode: FilterMode) => void;
  searchQuery: string;
  setSearchQuery: (q: string) => void;
  /** Nav-rail single-collection filter (null = no collection filter). */
  collectionFilter: string | null;
  setCollectionFilter: (id: string | null) => void;
  view: ReturnType<typeof useUIPreferencesStore.getState>['documentBrowserView'];
  sort: DocumentBrowserSort;
  groupBy: ReturnType<typeof useUIPreferencesStore.getState>['documentBrowserGroupBy'];
  setView: (v: ReturnType<typeof useUIPreferencesStore.getState>['documentBrowserView']) => void;
  setSort: (s: DocumentBrowserSort) => void;
  setGroupBy: (g: ReturnType<typeof useUIPreferencesStore.getState>['documentBrowserGroupBy']) => void;
  collapsedMap: Record<string, boolean>;
  toggleCollapsed: (key: string) => void;
  // Selection
  selectedIds: Set<string>;
  hasSelection: boolean;
  handleSelectToggle: (id: string, mods: { shift: boolean; meta: boolean }) => void;
  clearSelection: () => void;
  assignMenuOpen: boolean;
  setAssignMenuOpen: (v: boolean | ((p: boolean) => boolean)) => void;
  activeCollectionMenu: string | null;
  setActiveCollectionMenu: (v: string | null) => void;
  // Dialog state
  pdfExportOpen: boolean;
  setPdfExportOpen: (v: boolean) => void;
  permissionsDocId: string | null;
  setPermissionsDocId: (v: string | null) => void;
  // Offline cache surfacing (JP-281)
  offlineStatuses: Map<string, OfflineStatus>;
  offlineProgress: Map<string, OfflineProgress>;
  // Flags / identity
  isInTeamMode: boolean;
  isConnectedToHost: boolean;
  isHost: boolean;
  relaySessionUsable: boolean;
  connectedRelayAddress: string | undefined;
  isAvailableOffline: (id: string) => boolean;
  currentDocumentId: string | null;
  currentUser: ReturnType<typeof useUserStore.getState>['currentUser'];
  error: string | null;
  isLoading: boolean;
  transferPhase: ReturnType<typeof useTransferStore.getState>['phase'];
  transferDirection: ReturnType<typeof useTransferStore.getState>['direction'];
  // Document-level actions
  handleNewDocument: () => void;
  handleSave: () => void;
  handleRefresh: () => void;
  handleImport: () => void;
  handleExport: () => void;
  handleOpen: (docId: string) => Promise<void>;
  handleDelete: (docId: string) => Promise<void>;
  handlePermanentDelete: (docId: string) => Promise<void>;
  handleRename: (docId: string, newName: string) => void;
  handlePublishToTeam: (docId: string) => Promise<void>;
  handleMoveToPersonal: (docId: string) => Promise<void>;
  handleMakeAvailableOffline: (id: string) => Promise<void>;
  // Bulk actions
  handleBulkAssign: (collectionId: string | null) => void;
  handleBulkAssignNewCollection: () => void;
  handleBulkDelete: () => Promise<void>;
  handleBulkExport: () => Promise<void>;
  // Collection management
  handleCreateCollection: () => void;
  handleRenameCollection: (collection: Collection) => void;
  handleDeleteCollection: (collection: Collection) => void;
  handleRecolor: (collection: Collection, color: string | undefined) => void;
  handleAssignToCollection: (docId: string, collectionId: string | null) => void;
  handleAssignNewCollectionFor: (docId: string) => void;
}

export function useDocumentBrowserModel(): DocumentBrowserModel {
  // Registry store
  const entries = useDocumentRegistry((s) => s.entries);
  const isFetchingRemote = useDocumentRegistry((s) => s.isFetchingRemote);
  const registryError = useDocumentRegistry((s) => s.error);
  const getFilteredDocuments = useDocumentRegistry((s) => s.getFilteredDocuments);
  const setFilter = useDocumentRegistry((s) => s.setFilter);

  // Persistence store
  const currentDocumentId = usePersistenceStore((s) => s.currentDocumentId);
  const newDocument = usePersistenceStore((s) => s.newDocument);
  const saveDocument = usePersistenceStore((s) => s.saveDocument);
  const loadDocument = usePersistenceStore((s) => s.loadDocument);
  const deleteDocument = usePersistenceStore((s) => s.deleteDocument);
  const permanentlyDeleteDocument = usePersistenceStore((s) => s.permanentlyDeleteDocument);
  const renameDocument = usePersistenceStore((s) => s.renameDocument);

  // Relay stores
  const isRelayLive = useIsRelayAuthenticated();
  const authenticated = useRelayDocumentStore((s) => s.authenticated);
  // "Signed in to cloud" — a usable session (REST-only cached OR live WS). Gates
  // list/refresh/transfer, distinct from `isConnectedToHost` (live WS), which
  // stays the source for the "Connected" vs "Signed in" label in DocumentsHome.
  const signedIn = useIsCloudSignedIn();
  const isLoadingList = useRelayDocumentStore((s) => s.isLoadingList);
  const teamStoreError = useRelayDocumentStore((s) => s.error);
  const fetchDocumentList = useRelayDocumentStore((s) => s.fetchDocumentList);
  const loadRelayDocument = useRelayDocumentStore((s) => s.loadRelayDocument);
  const deleteFromHost = useRelayDocumentStore((s) => s.deleteFromHost);
  const trashRelayDocument = useRelayDocumentStore((s) => s.trashRelayDocument);
  const isAvailableOffline = useRelayDocumentStore((s) => s.isAvailableOffline);

  // Whether we have a usable relay session for *transfers*. Gates the
  // publish/move affordances on a VALID CACHED TOKEN, not the live WS — opening
  // a local doc tears down the per-doc WS (ensureCollabSession → leaveDocument),
  // which flips `isRelayLive`/`hostConnected` false even though the token + REST
  // provider survive (preserveAuth). Transfers run over the REST provider, so
  // they must stay available while signed in; otherwise being on a local doc
  // confusingly hides the "Move to Relay" action (JP-211 transfer-gating bug).
  const relaySessionUsable = useConnectionStore(
    (s) => s.token !== null && (s.tokenExpiresAt === null || Date.now() < s.tokenExpiresAt),
  );

  // Currently-connected relay address (host:port) — drives per-card relay
  // badges and the "By relay" section ordering. "Connected" must mean *actually
  // connected*, not merely that a relay address is configured: opening a doc
  // calls `connectionStore.setHost(address)` (engine start) even while offline,
  // so keying off `host?.address` alone falsely flips every card to
  // connected/synced. Gate on the real WS-connected signal (`hostConnected`,
  // which only goes true on an authenticated connection).
  const relayHostAddress = useConnectionStore((s) => s.host?.address);
  const hostConnected = useRelayDocumentStore((s) => s.hostConnected);
  const connectedRelayAddress = hostConnected ? relayHostAddress : undefined;

  // User store
  const currentUser = useUserStore((s) => s.currentUser);

  // Transfer progress (Local ↔ Cloud)
  const transferPhase = useTransferStore((s) => s.phase);
  const transferDirection = useTransferStore((s) => s.direction);

  // UI preferences
  const view = useUIPreferencesStore((s) => s.documentBrowserView);
  const sort = useUIPreferencesStore((s) => s.documentBrowserSort);
  const groupBy = useUIPreferencesStore((s) => s.documentBrowserGroupBy);
  const collapsedMap = useUIPreferencesStore((s) => s.documentBrowserCollapsed);
  const setView = useUIPreferencesStore((s) => s.setDocumentBrowserView);
  const setSort = useUIPreferencesStore((s) => s.setDocumentBrowserSort);
  const setGroupBy = useUIPreferencesStore((s) => s.setDocumentBrowserGroupBy);
  const toggleCollapsed = useUIPreferencesStore((s) => s.toggleDocumentBrowserGroupCollapsed);

  // Collection store
  const collectionsMap = useCollectionStore((s) => s.collections);
  const assignments = useCollectionStore((s) => s.assignments);
  // Mutations route through `syncedActions` (collectionSync) so each change
  // writes through to the relay for relay-hosted docs (JP-159). The store stays
  // network-free; `syncedActions` is a stable module import (no dep needed).

  const collections = useMemo<Collection[]>(
    () => Object.values(collectionsMap).sort((a, b) => a.order - b.order),
    [collectionsMap]
  );

  // Local state
  const [filterMode, setFilterModeState] = useState<FilterMode>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [collectionFilter, setCollectionFilter] = useState<string | null>(null);
  const [pdfExportOpen, setPdfExportOpen] = useState(false);
  const [permissionsDocId, setPermissionsDocId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [assignMenuOpen, setAssignMenuOpen] = useState(false);
  const [activeCollectionMenu, setActiveCollectionMenu] = useState<string | null>(null);
  // Offline-cache surfacing (JP-281): passive per-doc status + in-flight prefetch progress.
  const [offlineStatuses, setOfflineStatuses] = useState<Map<string, OfflineStatus>>(new Map());
  const [offlineProgress, setOfflineProgress] = useState<Map<string, OfflineProgress>>(new Map());

  const isInTeamMode = isRelayLive;
  const isConnectedToHost = isRelayLive && authenticated;
  const isHost = false;

  // Filtered + sorted documents (flat list — the same list used to drive grouping).
  const documentList = useMemo(() => {
    const allDocs = getFilteredDocuments();
    let filtered = allDocs;
    if (filterMode === 'local') {
      filtered = allDocs.filter((d) => d.type === 'local');
    } else if (filterMode === 'team') {
      filtered = allDocs.filter((d) => d.type === 'remote');
    } else if (filterMode === 'cached') {
      filtered = allDocs.filter((d) => d.type === 'cached');
    }

    // Nav-rail single-collection filter (DocumentsHome). Independent of the
    // type axis above so "Local + Collection X" composes naturally.
    if (collectionFilter !== null) {
      filtered = filtered.filter((d) => assignments[d.id] === collectionFilter);
    }

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((d) => d.name.toLowerCase().includes(query));
    }

    return [...filtered].sort((a, b) => compareRecords(a, b, sort));
  }, [entries, getFilteredDocuments, filterMode, collectionFilter, assignments, searchQuery, sort]);

  // JP-281: compute each relay-backed doc's offline-ready status from local
  // caches (network-free). Recomputes when the list or registry changes so the
  // badge reflects view-driven caching that lands in the background.
  useEffect(() => {
    let cancelled = false;
    const records = documentList.filter((d) => d.type !== 'local');
    if (records.length === 0) {
      setOfflineStatuses((prev) => (prev.size === 0 ? prev : new Map()));
      return;
    }
    // allSettled (not all): one doc whose status can't be computed must not wipe
    // every other doc's badge. Merge results so unaffected entries keep their
    // refs, and prune statuses for docs that left the list.
    const liveIds = new Set(records.map((r) => r.id));
    void Promise.allSettled(records.map((r) => computeOfflineStatus(r))).then((results) => {
      if (cancelled) return;
      setOfflineStatuses((prev) => {
        const next = new Map(prev);
        results.forEach((res, i) => {
          if (res.status === 'fulfilled') next.set(records[i]!.id, res.value);
        });
        for (const id of next.keys()) {
          if (!liveIds.has(id)) next.delete(id);
        }
        return next;
      });
    });
    return () => {
      cancelled = true;
    };
  }, [documentList]);

  // JP-281: proactively cache a doc's body + all referenced blobs for offline use.
  const handleMakeAvailableOffline = useCallback(async (id: string) => {
    const record = useDocumentRegistry.getState().getRecord(id);
    if (!record) return;
    setOfflineProgress((m) => new Map(m).set(id, { done: 0, total: 0 }));
    try {
      const status = await makeAvailableOffline(record, (p) => {
        setOfflineProgress((m) => new Map(m).set(id, p));
      });
      setOfflineStatuses((m) => new Map(m).set(id, status));
    } catch (e) {
      console.warn('[DocumentBrowser] Make available offline failed:', id, e);
    } finally {
      setOfflineProgress((m) => {
        const next = new Map(m);
        next.delete(id);
        return next;
      });
    }
  }, []);

  // Bucket documents by collection when grouping is enabled.
  const groupedSections = useMemo<GroupedSection[] | null>(() => {
    if (groupBy !== 'collection') return null;
    const buckets = new Map<string, DocumentRecord[]>();
    for (const doc of documentList) {
      const cid = assignments[doc.id];
      const key = cid && collectionsMap[cid] ? cid : UNASSIGNED_KEY;
      const arr = buckets.get(key);
      if (arr) arr.push(doc);
      else buckets.set(key, [doc]);
    }
    const sections: GroupedSection[] = [];
    for (const c of collections) {
      sections.push({ key: c.id, collection: c, docs: buckets.get(c.id) ?? [] });
    }
    sections.push({
      key: UNASSIGNED_KEY,
      collection: null,
      docs: buckets.get(UNASSIGNED_KEY) ?? [],
    });
    return sections;
  }, [groupBy, documentList, assignments, collectionsMap, collections]);

  // Count documents by type
  const documentCounts = useMemo(() => {
    const allDocs = Object.values(entries).map((e) => e.record);
    return {
      total: allDocs.length,
      local: allDocs.filter((d) => d.type === 'local').length,
      team: allDocs.filter((d) => d.type === 'remote').length,
      cached: allDocs.filter((d) => d.type === 'cached').length,
    };
  }, [entries]);

  // Clear selection when the visible list changes meaningfully.
  useEffect(() => {
    setSelectedIds((prev) => {
      if (prev.size === 0) return prev;
      const visible = new Set(documentList.map((d) => d.id));
      const next = new Set<string>();
      for (const id of prev) if (visible.has(id)) next.add(id);
      return next.size === prev.size ? prev : next;
    });
  }, [documentList]);

  // Handlers
  const handleNewDocument = useCallback(() => newDocument(), [newDocument]);
  const handleSave = useCallback(() => saveDocument(), [saveDocument]);

  // Single shared refresh path — used by the on-open mount effect AND the manual
  // Refresh button. Reconcile LOCAL docs from the authoritative index every time
  // (unconditional; local docs drift even offline — renames/creates that an
  // individual registerLocal path missed), then refetch REMOTE when connected.
  const handleRefresh = useCallback(() => {
    useDocumentRegistry
      .getState()
      .reconcileLocalDocuments(usePersistenceStore.getState().getDocumentList());
    if (signedIn || isHost) fetchDocumentList();
  }, [fetchDocumentList, signedIn, isHost]);

  const handleOpen = useCallback(
    async (docId: string) => {
      if (docId === currentDocumentId) return;
      const entry = entries[docId];
      if (!entry) return;
      const record = entry.record;
      if (record.type === 'remote' || record.type === 'cached') {
        try {
          const doc = await loadRelayDocument(docId);
          usePersistenceStore.getState().loadRemoteDocument(doc);
        } catch (error) {
          console.error('Failed to load relay document:', error);
        }
      } else {
        loadDocument(docId);
      }
    },
    [currentDocumentId, entries, loadRelayDocument, loadDocument]
  );

  // Soft delete → Trash. Relay docs hard-delete on the relay (no relay-side
  // soft-delete yet — JP-294) but the deleter keeps a recoverable stranded copy
  // in their own Trash. Local/cached docs move to the local Trash.
  const handleDelete = useCallback(
    async (docId: string) => {
      const entry = entries[docId];
      if (!entry) return;
      const record = entry.record;
      if (record.type === 'remote') {
        try {
          await trashRelayDocument(docId);
        } catch (error) {
          console.error('Failed to delete relay document:', error);
        }
        // Purge the doc's local prose CRDT room so its y-indexeddb DB doesn't
        // linger forever (leaveDocument keeps room data on disk; nothing else
        // cleans it on delete) and can't stale-merge if the id is ever reused.
        // Best-effort: a no-op if the doc is currently open (its room is locked).
        await purgeLocalDocRoom(docId);
      } else {
        deleteDocument(docId);
      }
    },
    [entries, trashRelayDocument, deleteDocument]
  );

  // Permanent delete → bypass the Trash. Relay docs hard-delete on the relay
  // and keep NO local copy (other editors still strand it). Local/cached docs
  // are hard-removed and their blobs released.
  const handlePermanentDelete = useCallback(
    async (docId: string) => {
      const entry = entries[docId];
      if (!entry) return;
      const record = entry.record;
      if (record.type === 'remote') {
        try {
          await deleteFromHost(docId);
        } catch (error) {
          console.error('Failed to permanently delete relay document:', error);
        }
        await purgeLocalDocRoom(docId);
      } else {
        permanentlyDeleteDocument(docId);
      }
    },
    [entries, deleteFromHost, permanentlyDeleteDocument]
  );

  const handleRename = useCallback(
    (docId: string, newName: string) => {
      if (docId === currentDocumentId) renameDocument(newName);
    },
    [currentDocumentId, renameDocument]
  );

  const handlePublishToTeam = useCallback(
    async (docId: string) => {
      if (!currentUser?.id) return;
      if (isTransferRunning(useTransferStore.getState().phase)) {
        const { useNotificationStore } = await import('../../store/notificationStore');
        useNotificationStore.getState().warning('A document transfer is already in progress.');
        return;
      }
      const service = getTransferService();
      if (!service) {
        const { useNotificationStore } = await import('../../store/notificationStore');
        useNotificationStore.getState().error('Transfer service not ready');
        return;
      }

      // Persist any unsaved edits before snapshotting for transfer.
      if (docId === currentDocumentId) {
        saveDocument();
      }

      useTransferStore.getState().begin(docId, 'to-relay');
      const result = await service.transferToTeam(docId, {
        onProgress: (phase) => useTransferStore.getState().setPhase(phase),
      });
      if (!result.success) {
        useTransferStore.getState().fail(friendlyTransferError(result.error));
        const { useNotificationStore } = await import('../../store/notificationStore');
        useNotificationStore
          .getState()
          .error(`Move to Relay failed: ${friendlyTransferError(result.error)}`);
        return;
      }
      useDocumentRegistry.getState().removeDocument(docId);

      // The doc is now a workspace doc; drop any LOCAL collection membership so it
      // lands Unassigned in the workspace (a local collection can't hold a
      // workspace doc — JP-366) instead of leaving a dangling `collectionId` the
      // workspace doesn't know. The user re-files it into a workspace collection.
      useCollectionStore.getState().assignDocument(docId, null);

      // Purge any stale local prose CRDT room BEFORE the doc re-joins as a relay
      // doc. A doc previously moved Cloud→Personal keeps its `host:docId`
      // y-indexeddb room on disk; without this, re-promote reloads that stale
      // prose and merges it with the relay's fresh re-seed from richTextPages —
      // duplicating every page (JP-282). richTextPages (just saved to the relay)
      // is the source of truth, so the client adopts the relay copy cleanly.
      await purgeLocalDocRoom(docId);

      await fetchDocumentList();

      // If the promoted doc is the one open in the editor and we have an
      // authenticated relay session, join it on the relay so edits sync
      // immediately (convert-in-place keeps the same id). This is what turns
      // the post-sign-in "JOIN_DOC for unknown doc" rejection into a real
      // synced session.
      if (docId === currentDocumentId && signedIn) {
        // Open the just-promoted (now relay) doc live. `ensureCollabSessionForDoc`
        // handles both a REST-only sign-in (cold start → `startSession`) and an
        // already-active session (→ `switchDocument`); calling `switchDocument`
        // directly assumes an active session config, which a REST-only sign-in
        // doesn't have.
        await ensureCollabSessionForDoc(docId);
      }
      useTransferStore.getState().reset();
    },
    [currentDocumentId, saveDocument, fetchDocumentList, currentUser, signedIn]
  );

  const handleMoveToPersonal = useCallback(
    async (docId: string) => {
      const entry = entries[docId];
      if (!entry) return;
      const record = entry.record;
      if (record.type !== 'remote') return;
      if (isTransferRunning(useTransferStore.getState().phase)) {
        const { useNotificationStore } = await import('../../store/notificationStore');
        useNotificationStore.getState().warning('A document transfer is already in progress.');
        return;
      }
      const service = getTransferService();
      if (!service) {
        const { useNotificationStore } = await import('../../store/notificationStore');
        useNotificationStore.getState().error('Transfer service not ready');
        return;
      }
      try {
        // Pull the latest snapshot from the relay into localStorage so the
        // transfer service can read it as the source-of-truth before
        // mutating its relay-side fields.
        const doc = await loadRelayDocument(docId);
        usePersistenceStore.getState().loadRemoteDocument(doc);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to fetch relay document';
        const { useNotificationStore } = await import('../../store/notificationStore');
        useNotificationStore
          .getState()
          .error(`Move to Personal failed: ${friendlyTransferError(message)}`);
        return;
      }

      useTransferStore.getState().begin(docId, 'to-personal');
      const result = await service.transferToPersonal(docId, {
        onProgress: (phase) => useTransferStore.getState().setPhase(phase),
      });
      if (!result.success) {
        useTransferStore.getState().fail(friendlyTransferError(result.error));
        const { useNotificationStore } = await import('../../store/notificationStore');
        useNotificationStore
          .getState()
          .error(`Move to Personal failed: ${friendlyTransferError(result.error)}`);
        return;
      }
      // The doc was just DELETEd from the relay, so refresh the remote list
      // (it'll be absent from it now) and then re-register the converted doc as
      // Local. fetchDocumentList only ever registers *remote* docs, so without
      // this registerLocal the now-personal doc would vanish from the browser
      // even though its data is safely in localStorage.
      await fetchDocumentList();
      if (result.document) {
        useDocumentRegistry.getState().registerLocal(getDocumentMetadata(result.document));
      }
      useTransferStore.getState().reset();
    },
    [entries, loadRelayDocument, fetchDocumentList]
  );

  const handleExport = useCallback(() => {
    if (!currentDocumentId) return;
    saveDocument();
    exportAndDownloadDocumentArchive(currentDocumentId).catch((err) => {
      console.error('Failed to export document archive:', err);
    });
  }, [currentDocumentId, saveDocument]);

  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.docushark';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        importDocumentArchive(file).catch((err) => {
          console.error('Failed to import document archive:', err);
        });
      }
    };
    input.click();
  }, []);

  const setFilterMode = useCallback(
    (mode: FilterMode) => {
      setFilterModeState(mode);
      const types: ('local' | 'remote' | 'cached')[] =
        mode === 'all'
          ? ['local', 'remote', 'cached']
          : mode === 'local'
            ? ['local']
            : mode === 'team'
              ? ['remote']
              : ['cached'];
      setFilter({ types });
    },
    [setFilter]
  );

  // Multi-select handlers
  const handleSelectToggle = useCallback(
    (id: string, mods: { shift: boolean; meta: boolean }) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);
        if (mods.shift && lastSelectedId && lastSelectedId !== id) {
          const ids = documentList.map((d) => d.id);
          const a = ids.indexOf(lastSelectedId);
          const b = ids.indexOf(id);
          if (a !== -1 && b !== -1) {
            const [start, end] = a < b ? [a, b] : [b, a];
            for (let i = start; i <= end; i++) {
              const v = ids[i];
              if (v !== undefined) next.add(v);
            }
            return next;
          }
        }
        if (next.has(id)) next.delete(id);
        else next.add(id);
        return next;
      });
      setLastSelectedId(id);
    },
    [documentList, lastSelectedId]
  );

  const clearSelection = useCallback(() => {
    setSelectedIds(new Set());
    setLastSelectedId(null);
  }, []);

  // Clear selection when filters / sort / grouping change.
  useEffect(() => {
    clearSelection();
  }, [filterMode, collectionFilter, sort, groupBy, clearSelection]);

  const handleBulkAssign = useCallback(
    (collectionId: string | null) => {
      assignDocumentsScoped(Array.from(selectedIds), collectionId);
      setAssignMenuOpen(false);
    },
    [selectedIds]
  );

  const handleBulkAssignNewCollection = useCallback(async () => {
    const name = await promptDialog({
      title: 'New collection',
      label: 'Collection name',
      placeholder: 'e.g. Q3 Planning',
      confirmLabel: 'Create',
    });
    if (!name) return;
    const id = syncedActions.createCollection(name);
    if (id) assignDocumentsScoped(Array.from(selectedIds), id);
    setAssignMenuOpen(false);
  }, [selectedIds]);

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selectedIds);
    const deletable = ids.filter((id) => {
      const entry = entries[id];
      if (!entry) return false;
      return canDelete(entry.record, currentUser?.id, currentUser?.role);
    });
    if (deletable.length === 0) return;
    const hasRelay = deletable.some((id) => entries[id]?.record.type === 'remote');
    const n = deletable.length;
    const detail = hasRelay
      ? signedIn
        ? 'Cloud documents are removed from the workspace for everyone; a recoverable copy is kept in your Trash.'
        : 'You’re offline — cloud documents move to your Trash now and leave the workspace once you reconnect.'
      : undefined;
    const ok = await confirmDialog({
      title: `Delete ${n} document${n === 1 ? '' : 's'}?`,
      message: 'They’ll be moved to Trash and removed after 7 days.',
      ...(detail ? { details: detail } : {}),
      confirmLabel: 'Delete',
      danger: true,
    });
    if (!ok) return;
    for (const id of deletable) {
      await handleDelete(id);
    }
    clearSelection();
  }, [selectedIds, entries, currentUser, handleDelete, clearSelection, signedIn]);

  const handleBulkExport = useCallback(async () => {
    const ids = Array.from(selectedIds);
    for (const id of ids) {
      try {
        await exportAndDownloadDocumentArchive(id);
      } catch (err) {
        console.error('Failed to export', id, err);
      }
    }
  }, [selectedIds]);

  // Collection management
  const handleCreateCollection = useCallback(async () => {
    const name = await promptDialog({
      title: 'New collection',
      label: 'Collection name',
      placeholder: 'e.g. Q3 Planning',
      confirmLabel: 'Create',
    });
    if (!name) return;
    const id = syncedActions.createCollection(name);
    // Surface the new (empty) collection so it's immediately visible + manageable.
    if (id) setGroupBy('collection');
  }, [setGroupBy]);

  const handleRenameCollection = useCallback(
    async (collection: Collection) => {
      const name = await promptDialog({
        title: 'Rename collection',
        label: 'Collection name',
        initialValue: collection.name,
        confirmLabel: 'Rename',
      });
      if (!name) return;
      syncedActions.renameCollection(collection.id, name);
      setActiveCollectionMenu(null);
    },
    []
  );

  const handleDeleteCollection = useCallback(
    async (collection: Collection) => {
      const ok = await confirmDialog({
        title: `Delete collection “${collection.name}”?`,
        message: 'The collection is removed. The documents inside it aren’t deleted — they become Unassigned.',
        confirmLabel: 'Delete collection',
        danger: true,
      });
      if (!ok) return;
      syncedActions.deleteCollection(collection.id);
      setActiveCollectionMenu(null);
    },
    []
  );

  const handleRecolor = useCallback(
    (collection: Collection, color: string | undefined) => {
      syncedActions.recolorCollection(collection.id, color);
    },
    []
  );

  // Per-card collection move (single doc) — assignment was previously bulk-only.
  const handleAssignToCollection = useCallback(
    (docId: string, collectionId: string | null) => {
      assignDocumentsScoped([docId], collectionId);
    },
    []
  );

  const handleAssignNewCollectionFor = useCallback(async (docId: string) => {
    const name = await promptDialog({
      title: 'New collection',
      label: 'Collection name',
      placeholder: 'e.g. Q3 Planning',
      confirmLabel: 'Create',
    });
    if (!name) return;
    // Create the collection in the document's own scope so it can hold it
    // (a workspace doc → workspace collection, a local doc → local collection).
    const id = syncedActions.createCollection(name, undefined, docScopeOf(docId));
    if (id) assignDocumentsScoped([docId], id);
  }, []);

  const error = registryError || teamStoreError;
  const isLoading = isFetchingRemote || isLoadingList;
  const hasSelection = selectedIds.size > 0;

  // Stable per-doc collection accent so DocumentCard's memo can skip cards
  // unaffected by an action elsewhere (e.g. an offline-prefetch progress tick on
  // another card no longer re-renders the whole list).
  const accentByDoc = useMemo(() => {
    const map = new Map<string, { name: string; color?: string }>();
    if (groupBy === 'collection') return map; // membership shown via section headers instead
    for (const docId of Object.keys(assignments)) {
      const cid = assignments[docId];
      const collection = cid ? collectionsMap[cid] : undefined;
      if (!collection) continue;
      map.set(
        docId,
        collection.color !== undefined
          ? { name: collection.name, color: collection.color }
          : { name: collection.name },
      );
    }
    return map;
  }, [assignments, collectionsMap, groupBy]);

  return {
    documentList,
    groupedSections,
    documentCounts,
    collections,
    collectionsMap,
    assignments,
    accentByDoc,
    filterMode,
    setFilterMode,
    searchQuery,
    setSearchQuery,
    collectionFilter,
    setCollectionFilter,
    view,
    sort,
    groupBy,
    setView,
    setSort,
    setGroupBy,
    collapsedMap,
    toggleCollapsed,
    selectedIds,
    hasSelection,
    handleSelectToggle,
    clearSelection,
    assignMenuOpen,
    setAssignMenuOpen,
    activeCollectionMenu,
    setActiveCollectionMenu,
    pdfExportOpen,
    setPdfExportOpen,
    permissionsDocId,
    setPermissionsDocId,
    offlineStatuses,
    offlineProgress,
    isInTeamMode,
    isConnectedToHost,
    isHost,
    relaySessionUsable,
    connectedRelayAddress,
    isAvailableOffline,
    currentDocumentId,
    currentUser,
    error,
    isLoading,
    transferPhase,
    transferDirection,
    handleNewDocument,
    handleSave,
    handleRefresh,
    handleImport,
    handleExport,
    handleOpen,
    handleDelete,
    handlePermanentDelete,
    handleRename,
    handlePublishToTeam,
    handleMoveToPersonal,
    handleMakeAvailableOffline,
    handleBulkAssign,
    handleBulkAssignNewCollection,
    handleBulkDelete,
    handleBulkExport,
    handleCreateCollection,
    handleAssignToCollection,
    handleAssignNewCollectionFor,
    handleRenameCollection,
    handleDeleteCollection,
    handleRecolor,
  };
}

/* ── Permission helpers (pure; shared by the list renderer) ─────────────────── */

/** Check if user can delete a document */
export function canDelete(record: DocumentRecord, _userId?: string, userRole?: string): boolean {
  if (record.type === 'local') return true;
  if (record.type === 'remote' && record.permission === 'owner') return true;
  if (record.type === 'remote' && userRole === 'admin') return true;
  if (record.type === 'cached') return true;
  return false;
}

/** Check if user can edit a document */
export function canEdit(record: DocumentRecord, _userId?: string, userRole?: string): boolean {
  if (record.type === 'local') return true;
  if (record.type === 'remote' && (record.permission === 'owner' || record.permission === 'editor')) return true;
  if (record.type === 'remote' && userRole === 'admin') return true;
  if (record.type === 'cached') return true;
  return false;
}

/** Check if user can manage permissions on a document */
export function canManagePermissions(
  record: DocumentRecord,
  isInTeamMode: boolean,
  _userId?: string,
  userRole?: string
): boolean {
  if (!isInTeamMode) return false;
  if (record.type !== 'remote') return false;
  if (record.permission === 'owner') return true;
  if (userRole === 'admin') return true;
  return false;
}

/**
 * Check if user can publish a document to the team. Gated on a usable relay
 * session (valid cached token), NOT a live WS — transfers run over the REST
 * provider, which survives leaving a doc, so being on a local doc must not hide
 * the action (JP-211 transfer-gating bug).
 */
export function canPublishToTeam(record: DocumentRecord, relayUsable: boolean): boolean {
  if (!relayUsable) return false;
  return record.type === 'local';
}

/** Check if user can move a relay document back to personal. Gated on a usable
 *  relay session (valid cached token), not the live WS (see canPublishToTeam). */
export function canMoveToPersonal(
  record: DocumentRecord,
  relayUsable: boolean,
  userId?: string,
  userRole?: string
): boolean {
  if (record.type !== 'remote') return false;
  if (!relayUsable) return false;
  return record.permission === 'owner' || record.ownerId === userId || userRole === 'admin';
}
