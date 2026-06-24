/**
 * DocumentList — presentational document grid/list fed by `useDocumentBrowserModel`.
 *
 * Renders the card area (flat list, collection-grouped sections, or empty
 * state) plus the multi-select `SelectionBar`. No document logic of its own —
 * every action comes from the model. Shared by the legacy Settings-tab
 * `DocumentBrowser` chrome and the first-class `DocumentsHome` surface (JP-218).
 */

import { useRef, useEffect } from 'react';
import { ChevronDown, MoreHorizontal, X } from 'lucide-react';
import { DocumentCard } from '../DocumentCard';
import { COLLECTION_SWATCHES, type Collection } from '../../store/collectionStore';
import type { DocumentBrowserView } from '../../store/uiPreferencesStore';
import type { DocumentRecord } from '../../types/DocumentRegistry';
import {
  canDelete,
  canEdit,
  canManagePermissions,
  canPublishToTeam,
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
    setPermissionsDocId,
    isInTeamMode,
    relaySessionUsable,
    handlePublishToTeam,
    handleMoveToPersonal,
  } = model;

  const cardMode: 'compact' | 'full' | 'grid' =
    view === 'grid' ? 'grid' : compact ? 'compact' : 'full';

  const onOpen = async (id: string) => {
    await handleOpen(id);
    onOpened?.(id);
  };

  const renderCard = (record: DocumentRecord) => {
    const accent = accentByDoc.get(record.id);
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
          canManagePermissions(record, isInTeamMode, currentUser?.id, currentUser?.role)
            ? setPermissionsDocId
            : undefined
        }
        onPublishToTeam={canPublishToTeam(record, relaySessionUsable) ? handlePublishToTeam : undefined}
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
        mode={cardMode}
      />
    );
  };

  return (
    <div className={`document-browser__list ${view === 'grid' ? 'document-browser__list--grid' : ''}`}>
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
  );
}

/**
 * SelectionBar — bulk-action affordance shown when documents are multi-selected.
 * Extracted so both browser chromes reuse it.
 */
export function SelectionBar({ model }: { model: DocumentBrowserModel }) {
  const {
    selectedIds,
    collections,
    assignMenuOpen,
    setAssignMenuOpen,
    handleBulkAssign,
    handleBulkAssignNewCollection,
    handleBulkExport,
    handleBulkDelete,
    clearSelection,
  } = model;

  return (
    <div className="document-browser__selection-bar">
      <span className="document-browser__selection-count">{selectedIds.size} selected</span>
      <div className="document-browser__selection-actions">
        <div className="document-browser__assign-wrap">
          <button
            className="document-browser__bulk-btn"
            onClick={() => setAssignMenuOpen((v) => !v)}
          >
            Assign to collection ▾
          </button>
          {assignMenuOpen && (
            <div className="document-browser__assign-menu" role="menu">
              <button className="document-browser__assign-item" onClick={() => handleBulkAssign(null)}>
                Remove from collection
              </button>
              {collections.length > 0 && <div className="document-browser__assign-sep" />}
              {collections.map((c) => (
                <button
                  key={c.id}
                  className="document-browser__assign-item"
                  onClick={() => handleBulkAssign(c.id)}
                >
                  <span
                    className="document-browser__assign-swatch"
                    style={c.color ? { background: c.color } : undefined}
                  />
                  {c.name}
                </button>
              ))}
              <div className="document-browser__assign-sep" />
              <button
                className="document-browser__assign-item document-browser__assign-item--new"
                onClick={handleBulkAssignNewCollection}
              >
                + New collection…
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
  const menuRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isMenuOpen || !onCloseMenu) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onCloseMenu();
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [isMenuOpen, onCloseMenu]);

  const isUnassigned = collection === null;
  // Show the collection-actions menu + swatch only for real user-defined
  // collections, never for the unassigned section.
  const showMenu = collection !== null;
  const showSwatch = !isUnassigned;
  const title = collection !== null ? collection.name : 'Unassigned';
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
          <span className="document-browser__section-title">{title}</span>
          <span className="document-browser__section-count">{docs.length}</span>
        </button>
        {showMenu && collection && (
          <div className="document-browser__section-menu-wrap" ref={menuRef}>
            <button
              className="document-browser__section-menu-btn"
              onClick={onOpenMenu}
              title="Collection actions"
              aria-label="Collection actions"
              aria-haspopup="menu"
            >
              <MoreHorizontal size={16} aria-hidden="true" />
            </button>
            {isMenuOpen && (
              <div className="document-browser__section-menu" role="menu">
                <button className="document-browser__assign-item" onClick={() => onRename?.(collection)}>
                  Rename…
                </button>
                <div className="document-browser__assign-sep" />
                <div className="document-browser__swatch-row">
                  {COLLECTION_SWATCHES.map((color) => (
                    <button
                      key={color}
                      className="document-browser__swatch"
                      style={{ background: color }}
                      onClick={() => onRecolor?.(collection, color)}
                      title={color}
                    />
                  ))}
                  <button
                    className="document-browser__swatch document-browser__swatch--clear"
                    onClick={() => onRecolor?.(collection, undefined)}
                    title="Clear colour"
                    aria-label="Clear colour"
                  >
                    <X size={12} aria-hidden="true" />
                  </button>
                </div>
                <div className="document-browser__assign-sep" />
                <button
                  className="document-browser__assign-item document-browser__assign-item--danger"
                  onClick={() => onDelete?.(collection)}
                >
                  Delete collection
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
            <div className="document-browser__section-empty">No documents in this collection.</div>
          ) : (
            docs.map((d) => renderCard(d))
          )}
        </div>
      )}
    </div>
  );
}
