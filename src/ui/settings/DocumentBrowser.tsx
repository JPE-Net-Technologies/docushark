/**
 * DocumentBrowser component
 *
 * Unified document browser that combines local and remote document management.
 *
 * Phase 14.1.6 UI Consolidation, Phase 20: document groups, grid view, multi-select.
 */

import { useState, useCallback, useMemo, useRef, useEffect, lazy, Suspense } from 'react';
import { useDocumentRegistry } from '../../store/documentRegistry';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useIsRelayAuthenticated } from '../../store/connectionStore';
import { useRelayDocumentStore } from '../../store/relayDocumentStore';
import { useUserStore } from '../../store/userStore';
import {
  useUIPreferencesStore,
  type DocumentBrowserSort,
  type DocumentBrowserGroupBy,
  type DocumentBrowserView,
} from '../../store/uiPreferencesStore';
import {
  useDocumentGroupStore,
  DOCUMENT_GROUP_SWATCHES,
  type DocumentGroup,
} from '../../store/documentGroupStore';
import { DocumentCard } from '../DocumentCard';
import { SyncStatusBadge } from '../SyncStatusBadge';
import { DocumentPermissionsDialog } from '../DocumentPermissionsDialog';

// Lazy: the PDF export dialog pulls jspdf + html2canvas + tiptap extensions —
// load that chunk only when the dialog is opened.
const PDFExportDialog = lazy(() =>
  import('../PDFExportDialog').then((m) => ({ default: m.PDFExportDialog })),
);
import { exportAndDownloadDocumentArchive, importDocumentArchive } from '../../storage/DocumentArchiveService';
import { getTransferService } from '../../services/DocumentTransferService';
import { useTransferStore, isTransferRunning, transferPhaseLabel } from '../../store/transferStore';
import { useCollaborationStore } from '../../collaboration';
import { getDocumentMetadata } from '../../types/Document';
import type { DocumentRecord } from '../../types/DocumentRegistry';
import './DocumentBrowser.css';

type FilterMode = 'all' | 'local' | 'team' | 'cached';
const UNGROUPED_KEY = '__ungrouped__';

interface DocumentBrowserProps {
  /** Compact mode for sidebar usage */
  compact?: boolean;
}

function compareRecords(a: DocumentRecord, b: DocumentRecord, sort: DocumentBrowserSort): number {
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
function friendlyTransferError(raw: string | undefined): string {
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

const SORT_LABELS: Record<DocumentBrowserSort, string> = {
  'modified-desc': 'Recently modified',
  'modified-asc': 'Least recently modified',
  'name-asc': 'Name (A–Z)',
  'name-desc': 'Name (Z–A)',
  'created-desc': 'Recently created',
};

export function DocumentBrowser({ compact = false }: DocumentBrowserProps) {
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
  const renameDocument = usePersistenceStore((s) => s.renameDocument);

  // Relay stores
  const isRelayLive = useIsRelayAuthenticated();
  const authenticated = useRelayDocumentStore((s) => s.authenticated);
  const isLoadingList = useRelayDocumentStore((s) => s.isLoadingList);
  const teamStoreError = useRelayDocumentStore((s) => s.error);
  const fetchDocumentList = useRelayDocumentStore((s) => s.fetchDocumentList);
  const loadRelayDocument = useRelayDocumentStore((s) => s.loadRelayDocument);
  const deleteFromHost = useRelayDocumentStore((s) => s.deleteFromHost);
  const isAvailableOffline = useRelayDocumentStore((s) => s.isAvailableOffline);

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

  // Group store
  const groupsMap = useDocumentGroupStore((s) => s.groups);
  const assignments = useDocumentGroupStore((s) => s.assignments);
  const createGroup = useDocumentGroupStore((s) => s.createGroup);
  const renameGroup = useDocumentGroupStore((s) => s.renameGroup);
  const recolorGroup = useDocumentGroupStore((s) => s.recolorGroup);
  const deleteGroupAction = useDocumentGroupStore((s) => s.deleteGroup);
  const assignMany = useDocumentGroupStore((s) => s.assignMany);

  const groups = useMemo<DocumentGroup[]>(
    () => Object.values(groupsMap).sort((a, b) => a.order - b.order),
    [groupsMap]
  );

  // Local state
  const [filterMode, setFilterMode] = useState<FilterMode>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [pdfExportOpen, setPdfExportOpen] = useState(false);
  const [permissionsDocId, setPermissionsDocId] = useState<string | null>(null);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastSelectedId, setLastSelectedId] = useState<string | null>(null);
  const [assignMenuOpen, setAssignMenuOpen] = useState(false);
  const [activeGroupMenu, setActiveGroupMenu] = useState<string | null>(null);

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

    if (searchQuery.trim()) {
      const query = searchQuery.toLowerCase();
      filtered = filtered.filter((d) => d.name.toLowerCase().includes(query));
    }

    return [...filtered].sort((a, b) => compareRecords(a, b, sort));
  }, [entries, getFilteredDocuments, filterMode, searchQuery, sort]);

  // Bucket documents by group when group-by is enabled.
  const groupedSections = useMemo(() => {
    if (groupBy !== 'group') return null;
    const buckets = new Map<string, DocumentRecord[]>();
    for (const doc of documentList) {
      const gid = assignments[doc.id];
      const key = gid && groupsMap[gid] ? gid : UNGROUPED_KEY;
      const arr = buckets.get(key);
      if (arr) arr.push(doc);
      else buckets.set(key, [doc]);
    }
    const sections: { key: string; group: DocumentGroup | null; docs: DocumentRecord[] }[] = [];
    for (const g of groups) {
      sections.push({ key: g.id, group: g, docs: buckets.get(g.id) ?? [] });
    }
    sections.push({
      key: UNGROUPED_KEY,
      group: null,
      docs: buckets.get(UNGROUPED_KEY) ?? [],
    });
    return sections;
  }, [groupBy, documentList, assignments, groupsMap, groups]);

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

  const handleRefresh = useCallback(() => {
    if (isConnectedToHost || isHost) fetchDocumentList();
  }, [fetchDocumentList, isConnectedToHost, isHost]);

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

  const handleDelete = useCallback(
    async (docId: string) => {
      const entry = entries[docId];
      if (!entry) return;
      const record = entry.record;
      if (record.type === 'remote') {
        try {
          await deleteFromHost(docId);
        } catch (error) {
          console.error('Failed to delete relay document:', error);
        }
      } else {
        deleteDocument(docId);
      }
    },
    [entries, deleteFromHost, deleteDocument]
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
      await fetchDocumentList();

      // If the promoted doc is the one open in the editor and we have an
      // authenticated relay session, join it on the relay so edits sync
      // immediately (convert-in-place keeps the same id). This is what turns
      // the post-sign-in "JOIN_DOC for unknown doc" rejection into a real
      // synced session.
      if (docId === currentDocumentId && isConnectedToHost) {
        useCollaborationStore.getState().switchDocument(docId);
      }
      useTransferStore.getState().reset();
    },
    [currentDocumentId, saveDocument, fetchDocumentList, currentUser, isConnectedToHost]
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

  const handleFilterChange = useCallback(
    (mode: FilterMode) => {
      setFilterMode(mode);
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
  }, [filterMode, sort, groupBy, clearSelection]);

  const handleBulkAssign = useCallback(
    (groupId: string | null) => {
      assignMany(Array.from(selectedIds), groupId);
      setAssignMenuOpen(false);
    },
    [assignMany, selectedIds]
  );

  const handleBulkAssignNewGroup = useCallback(() => {
    const name = window.prompt('New group name');
    if (!name || !name.trim()) return;
    const id = createGroup(name);
    if (id) assignMany(Array.from(selectedIds), id);
    setAssignMenuOpen(false);
  }, [assignMany, createGroup, selectedIds]);

  const handleBulkDelete = useCallback(async () => {
    const ids = Array.from(selectedIds);
    const deletable = ids.filter((id) => {
      const entry = entries[id];
      if (!entry) return false;
      return canDelete(entry.record, currentUser?.id, currentUser?.role);
    });
    if (deletable.length === 0) return;
    if (!window.confirm(`Delete ${deletable.length} document(s)? This cannot be undone.`)) return;
    for (const id of deletable) {
      await handleDelete(id);
    }
    clearSelection();
  }, [selectedIds, entries, currentUser, handleDelete, clearSelection]);

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

  // Group management
  const handleCreateGroup = useCallback(() => {
    const name = window.prompt('New group name');
    if (!name || !name.trim()) return;
    createGroup(name);
  }, [createGroup]);

  const handleRenameGroup = useCallback(
    (group: DocumentGroup) => {
      const name = window.prompt('Rename group', group.name);
      if (!name) return;
      renameGroup(group.id, name);
      setActiveGroupMenu(null);
    },
    [renameGroup]
  );

  const handleDeleteGroup = useCallback(
    (group: DocumentGroup) => {
      if (!window.confirm(`Delete group "${group.name}"? Documents in it will become Ungrouped.`)) return;
      deleteGroupAction(group.id);
      setActiveGroupMenu(null);
    },
    [deleteGroupAction]
  );

  const handleRecolor = useCallback(
    (group: DocumentGroup, color: string | undefined) => {
      recolorGroup(group.id, color);
    },
    [recolorGroup]
  );

  const error = registryError || teamStoreError;
  const isLoading = isFetchingRemote || isLoadingList;
  const hasSelection = selectedIds.size > 0;
  const showSelectionAffordance = hasSelection;

  const cardMode: 'compact' | 'full' | 'grid' =
    view === 'grid' ? 'grid' : compact ? 'compact' : 'full';

  const renderCard = useCallback(
    (record: DocumentRecord) => {
      const gid = assignments[record.id];
      const group = gid ? groupsMap[gid] : undefined;
      const accent =
        group && groupBy !== 'group'
          ? group.color !== undefined
            ? { name: group.name, color: group.color }
            : { name: group.name }
          : undefined;
      return (
        <DocumentCard
          key={record.id}
          record={record}
          isActive={record.id === currentDocumentId}
          isSelected={selectedIds.has(record.id)}
          showSelectionCheckbox={showSelectionAffordance}
          isOfflineAvailable={record.type === 'remote' && isAvailableOffline(record.id)}
          onOpen={handleOpen}
          onSelectToggle={handleSelectToggle}
          onDelete={canDelete(record, currentUser?.id, currentUser?.role) ? handleDelete : undefined}
          onRename={canEdit(record, currentUser?.id, currentUser?.role) ? handleRename : undefined}
          onEditPermissions={
            canManagePermissions(record, isInTeamMode, currentUser?.id, currentUser?.role)
              ? setPermissionsDocId
              : undefined
          }
          onPublishToTeam={canPublishToTeam(record, isInTeamMode, authenticated) ? handlePublishToTeam : undefined}
          onMoveToPersonal={canMoveToPersonal(record, authenticated, currentUser?.id, currentUser?.role) ? handleMoveToPersonal : undefined}
          groupAccent={accent}
          mode={cardMode}
        />
      );
    },
    [
      assignments,
      groupsMap,
      groupBy,
      currentDocumentId,
      selectedIds,
      showSelectionAffordance,
      isAvailableOffline,
      handleOpen,
      handleSelectToggle,
      currentUser,
      handleDelete,
      handleRename,
      isInTeamMode,
      authenticated,
      handlePublishToTeam,
      handleMoveToPersonal,
      cardMode,
    ]
  );

  return (
    <div className={`document-browser ${compact ? 'document-browser--compact' : ''}`}>
      {/* Quick Actions */}
      <div className="document-browser__actions">
        <button
          className="document-browser__action document-browser__action--primary"
          onClick={handleNewDocument}
          title="Create new document"
        >
          <span className="document-browser__action-icon">+</span>
          New
        </button>
        <button className="document-browser__action" onClick={handleSave} title="Save current document">
          Save
        </button>
        <button className="document-browser__action" onClick={handleImport} title="Import .docushark file">
          Import
        </button>
        <button className="document-browser__action" onClick={handleExport} title="Export as .docushark">
          Export
        </button>
        <button className="document-browser__action" onClick={() => setPdfExportOpen(true)} title="Export as PDF">
          PDF
        </button>
      </div>

      {/* Transfer progress (Local ↔ Cloud) */}
      {isTransferRunning(transferPhase) && (
        <div className="document-browser__transfer" role="status">
          <SyncStatusBadge state="syncing" showLabel={false} size="small" />
          <span className="document-browser__transfer-text">
            {transferPhaseLabel(transferDirection, transferPhase)}
          </span>
        </div>
      )}

      {/* Connection Status */}
      {isInTeamMode && (
        <div className="document-browser__status">
          {isConnectedToHost ? (
            <>
              <SyncStatusBadge state="synced" showLabel size="medium" />
              <span className="document-browser__status-text">Connected to host</span>
            </>
          ) : isHost ? (
            <>
              <SyncStatusBadge state="synced" showLabel size="medium" />
              <span className="document-browser__status-text">Hosting</span>
            </>
          ) : (
            <>
              <SyncStatusBadge state="offline" showLabel size="medium" />
              <span className="document-browser__status-text">Disconnected</span>
            </>
          )}
          <button
            className="document-browser__refresh"
            onClick={handleRefresh}
            disabled={isLoading}
            title="Refresh document list"
          >
            {isLoading ? '↻' : '⟳'}
          </button>
        </div>
      )}

      {/* Error display */}
      {error && (
        <div className="document-browser__error">
          <span className="document-browser__error-icon">!</span>
          {error}
        </div>
      )}

      {/* Search & Filter */}
      <div className="document-browser__toolbar">
        <input
          type="text"
          className="document-browser__search"
          placeholder="Search documents..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />

        <div className="document-browser__controls">
          <div className="document-browser__filter">
            <button
              className={`document-browser__filter-btn ${filterMode === 'all' ? 'document-browser__filter-btn--active' : ''}`}
              onClick={() => handleFilterChange('all')}
            >
              All ({documentCounts.total})
            </button>
            <button
              className={`document-browser__filter-btn ${filterMode === 'local' ? 'document-browser__filter-btn--active' : ''}`}
              onClick={() => handleFilterChange('local')}
            >
              Personal ({documentCounts.local})
            </button>
            {isInTeamMode && (
              <>
                <button
                  className={`document-browser__filter-btn ${filterMode === 'team' ? 'document-browser__filter-btn--active' : ''}`}
                  onClick={() => handleFilterChange('team')}
                >
                  Team ({documentCounts.team})
                </button>
                {documentCounts.cached > 0 && (
                  <button
                    className={`document-browser__filter-btn ${filterMode === 'cached' ? 'document-browser__filter-btn--active' : ''}`}
                    onClick={() => handleFilterChange('cached')}
                  >
                    Offline ({documentCounts.cached})
                  </button>
                )}
              </>
            )}
          </div>

          <div className="document-browser__view-controls">
            <SelectControl
              label="Sort"
              value={sort}
              onChange={(v) => setSort(v as DocumentBrowserSort)}
              options={Object.entries(SORT_LABELS).map(([value, label]) => ({ value, label }))}
            />
            <SelectControl
              label="Group"
              value={groupBy}
              onChange={(v) => setGroupBy(v as DocumentBrowserGroupBy)}
              options={[
                { value: 'none', label: 'No grouping' },
                { value: 'group', label: 'By group' },
              ]}
            />
            <div className="document-browser__view-toggle" role="group" aria-label="View mode">
              <button
                className={`document-browser__view-btn ${view === 'list' ? 'document-browser__view-btn--active' : ''}`}
                onClick={() => setView('list' as DocumentBrowserView)}
                title="List view"
                aria-pressed={view === 'list'}
              >
                ☰
              </button>
              <button
                className={`document-browser__view-btn ${view === 'grid' ? 'document-browser__view-btn--active' : ''}`}
                onClick={() => setView('grid' as DocumentBrowserView)}
                title="Grid view"
                aria-pressed={view === 'grid'}
              >
                ⊞
              </button>
            </div>
            <button
              className="document-browser__new-group-btn"
              onClick={handleCreateGroup}
              title="Create document group"
            >
              + Group
            </button>
          </div>
        </div>
      </div>

      {/* Selection bar */}
      {hasSelection && (
        <div className="document-browser__selection-bar">
          <span className="document-browser__selection-count">
            {selectedIds.size} selected
          </span>
          <div className="document-browser__selection-actions">
            <div className="document-browser__assign-wrap">
              <button
                className="document-browser__bulk-btn"
                onClick={() => setAssignMenuOpen((v) => !v)}
              >
                Assign to group ▾
              </button>
              {assignMenuOpen && (
                <div className="document-browser__assign-menu" role="menu">
                  <button
                    className="document-browser__assign-item"
                    onClick={() => handleBulkAssign(null)}
                  >
                    Remove from group
                  </button>
                  {groups.length > 0 && <div className="document-browser__assign-sep" />}
                  {groups.map((g) => (
                    <button
                      key={g.id}
                      className="document-browser__assign-item"
                      onClick={() => handleBulkAssign(g.id)}
                    >
                      <span
                        className="document-browser__assign-swatch"
                        style={g.color ? { background: g.color } : undefined}
                      />
                      {g.name}
                    </button>
                  ))}
                  <div className="document-browser__assign-sep" />
                  <button
                    className="document-browser__assign-item document-browser__assign-item--new"
                    onClick={handleBulkAssignNewGroup}
                  >
                    + New group…
                  </button>
                </div>
              )}
            </div>
            <button className="document-browser__bulk-btn" onClick={handleBulkExport}>
              Export
            </button>
            <button
              className="document-browser__bulk-btn document-browser__bulk-btn--danger"
              onClick={handleBulkDelete}
            >
              Delete
            </button>
            <button className="document-browser__bulk-btn" onClick={clearSelection}>
              Clear
            </button>
          </div>
        </div>
      )}

      {/* Document List */}
      <div
        className={`document-browser__list ${view === 'grid' ? 'document-browser__list--grid' : ''}`}
      >
        {documentList.length === 0 ? (
          <div className="document-browser__empty">
            {searchQuery ? (
              <p>No documents match your search.</p>
            ) : filterMode !== 'all' ? (
              <p>No {filterMode === 'local' ? 'personal' : filterMode} documents.</p>
            ) : (
              <p>No documents yet. Create a new one to get started!</p>
            )}
          </div>
        ) : groupedSections ? (
          groupedSections.map(({ key, group, docs }) => {
            if (docs.length === 0 && group === null) return null;
            const collapsed = collapsedMap[key] === true;
            return (
              <GroupSection
                key={key}
                group={group}
                docs={docs}
                collapsed={collapsed}
                onToggle={() => toggleCollapsed(key)}
                view={view}
                renderCard={renderCard}
                isMenuOpen={activeGroupMenu === key}
                onOpenMenu={() => setActiveGroupMenu(activeGroupMenu === key ? null : key)}
                onCloseMenu={() => setActiveGroupMenu(null)}
                onRename={handleRenameGroup}
                onDelete={handleDeleteGroup}
                onRecolor={handleRecolor}
              />
            );
          })
        ) : (
          documentList.map((record) => renderCard(record))
        )}
      </div>

      {/* PDF Export Dialog — lazy; only mounted (and its chunk fetched) when open */}
      {pdfExportOpen && (
        <Suspense fallback={null}>
          <PDFExportDialog isOpen={pdfExportOpen} onClose={() => setPdfExportOpen(false)} />
        </Suspense>
      )}

      {/* Permissions Dialog */}
      {permissionsDocId && (
        <DocumentPermissionsDialog
          documentId={permissionsDocId}
          onClose={() => setPermissionsDocId(null)}
        />
      )}
    </div>
  );
}

interface SelectControlProps {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}

function SelectControl({ label, value, options, onChange }: SelectControlProps) {
  return (
    <label className="document-browser__select">
      <span className="document-browser__select-label">{label}</span>
      <select
        className="document-browser__select-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </label>
  );
}

interface GroupSectionProps {
  group: DocumentGroup | null;
  docs: DocumentRecord[];
  collapsed: boolean;
  view: DocumentBrowserView;
  onToggle: () => void;
  renderCard: (record: DocumentRecord) => React.ReactNode;
  isMenuOpen: boolean;
  onOpenMenu: () => void;
  onCloseMenu: () => void;
  onRename: (group: DocumentGroup) => void;
  onDelete: (group: DocumentGroup) => void;
  onRecolor: (group: DocumentGroup, color: string | undefined) => void;
}

function GroupSection({
  group,
  docs,
  collapsed,
  view,
  onToggle,
  renderCard,
  isMenuOpen,
  onOpenMenu,
  onCloseMenu,
  onRename,
  onDelete,
  onRecolor,
}: GroupSectionProps) {
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onCloseMenu();
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [isMenuOpen, onCloseMenu]);

  const isUngrouped = group === null;
  return (
    <div className="document-browser__section">
      <div className="document-browser__section-header">
        <button
          className="document-browser__section-toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
        >
          <span className={`document-browser__caret ${collapsed ? 'document-browser__caret--collapsed' : ''}`}>
            ▾
          </span>
          {!isUngrouped && (
            <span
              className="document-browser__section-swatch"
              style={group?.color ? { background: group.color } : undefined}
            />
          )}
          <span className="document-browser__section-title">
            {isUngrouped ? 'Ungrouped' : group.name}
          </span>
          <span className="document-browser__section-count">{docs.length}</span>
        </button>
        {!isUngrouped && (
          <div className="document-browser__section-menu-wrap" ref={menuRef}>
            <button
              className="document-browser__section-menu-btn"
              onClick={onOpenMenu}
              title="Group actions"
              aria-haspopup="menu"
            >
              ⋯
            </button>
            {isMenuOpen && (
              <div className="document-browser__section-menu" role="menu">
                <button
                  className="document-browser__assign-item"
                  onClick={() => onRename(group)}
                >
                  Rename…
                </button>
                <div className="document-browser__assign-sep" />
                <div className="document-browser__swatch-row">
                  {DOCUMENT_GROUP_SWATCHES.map((color) => (
                    <button
                      key={color}
                      className="document-browser__swatch"
                      style={{ background: color }}
                      onClick={() => onRecolor(group, color)}
                      title={color}
                    />
                  ))}
                  <button
                    className="document-browser__swatch document-browser__swatch--clear"
                    onClick={() => onRecolor(group, undefined)}
                    title="Clear colour"
                  >
                    ×
                  </button>
                </div>
                <div className="document-browser__assign-sep" />
                <button
                  className="document-browser__assign-item document-browser__assign-item--danger"
                  onClick={() => onDelete(group)}
                >
                  Delete group
                </button>
              </div>
            )}
          </div>
        )}
      </div>
      {!collapsed && (
        <div
          className={`document-browser__section-body ${view === 'grid' ? 'document-browser__section-body--grid' : ''}`}
        >
          {docs.length === 0 ? (
            <div className="document-browser__section-empty">No documents in this group.</div>
          ) : (
            docs.map((d) => renderCard(d))
          )}
        </div>
      )}
    </div>
  );
}

/** Check if user can delete a document */
function canDelete(record: DocumentRecord, _userId?: string, userRole?: string): boolean {
  if (record.type === 'local') return true;
  if (record.type === 'remote' && record.permission === 'owner') return true;
  if (record.type === 'remote' && userRole === 'admin') return true;
  if (record.type === 'cached') return true;
  return false;
}

/** Check if user can edit a document */
function canEdit(record: DocumentRecord, _userId?: string, userRole?: string): boolean {
  if (record.type === 'local') return true;
  if (record.type === 'remote' && (record.permission === 'owner' || record.permission === 'editor')) return true;
  if (record.type === 'remote' && userRole === 'admin') return true;
  if (record.type === 'cached') return true;
  return false;
}

/** Check if user can manage permissions on a document */
function canManagePermissions(
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

/** Check if user can publish a document to the team */
function canPublishToTeam(
  record: DocumentRecord,
  isInTeamMode: boolean,
  isAuthenticated: boolean
): boolean {
  if (!isInTeamMode || !isAuthenticated) return false;
  return record.type === 'local';
}

/** Check if user can move a relay document back to personal */
function canMoveToPersonal(
  record: DocumentRecord,
  isAuthenticated: boolean,
  userId?: string,
  userRole?: string
): boolean {
  if (record.type !== 'remote') return false;
  if (!isAuthenticated) return false;
  return record.permission === 'owner' || record.ownerId === userId || userRole === 'admin';
}

export default DocumentBrowser;
