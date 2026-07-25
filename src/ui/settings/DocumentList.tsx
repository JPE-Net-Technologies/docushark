/**
 * DocumentList — presentational document grid/list fed by `useDocumentBrowserModel`.
 *
 * Renders the card area (flat list, collection-grouped sections, or empty
 * state) plus the multi-select `SelectionBar`. No document logic of its own —
 * every action comes from the model. Shared by the legacy Settings-tab
 * `DocumentBrowser` chrome and the first-class `DocumentsHome` surface (JP-218).
 */

import { useCallback, useState } from 'react';
import {
  ChevronDown,
  Cloud,
  Download,
  FilePlus2,
  FolderInput,
  FolderOpen,
  HardDrive,
  Tags,
  Trash2,
  UsersRound,
} from 'lucide-react';
import { DocumentCard } from '../DocumentCard';
import { TagEditorPopover } from '../TagEditorPopover';
import {
  DropdownMenu,
  menuAction,
  MENU_SEPARATOR,
  type DropdownMenuEntry,
} from '../components/DropdownMenu';
import { VersionHistoryPanel } from '../VersionHistoryPanel';
import { DocumentPermissionsDialog } from '../DocumentPermissionsDialog';
import { CollectionActionsMenu } from './CollectionActionsMenu';
import { isWorkspaceCollection, type Collection } from '../../store/collectionStore';
import type { DocumentBrowserView } from '../../store/uiPreferencesStore';
import type { DocumentRecord } from '../../types/DocumentRegistry';
import {
  canDelete,
  canEdit,
  canManagePermissions,
  canPublishToRelay,
  canMoveToPersonal,
  type DocumentBrowserModel,
} from './useDocumentBrowserModel';
// The `.document-browser__*` styles this list renders (cards, sections,
// selection bar) — owned here now that the legacy DocumentBrowser chrome is gone.
import './DocumentBrowser.css';

interface DocumentListProps {
  model: DocumentBrowserModel;
  /** Compact card layout for narrow sidebar usage. */
  compact?: boolean;
  /** Called after a document is opened (e.g. so a host surface can leave the browser). */
  onOpened?: (id: string) => void;
}

export function DocumentList({ model, compact = false, onOpened }: DocumentListProps) {
  const {
    documentList,
    groupedSections,
    view,
    searchQuery,
    filterMode,
    collapsedMap,
    toggleCollapsed,
    activeCollectionMenu,
    setActiveCollectionMenu,
    handleRenameCollection,
    handleDeleteCollection,
    handleRecolor,
    collections,
    assignments,
    handleAssignToCollection,
    handleAssignNewCollectionFor,
    accentByDoc,
    currentDocumentId,
    selectedIds,
    hasSelection,
    isAvailableOffline,
    offlineStatuses,
    offlineProgress,
    handleMakeAvailableOffline,
    handleOpen,
    handleSelectToggle,
    currentUser,
    handleDelete,
    handlePermanentDelete,
    handleRename,
    permissionsDocId,
    setPermissionsDocId,
    isInRelayMode,
    relaySessionUsable,
    handlePublishToRelay,
    handleMoveToPersonal,
    allTags,
    handleSetTags,
    setSearchQuery,
  } = model;

  // Chip click IS the tag filter: fill `#tag` into the search box (JP-388).
  const handleTagClick = useCallback(
    (tag: string) => setSearchQuery('#' + tag),
    [setSearchQuery],
  );

  const cardMode: 'compact' | 'full' | 'grid' =
    view === 'grid' ? 'grid' : compact ? 'compact' : 'full';

  // JP-185 version history — opened from a cloud doc's card; rendered here so
  // it works in both browser chromes (Settings + DocumentsHome).
  const [versionHistoryDocId, setVersionHistoryDocId] = useState<string | null>(null);
  const versionHistoryDoc = versionHistoryDocId
    ? documentList.find((r) => r.id === versionHistoryDocId)
    : undefined;

  const onOpen = async (id: string) => {
    await handleOpen(id);
    onOpened?.(id);
  };

  const renderCard = (record: DocumentRecord) => {
    const accent = accentByDoc.get(record.id);
    // Tag edits (JP-388): local docs always; workspace docs only with a usable
    // relay session; cached (offline-only) docs are read-only for tags —
    // offline tag-queueing is deliberately out of scope for this slice.
    const canTag =
      canEdit(record, currentUser?.id, currentUser?.role) &&
      (record.type === 'local' || (record.type === 'remote' && relaySessionUsable));
    return (
      <DocumentCard
        key={record.id}
        record={record}
        isActive={record.id === currentDocumentId}
        isSelected={selectedIds.has(record.id)}
        showSelectionCheckbox={hasSelection}
        isOfflineAvailable={record.type === 'remote' && isAvailableOffline(record.id)}
        onOpen={onOpen}
        onSelectToggle={handleSelectToggle}
        onDelete={canDelete(record, currentUser?.id, currentUser?.role) ? handleDelete : undefined}
        onPermanentDelete={
          canDelete(record, currentUser?.id, currentUser?.role) ? handlePermanentDelete : undefined
        }
        onRename={canEdit(record, currentUser?.id, currentUser?.role) ? handleRename : undefined}
        onEditPermissions={
          canManagePermissions(record, isInRelayMode, currentUser?.id, currentUser?.role)
            ? setPermissionsDocId
            : undefined
        }
        onViewBackups={
          record.type !== 'local' && relaySessionUsable ? setVersionHistoryDocId : undefined
        }
        onPublishToRelay={canPublishToRelay(record, relaySessionUsable) ? handlePublishToRelay : undefined}
        onMoveToPersonal={canMoveToPersonal(record, relaySessionUsable, currentUser?.id, currentUser?.role) ? handleMoveToPersonal : undefined}
        collectionAccent={accent}
        collections={collections}
        currentCollectionId={assignments[record.id] ?? null}
        onAssignCollection={handleAssignToCollection}
        onCreateCollectionFor={handleAssignNewCollectionFor}
        connectedRelayAddress={model.connectedRelayAddress}
        offlineStatus={offlineStatuses.get(record.id)}
        offlineProgress={offlineProgress.get(record.id) ?? null}
        onMakeAvailableOffline={record.type !== 'local' ? handleMakeAvailableOffline : undefined}
        onSetTags={canTag ? handleSetTags : undefined}
        onTagClick={handleTagClick}
        tagSuggestions={allTags}
        mode={cardMode}
      />
    );
  };

  return (
    <>
    <div className={`document-browser__list ${view === 'grid' ? 'document-browser__list--grid' : ''}`}>
      {documentList.length === 0 ? (
        <div className="document-browser__empty">
          {searchQuery ? (
            <>
              <p>No documents match “{searchQuery}”.</p>
              <button
                className="document-browser__empty-clear"
                onClick={() => setSearchQuery('')}
              >
                Clear search
              </button>
            </>
          ) : model.collectionFilter !== null ? (
            <>
              <span className="document-browser__empty-ico" aria-hidden="true">
                <FolderOpen size={22} />
              </span>
              <p>This collection is empty.</p>
              <span className="document-browser__empty-sub">
                Use a document&apos;s “Move to collection” action to file it here.
              </span>
            </>
          ) : filterMode === 'shared' ? (
            <>
              <span className="document-browser__empty-ico" aria-hidden="true">
                <UsersRound size={22} />
              </span>
              <p>Nothing shared with you yet.</p>
              <span className="document-browser__empty-sub">
                Documents teammates share with you appear here.
              </span>
            </>
          ) : filterMode !== 'all' ? (
            <p>No {filterMode === 'local' ? 'personal' : filterMode} documents.</p>
          ) : (
            <>
              <span className="document-browser__empty-ico" aria-hidden="true">
                <FilePlus2 size={22} />
              </span>
              <p>Create your first document.</p>
              <span className="document-browser__empty-sub">
                Start from scratch, or import an existing .docushark file.
              </span>
              <div className="document-browser__empty-actions">
                <button
                  className="document-browser__empty-cta"
                  onClick={() => {
                    model.handleNewDocument();
                    onOpened?.('new');
                  }}
                >
                  <FilePlus2 size={14} aria-hidden="true" /> New document
                </button>
                <button
                  className="document-browser__empty-clear"
                  onClick={model.handleImport}
                >
                  Import
                </button>
              </div>
            </>
          )}
        </div>
      ) : groupedSections ? (
        groupedSections.map(({ key, collection, docs }) => {
          if (docs.length === 0 && collection === null) return null;
          const collapsed = collapsedMap[key] === true;
          return (
            <CollectionSection
              key={key}
              collection={collection}
              docs={docs}
              collapsed={collapsed}
              onToggle={() => toggleCollapsed(key)}
              view={view}
              renderCard={renderCard}
              isMenuOpen={activeCollectionMenu === key}
              onOpenMenu={() => setActiveCollectionMenu(activeCollectionMenu === key ? null : key)}
              onCloseMenu={() => setActiveCollectionMenu(null)}
              onRename={handleRenameCollection}
              onDelete={handleDeleteCollection}
              onRecolor={handleRecolor}
            />
          );
        })
      ) : (
        documentList.map((record) => renderCard(record))
      )}
    </div>
      {versionHistoryDocId && (
        <VersionHistoryPanel
          docId={versionHistoryDocId}
          docName={versionHistoryDoc?.name ?? 'Document'}
          onClose={() => setVersionHistoryDocId(null)}
        />
      )}
      {permissionsDocId && (
        <DocumentPermissionsDialog
          documentId={permissionsDocId}
          onClose={() => setPermissionsDocId(null)}
        />
      )}
    </>
  );
}

/**
 * SelectionBar — bulk-action affordance shown when documents are multi-selected.
 * Sticky at the top of the scrolling content area so bulk actions stay in
 * reach while scrolling a long selection. Left group = selection state
 * (count / Select all / Clear); right group = actions, with the destructive
 * one separated. On compact viewports the action labels collapse to icons.
 */
export function SelectionBar({ model }: { model: DocumentBrowserModel }) {
  const {
    documentList,
    selectedIds,
    collections,
    allTags,
    handleBulkAssign,
    handleBulkAssignNewCollection,
    handleBulkAddTags,
    handleBulkExport,
    handleBulkDelete,
    handleSelectAll,
    clearSelection,
  } = model;

  const allSelected = selectedIds.size >= documentList.length;

  // Bulk tagging (JP-388): the popover's chip list is "tags added in this
  // session" — each newly-entered tag is APPENDED to every selected editable
  // doc immediately; removing a chip only stops future adds (it never
  // un-tags). Anchored to the Tags button.
  const [bulkTagAnchor, setBulkTagAnchor] = useState<{
    top: number;
    bottom: number;
    left: number;
    right: number;
  } | null>(null);
  const [bulkTags, setBulkTags] = useState<string[]>([]);
  const closeBulkTags = useCallback(() => {
    setBulkTagAnchor(null);
    setBulkTags([]);
  }, []);

  // Same ordering as the per-card "Move to collection" submenu.
  const assignEntries: DropdownMenuEntry[] = [
    ...collections.map((c) =>
      menuAction({
        id: `collection-${c.id}`,
        label: c.name,
        swatchColor: c.color ?? null,
        onSelect: () => handleBulkAssign(c.id),
      }),
    ),
    ...(collections.length > 0
      ? [
          menuAction({
            id: 'collection-remove',
            label: 'Remove from collection',
            onSelect: () => handleBulkAssign(null),
          }),
          MENU_SEPARATOR,
        ]
      : []),
    menuAction({
      id: 'collection-new',
      label: '+ New collection…',
      onSelect: () => void handleBulkAssignNewCollection(),
    }),
  ];

  return (
    <div className="document-browser__selection-bar">
      <div className="document-browser__selection-state">
        <span className="document-browser__selection-count">{selectedIds.size} selected</span>
        {!allSelected && (
          <button className="document-browser__selection-link" onClick={handleSelectAll}>
            Select all ({documentList.length})
          </button>
        )}
        <button className="document-browser__selection-link" onClick={clearSelection}>
          Clear
        </button>
      </div>
      <div className="document-browser__selection-actions">
        <DropdownMenu
          trigger={
            <>
              <FolderInput size={14} aria-hidden="true" />
              <span className="document-browser__bulk-label">Add to collection</span>
              <ChevronDown size={12} aria-hidden="true" />
            </>
          }
          triggerClassName="document-browser__bulk-btn"
          triggerTitle="Add to collection"
          entries={assignEntries}
          align="left"
        />
        <button
          className="document-browser__bulk-btn"
          title="Add tags"
          onClick={(e) => {
            const rect = e.currentTarget.getBoundingClientRect();
            setBulkTagAnchor({
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
            });
          }}
        >
          <Tags size={14} aria-hidden="true" />
          <span className="document-browser__bulk-label">Add tags</span>
        </button>
        {bulkTagAnchor && (
          <TagEditorPopover
            tags={bulkTags}
            suggestions={allTags}
            anchor={bulkTagAnchor}
            onCommit={(next) => {
              const added = next.filter((t) => !bulkTags.includes(t));
              setBulkTags(next);
              if (added.length > 0) void handleBulkAddTags(added);
            }}
            onClose={closeBulkTags}
          />
        )}
        <button className="document-browser__bulk-btn" onClick={handleBulkExport} title="Export">
          <Download size={14} aria-hidden="true" />
          <span className="document-browser__bulk-label">Export</span>
        </button>
        <span className="document-browser__selection-sep" aria-hidden="true" />
        <button
          className="document-browser__bulk-btn document-browser__bulk-btn--danger"
          onClick={handleBulkDelete}
          title="Delete"
        >
          <Trash2 size={14} aria-hidden="true" />
          <span className="document-browser__bulk-label">Delete</span>
        </button>
      </div>
    </div>
  );
}

interface CollectionSectionProps {
  collection: Collection | null;
  docs: DocumentRecord[];
  collapsed: boolean;
  view: DocumentBrowserView;
  onToggle: () => void;
  renderCard: (record: DocumentRecord) => React.ReactNode;
  // Collection menu props — only supplied for user-defined collection sections.
  isMenuOpen?: boolean | undefined;
  onOpenMenu?: (() => void) | undefined;
  onCloseMenu?: (() => void) | undefined;
  onRename?: ((collection: Collection) => void) | undefined;
  onDelete?: ((collection: Collection) => void) | undefined;
  onRecolor?: ((collection: Collection, color: string | undefined) => void) | undefined;
}

function CollectionSection({
  collection,
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
}: CollectionSectionProps) {
  const isUnassigned = collection === null;
  // Show the collection-actions menu + swatch only for real user-defined
  // collections, never for the unassigned section.
  const showMenu = collection !== null;
  const showSwatch = !isUnassigned;
  const title = collection !== null ? collection.name : 'Unassigned';
  const ScopeIcon = collection && isWorkspaceCollection(collection) ? Cloud : HardDrive;
  return (
    <div className="document-browser__section">
      <div className="document-browser__section-header">
        <button
          className="document-browser__section-toggle"
          onClick={onToggle}
          aria-expanded={!collapsed}
        >
          <ChevronDown
            className={`document-browser__caret ${collapsed ? 'document-browser__caret--collapsed' : ''}`}
            size={14}
            aria-hidden="true"
          />
          {showSwatch && (
            <span
              className="document-browser__section-swatch"
              style={collection?.color ? { background: collection.color } : undefined}
            />
          )}
          {collection && (
            <ScopeIcon
              size={13}
              className="document-browser__section-scope"
              aria-label={
                isWorkspaceCollection(collection) ? 'Workspace collection' : 'Local collection'
              }
            />
          )}
          <span className="document-browser__section-title">{title}</span>
          <span className="document-browser__section-count">{docs.length}</span>
        </button>
        {showMenu && collection && onRename && onDelete && onRecolor && (
          <CollectionActionsMenu
            collection={collection}
            isOpen={isMenuOpen === true}
            onOpen={() => onOpenMenu?.()}
            onClose={() => onCloseMenu?.()}
            onRename={onRename}
            onDelete={onDelete}
            onRecolor={onRecolor}
          />
        )}
      </div>
      {!collapsed && (
        <div
          className={`document-browser__section-body ${view === 'grid' ? 'document-browser__section-body--grid' : ''}`}
        >
          {docs.length === 0 ? (
            <div className="document-browser__section-empty">No documents in this collection.</div>
          ) : (
            docs.map((d) => renderCard(d))
          )}
        </div>
      )}
    </div>
  );
}
