/**
 * Relay Documents Manager
 *
 * Manages relay documents with:
 * - Document list with name, owner, last modified, shared users
 * - Create new relay document
 * - Per-document actions: Rename, Share, Transfer Ownership, Delete
 * - Filter/search documents
 */

import { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useUserStore } from '../../store/userStore';
import { useIsRelayAuthenticated } from '../../store/connectionStore';
import { useRelayDocumentStore } from '../../store/relayDocumentStore';
import { useConnectionStore } from '../../store/connectionStore';
import { DocumentMetadata, DocumentShare } from '../../types/Document';
import './RelayDocumentsManager.css';

/**
 * Format a timestamp as a relative time string.
 */
function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp;

  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'Just now';
}

/**
 * Document action dropdown component.
 */
interface DocumentActionsProps {
  isOwner: boolean;
  isAdmin: boolean;
  isRelayDocument: boolean;
  onRename: () => void;
  onShare: () => void;
  onTransfer: () => void;
  onDelete: () => void;
}

function DocumentActions({
  isOwner,
  isAdmin,
  isRelayDocument,
  onRename,
  onShare,
  onTransfer,
  onDelete,
}: DocumentActionsProps) {
  const [isOpen, setIsOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [menuPosition, setMenuPosition] = useState({ top: 0, right: 0 });

  const canModify = isOwner || isAdmin;
  const canShare = isOwner || isAdmin;
  const canDelete = isOwner || isAdmin;

  // Calculate menu position when opening
  useEffect(() => {
    if (isOpen && buttonRef.current) {
      const rect = buttonRef.current.getBoundingClientRect();
      // Position below the button, aligned to the right
      setMenuPosition({
        top: rect.bottom + 4,
        right: window.innerWidth - rect.right,
      });
    }
  }, [isOpen]);

  // Close menu on scroll or resize
  useEffect(() => {
    if (!isOpen) return;

    const handleClose = () => setIsOpen(false);
    window.addEventListener('scroll', handleClose, true);
    window.addEventListener('resize', handleClose);

    return () => {
      window.removeEventListener('scroll', handleClose, true);
      window.removeEventListener('resize', handleClose);
    };
  }, [isOpen]);

  const menuContent = isOpen
    ? createPortal(
        <>
          <div
            className="doc-actions-backdrop"
            onClick={() => setIsOpen(false)}
          />
          <div
            className="doc-actions-menu doc-actions-menu-portal"
            style={{
              position: 'fixed',
              top: menuPosition.top,
              right: menuPosition.right,
            }}
          >
            {canModify && (
              <button
                className="doc-action-item"
                onClick={() => {
                  setIsOpen(false);
                  onRename();
                }}
              >
                Rename
              </button>
            )}
            {canShare && (
              <button
                className="doc-action-item"
                onClick={() => {
                  setIsOpen(false);
                  onShare();
                }}
              >
                Share
              </button>
            )}
            {canModify && (
              <button
                className="doc-action-item"
                onClick={() => {
                  setIsOpen(false);
                  onTransfer();
                }}
              >
                {isRelayDocument ? 'Move to Personal' : 'Move to Team'}
              </button>
            )}
            {canDelete && (
              <button
                className="doc-action-item danger"
                onClick={() => {
                  setIsOpen(false);
                  onDelete();
                }}
              >
                Delete
              </button>
            )}
          </div>
        </>,
        document.body
      )
    : null;

  return (
    <div className="doc-actions">
      <button
        ref={buttonRef}
        className="doc-actions-button"
        onClick={(e) => {
          e.stopPropagation();
          setIsOpen(!isOpen);
        }}
        title="Actions"
      >
        ...
      </button>
      {menuContent}
    </div>
  );
}

/**
 * Share badge showing number of shared users.
 */
function ShareBadge({ sharedWith }: { sharedWith: DocumentShare[] }) {
  if (sharedWith.length === 0) return null;

  const names = sharedWith.map((s) => s.userName).join(', ');

  return (
    <span className="share-badge" title={`Shared with: ${names}`}>
      {sharedWith.length}
    </span>
  );
}

export function RelayDocumentsManager() {
  const documents = usePersistenceStore((state) => state.documents);
  const currentDocumentId = usePersistenceStore((state) => state.currentDocumentId);
  const loadDocument = usePersistenceStore((state) => state.loadDocument);
  const deleteDocument = usePersistenceStore((state) => state.deleteDocument);
  const renameDocument = usePersistenceStore((state) => state.renameDocument);
  const saveDocumentAs = usePersistenceStore((state) => state.saveDocumentAs);
  const transferToTeam = usePersistenceStore((state) => state.transferToTeam);
  const transferToPersonal = usePersistenceStore((state) => state.transferToPersonal);

  const currentUser = useUserStore((state) => state.currentUser);
  const isRelayLive = useIsRelayAuthenticated();

  // Team documents from host (for clients)
  const relayDocuments = useRelayDocumentStore((state) => state.relayDocuments);
  const isAuthenticated = useRelayDocumentStore((state) => state.authenticated);
  const loadRelayDocument = useRelayDocumentStore((state) => state.loadRelayDocument);
  const isLoadingList = useRelayDocumentStore((state) => state.isLoadingList);

  // Connection status for showing cached state
  const hostAddress = useConnectionStore((state) => state.host?.address);
  const wasConnectedAsClient = hostAddress !== null;

  const [searchQuery, setSearchQuery] = useState('');
  const [showOnlyTeam, setShowOnlyTeam] = useState(false);

  // Note: fetchDocumentList is called automatically by teamDocumentStore.setAuthenticated
  // when the client authenticates. No need to trigger it here.

  const isClient = isRelayLive;
  // Show cached documents when we were a client but are now disconnected
  const showCachedDocs = !isClient && wasConnectedAsClient && !isAuthenticated;

  // Modal states
  const [renameModal, setRenameModal] = useState<{ doc: DocumentMetadata; name: string } | null>(null);
  const [shareModal, setShareModal] = useState<DocumentMetadata | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<DocumentMetadata | null>(null);
  const [transferModal, setTransferModal] = useState<DocumentMetadata | null>(null);
  const [createModal, setCreateModal] = useState(false);
  const [newDocName, setNewDocName] = useState('');

  // Filter and sort documents - merge local and relay documents for clients
  const filteredDocuments = useMemo(() => {
    let docs: (DocumentMetadata & { _fromHost?: true; _cached?: true })[] = [];

    if (isClient && isAuthenticated) {
      // For clients: personal docs (local) + team docs (from host, source of truth)
      const localDocs = Object.values(documents);

      // Personal docs from local storage only
      const personalDocs = localDocs.filter((d) => !d.isRelayDocument);

      // Team docs from host (source of truth for relay documents)
      // These take priority over any local cached copies
      const hostDocs = Object.values(relayDocuments).map((d) => ({
        ...d,
        isRelayDocument: true as const,
        _fromHost: true as const,
      }));

      // Use a seen set to avoid any duplicate IDs
      const seenIds = new Set<string>();
      const dedupedDocs: (DocumentMetadata & { _fromHost?: true })[] = [];

      // Add host docs first (they are the source of truth for team docs)
      for (const doc of hostDocs) {
        if (!seenIds.has(doc.id)) {
          seenIds.add(doc.id);
          dedupedDocs.push(doc);
        }
      }

      // Add personal docs (non-team)
      for (const doc of personalDocs) {
        if (!seenIds.has(doc.id)) {
          seenIds.add(doc.id);
          dedupedDocs.push(doc);
        }
      }

      // Add any local team docs not yet on host (edge case during transfer)
      const localTeamDocs = localDocs.filter((d) => d.isRelayDocument);
      for (const doc of localTeamDocs) {
        if (!seenIds.has(doc.id)) {
          seenIds.add(doc.id);
          dedupedDocs.push(doc);
        }
      }

      docs = dedupedDocs;
    } else if (showCachedDocs) {
      // Disconnected client - show local docs with team docs marked as cached
      const localDocs = Object.values(documents);
      docs = localDocs.map((d) => 
        d.isRelayDocument 
          ? { ...d, _cached: true as const }
          : d
      );
    } else {
      // Not connected as client - use local documents
      docs = Object.values(documents);
    }

    // Filter by relay documents only if toggle is on
    if (showOnlyTeam) {
      docs = docs.filter((doc) => doc.isRelayDocument);
    }

    // Filter by search query
    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      docs = docs.filter(
        (doc) =>
          doc.name.toLowerCase().includes(query) ||
          doc.ownerName?.toLowerCase().includes(query)
      );
    }

    // Sort by modified date (newest first)
    return docs.sort((a, b) => b.modifiedAt - a.modifiedAt);
  }, [documents, relayDocuments, searchQuery, showOnlyTeam, isClient, isAuthenticated, showCachedDocs]);

  const isAdmin = currentUser?.role === 'admin';
  const userId = currentUser?.id;

  const loadRemoteDocument = usePersistenceStore((state) => state.loadRemoteDocument);

  const handleOpenDocument = useCallback(
    async (docId: string, fromHost?: boolean) => {
      if (fromHost && isClient) {
        // Load document from host first, then open it
        try {
          const doc = await loadRelayDocument(docId);
          // Load the document into the editor
          loadRemoteDocument(doc);
          console.log('[RelayDocumentsManager] Opened remote document:', doc.name);
        } catch (error) {
          console.error('[RelayDocumentsManager] Failed to load relay document:', error);
        }
      } else {
        loadDocument(docId);
      }
    },
    [loadDocument, loadRelayDocument, loadRemoteDocument, isClient]
  );

  const handleCreateDocument = useCallback(() => {
    if (!newDocName.trim()) return;

    // Save current document state as a new relay document
    saveDocumentAs(newDocName.trim());

    // TODO: Mark as relay document when saving
    // This would require extending saveDocumentAs or adding a new method

    setCreateModal(false);
    setNewDocName('');
  }, [newDocName, saveDocumentAs]);

  const handleRename = useCallback(
    (doc: DocumentMetadata) => {
      setRenameModal({ doc, name: doc.name });
    },
    []
  );

  const handleRenameConfirm = useCallback(() => {
    if (!renameModal || !renameModal.name.trim()) return;

    // If it's the current document, use renameDocument
    if (renameModal.doc.id === currentDocumentId) {
      renameDocument(renameModal.name.trim());
    }
    // TODO: For other documents, we'd need to load, rename, save

    setRenameModal(null);
  }, [renameModal, currentDocumentId, renameDocument]);

  const handleShare = useCallback((doc: DocumentMetadata) => {
    setShareModal(doc);
  }, []);

  const handleDelete = useCallback((doc: DocumentMetadata) => {
    setDeleteConfirm(doc);
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    if (!deleteConfirm) return;
    deleteDocument(deleteConfirm.id);
    setDeleteConfirm(null);
  }, [deleteConfirm, deleteDocument]);

  const handleTransfer = useCallback((doc: DocumentMetadata) => {
    setTransferModal(doc);
  }, []);

  const handleTransferConfirm = useCallback(() => {
    if (!transferModal) return;

    if (transferModal.isRelayDocument) {
      transferToPersonal(transferModal.id);
    } else {
      transferToTeam(transferModal.id);
    }

    setTransferModal(null);
  }, [transferModal, transferToTeam, transferToPersonal]);

  const isInTeamMode = isRelayLive;

  return (
    <div className="team-documents-manager">
      <div className="team-docs-header">
        <h4 className="settings-group-title">Documents</h4>
        <button
          className="create-doc-button"
          onClick={() => setCreateModal(true)}
        >
          + New
        </button>
      </div>

      {/* Search and filters */}
      <div className="team-docs-filters">
        <input
          type="text"
          className="team-docs-search"
          placeholder="Search documents..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
        {isInTeamMode && (
          <label className="team-docs-filter-toggle">
            <input
              type="checkbox"
              checked={showOnlyTeam}
              onChange={(e) => setShowOnlyTeam(e.target.checked)}
            />
            <span>Team only</span>
          </label>
        )}
      </div>

      {/* Document list */}
      <div className="team-docs-list">
        {isLoadingList && (
          <div className="team-docs-loading">Loading documents from host...</div>
        )}
        {!isLoadingList && filteredDocuments.length === 0 ? (
          <div className="team-docs-empty">
            {searchQuery ? 'No documents match your search' : 'No documents yet'}
          </div>
        ) : (
          filteredDocuments.map((doc) => {
            const isOwner = doc.ownerId === userId || !doc.ownerId;
            const isCurrent = doc.id === currentDocumentId;
            const fromHost = '_fromHost' in doc && doc._fromHost === true;
            const isCached = '_cached' in doc && doc._cached === true;
            // Use unique key based on source to avoid React key collisions during sync
            const key = fromHost ? `host-${doc.id}` : `local-${doc.id}`;

            return (
              <div
                key={key}
                className={`team-doc-item ${isCurrent ? 'current' : ''} ${fromHost ? 'from-host' : ''} ${isCached ? 'cached' : ''}`}
                onClick={() => handleOpenDocument(doc.id, fromHost)}
              >
                <div className="team-doc-info">
                  <div className="team-doc-name">
                    {doc.name}
                    {fromHost && (
                      <span className="host-badge" title="Document from host server">
                        Host
                      </span>
                    )}
                    {isCached && (
                      <span className="cached-badge" title="Cached relay document (offline)">
                        Cached
                      </span>
                    )}
                    {doc.isRelayDocument && !fromHost && !isCached && (
                      <span className="team-badge" title="Team document">
                        T
                      </span>
                    )}
                    {doc.sharedWith && <ShareBadge sharedWith={doc.sharedWith} />}
                  </div>
                  <div className="team-doc-meta">
                    <span className="team-doc-owner">
                      {doc.ownerName || 'You'}
                    </span>
                    <span className="team-doc-separator">-</span>
                    <span className="team-doc-modified">
                      {formatRelativeTime(doc.modifiedAt)}
                    </span>
                    <span className="team-doc-pages">
                      {doc.pageCount} {doc.pageCount === 1 ? 'page' : 'pages'}
                    </span>
                  </div>
                </div>

                <DocumentActions
                  isOwner={isOwner}
                  isAdmin={isAdmin}
                  isRelayDocument={doc.isRelayDocument === true}
                  onRename={() => handleRename(doc)}
                  onShare={() => handleShare(doc)}
                  onTransfer={() => handleTransfer(doc)}
                  onDelete={() => handleDelete(doc)}
                />
              </div>
            );
          })
        )}
      </div>

      {/* Create Document Modal */}
      {createModal && (
        <div className="modal-overlay" onClick={() => setCreateModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Create New Document</h3>
            <input
              type="text"
              className="modal-input"
              placeholder="Document name"
              value={newDocName}
              onChange={(e) => setNewDocName(e.target.value)}
              autoFocus
            />
            <div className="modal-actions">
              <button
                className="modal-button secondary"
                onClick={() => setCreateModal(false)}
              >
                Cancel
              </button>
              <button
                className="modal-button primary"
                onClick={handleCreateDocument}
                disabled={!newDocName.trim()}
              >
                Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Rename Modal */}
      {renameModal && (
        <div className="modal-overlay" onClick={() => setRenameModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Rename Document</h3>
            <input
              type="text"
              className="modal-input"
              value={renameModal.name}
              onChange={(e) =>
                setRenameModal({ ...renameModal, name: e.target.value })
              }
              autoFocus
            />
            <div className="modal-actions">
              <button
                className="modal-button secondary"
                onClick={() => setRenameModal(null)}
              >
                Cancel
              </button>
              <button
                className="modal-button primary"
                onClick={handleRenameConfirm}
                disabled={!renameModal.name.trim()}
              >
                Rename
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      {deleteConfirm && (
        <div className="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Delete Document?</h3>
            <p className="modal-message">
              Are you sure you want to delete "{deleteConfirm.name}"?
              This action cannot be undone.
            </p>
            <div className="modal-actions">
              <button
                className="modal-button secondary"
                onClick={() => setDeleteConfirm(null)}
              >
                Cancel
              </button>
              <button
                className="modal-button danger"
                onClick={handleDeleteConfirm}
              >
                Delete
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Share Modal - placeholder for now */}
      {shareModal && (
        <div className="modal-overlay" onClick={() => setShareModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">Share "{shareModal.name}"</h3>
            <p className="modal-message">
              Share functionality coming soon. This will allow you to share
              documents with specific relay members.
            </p>
            <div className="modal-actions">
              <button
                className="modal-button primary"
                onClick={() => setShareModal(null)}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Transfer Modal */}
      {transferModal && (
        <div className="modal-overlay" onClick={() => setTransferModal(null)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <h3 className="modal-title">
              {transferModal.isRelayDocument ? 'Transfer to Personal' : 'Transfer to Team'}
            </h3>
            <p className="modal-message">
              {transferModal.isRelayDocument
                ? `This will convert "${transferModal.name}" to a personal document. It will no longer be shared with the team.`
                : `This will convert "${transferModal.name}" to a relay document. It can then be shared with relay members.`}
            </p>
            <div className="modal-actions">
              <button
                className="modal-button secondary"
                onClick={() => setTransferModal(null)}
              >
                Cancel
              </button>
              <button
                className={`modal-button ${transferModal.isRelayDocument ? 'secondary' : 'primary'}`}
                onClick={handleTransferConfirm}
              >
                {transferModal.isRelayDocument ? 'Make Personal' : 'Make Relay Document'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default RelayDocumentsManager;
