/**
 * Documents Settings component for the Settings modal.
 *
 * Contains:
 * - New document
 * - Open document (document list)
 * - Save document
 * - Import/Export JSON
 */

import { useState, useCallback, useMemo } from 'react';
import { usePersistenceStore } from '../../store/persistenceStore';
import { useIsRelayAuthenticated } from '../../store/connectionStore';
import { useRelayDocumentStore } from '../../store/relayDocumentStore';
import { PDFExportDialog } from '../PDFExportDialog';
import { DocumentMetadata } from '../../types/Document';
import './DocumentsSettings.css';

export function DocumentsSettings() {
  const documents = usePersistenceStore((state) => state.documents);
  const currentDocumentId = usePersistenceStore((state) => state.currentDocumentId);
  const currentDocumentName = usePersistenceStore((state) => state.currentDocumentName);
  const newDocument = usePersistenceStore((state) => state.newDocument);
  const saveDocument = usePersistenceStore((state) => state.saveDocument);
  const loadDocument = usePersistenceStore((state) => state.loadDocument);
  const deleteDocument = usePersistenceStore((state) => state.deleteDocument);
  const renameDocument = usePersistenceStore((state) => state.renameDocument);
  const exportJSON = usePersistenceStore((state) => state.exportJSON);
  const importJSON = usePersistenceStore((state) => state.importJSON);
  const transferToTeam = usePersistenceStore((state) => state.transferToTeam);
  const transferToPersonal = usePersistenceStore((state) => state.transferToPersonal);

  const isRelayLive = useIsRelayAuthenticated();

  // Team document store state
  const remoteTeamDocs = useRelayDocumentStore((state) => state.relayDocuments);
  const hostConnected = useRelayDocumentStore((state) => state.hostConnected);
  const authenticated = useRelayDocumentStore((state) => state.authenticated);
  const isLoadingList = useRelayDocumentStore((state) => state.isLoadingList);
  const teamStoreError = useRelayDocumentStore((state) => state.error);
  const fetchDocumentList = useRelayDocumentStore((state) => state.fetchDocumentList);
  const loadRelayDocument = useRelayDocumentStore((state) => state.loadRelayDocument);

  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const [pdfExportOpen, setPdfExportOpen] = useState(false);
  const [filterMode, setFilterMode] = useState<'all' | 'team' | 'personal'>('all');
  const [transferDocId, setTransferDocId] = useState<string | null>(null);
  const [transferDirection, setTransferDirection] = useState<'toTeam' | 'toPersonal'>('toTeam');

  const isInTeamMode = isRelayLive;
  const isConnectedToHost = isRelayLive && authenticated;

  // Note: Document list is automatically fetched by teamDocumentStore.setAuthenticated
  // No need to fetch here - it causes double fetches and flickering

  // Merge local and remote documents, ensuring no duplicates
  const documentList = useMemo(() => {
    // Start with local documents
    const localDocs = Object.entries(documents);

    // If connected to host as client, merge with remote relay documents
    // Use explicit deduplication with host as source of truth for team docs
    let allDocs: [string, DocumentMetadata][];

    if (isConnectedToHost) {
      const seenIds = new Set<string>();
      const dedupedDocs: [string, DocumentMetadata][] = [];

      // Add remote team docs first (source of truth for relay documents)
      for (const [id, doc] of Object.entries(remoteTeamDocs)) {
        if (!seenIds.has(id)) {
          seenIds.add(id);
          dedupedDocs.push([id, doc]);
        }
      }

      // Add personal docs from local storage (non-team docs only)
      for (const [id, doc] of localDocs) {
        if (!doc.isRelayDocument && !seenIds.has(id)) {
          seenIds.add(id);
          dedupedDocs.push([id, doc]);
        }
      }

      // Add any local team docs not yet on host (edge case during transfer)
      for (const [id, doc] of localDocs) {
        if (doc.isRelayDocument && !seenIds.has(id)) {
          seenIds.add(id);
          dedupedDocs.push([id, doc]);
        }
      }

      allDocs = dedupedDocs;
    } else {
      // Not connected as client - use local documents
      allDocs = localDocs;
    }

    // Apply filter
    if (filterMode === 'team') {
      allDocs = allDocs.filter(([, doc]) => doc.isRelayDocument);
    } else if (filterMode === 'personal') {
      allDocs = allDocs.filter(([, doc]) => !doc.isRelayDocument);
    }

    // Sort by last modified, newest first
    return allDocs.sort((a, b) => (b[1].modifiedAt || 0) - (a[1].modifiedAt || 0));
  }, [documents, remoteTeamDocs, isConnectedToHost, filterMode]);

  // Count documents by type
  const teamDocCount = useMemo(() => {
    if (isConnectedToHost) {
      return Object.keys(remoteTeamDocs).length;
    }
    return Object.values(documents).filter((d) => d.isRelayDocument).length;
  }, [documents, remoteTeamDocs, isConnectedToHost]);

  const personalDocCount = useMemo(
    () => Object.values(documents).filter((d) => !d.isRelayDocument).length,
    [documents]
  );

  const handleNewDocument = useCallback(() => {
    newDocument();
  }, [newDocument]);

  const handleSave = useCallback(() => {
    saveDocument();
  }, [saveDocument]);

  const handleLoad = useCallback(
    async (docId: string) => {
      if (docId === currentDocumentId) return;

      // Check if this is a remote relay document
      if (isConnectedToHost && remoteTeamDocs[docId]) {
        try {
          const doc = await loadRelayDocument(docId);
          // Load into page store (this function is from persistenceStore)
          // For now, we can use importJSON with the loaded document
          // TODO: Add a proper loadFromRemote action to persistenceStore
          const { usePageStore } = await import('../../store/pageStore');
          const { useRichTextStore } = await import('../../store/richTextStore');

          const snapshot = {
            pages: doc.pages,
            pageOrder: doc.pageOrder,
            activePageId: doc.activePageId,
          };
          usePageStore.getState().loadSnapshot(snapshot);
          useRichTextStore.getState().loadContent(doc.richTextContent);

          // Update persistence store state
          usePersistenceStore.setState({
            currentDocumentId: doc.id,
            currentDocumentName: doc.name,
            isDirty: false,
            lastSavedAt: doc.modifiedAt,
          });
        } catch (error) {
          console.error('Failed to load relay document:', error);
        }
      } else {
        // Load from local storage
        loadDocument(docId);
      }
    },
    [currentDocumentId, loadDocument, isConnectedToHost, remoteTeamDocs, loadRelayDocument]
  );

  const handleExport = useCallback(() => {
    const json = exportJSON();
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${currentDocumentName || 'diagram'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [exportJSON, currentDocumentName]);

  const handleImport = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (file) {
        const reader = new FileReader();
        reader.onload = (e) => {
          const content = e.target?.result as string;
          importJSON(content);
        };
        reader.readAsText(file);
      }
    };
    input.click();
  }, [importJSON]);

  const handleStartRename = useCallback((docId: string, currentName: string) => {
    setEditingId(docId);
    setEditingName(currentName);
  }, []);

  const handleRename = useCallback(() => {
    if (editingId && editingName.trim()) {
      // If renaming current document, use renameDocument
      if (editingId === currentDocumentId) {
        renameDocument(editingName.trim());
      }
      // Otherwise just update the name in documents list
      // (this would require a new store action, skip for now)
    }
    setEditingId(null);
    setEditingName('');
  }, [editingId, editingName, currentDocumentId, renameDocument]);

  const handleDelete = useCallback(
    (docId: string) => {
      deleteDocument(docId);
      setConfirmDeleteId(null);
    },
    [deleteDocument]
  );

  const handleStartTransfer = useCallback(
    (docId: string, doc: DocumentMetadata) => {
      setTransferDocId(docId);
      setTransferDirection(doc.isRelayDocument ? 'toPersonal' : 'toTeam');
    },
    []
  );

  const handleConfirmTransfer = useCallback(() => {
    if (!transferDocId) return;
    if (transferDirection === 'toTeam') {
      transferToTeam(transferDocId);
    } else {
      transferToPersonal(transferDocId);
    }
    setTransferDocId(null);
  }, [transferDocId, transferDirection, transferToTeam, transferToPersonal]);

  const handleCancelTransfer = useCallback(() => {
    setTransferDocId(null);
  }, []);

  const formatDate = (timestamp: number | undefined) => {
    if (!timestamp) return 'Never';
    return new Date(timestamp).toLocaleString();
  };

  return (
    <div className="documents-settings">
      <h3 className="settings-section-title">Documents</h3>

      {/* Quick Actions */}
      <div className="settings-group">
        <h4 className="settings-group-title">Quick Actions</h4>
        <div className="documents-actions">
          <button className="documents-action-btn documents-action-primary" onClick={handleNewDocument}>
            <span className="documents-action-icon">+</span>
            New Document
          </button>
          <button className="documents-action-btn" onClick={handleSave}>
            <span className="documents-action-icon">💾</span>
            Save Current
          </button>
        </div>
      </div>

      {/* Import/Export */}
      <div className="settings-group">
        <h4 className="settings-group-title">Import / Export</h4>
        <div className="documents-actions">
          <button className="documents-action-btn" onClick={handleImport}>
            <span className="documents-action-icon">📥</span>
            Import JSON
          </button>
          <button className="documents-action-btn" onClick={handleExport}>
            <span className="documents-action-icon">📤</span>
            Export JSON
          </button>
          <button className="documents-action-btn" onClick={() => setPdfExportOpen(true)}>
            <span className="documents-action-icon">📄</span>
            Export PDF
          </button>
        </div>
      </div>

      {/* Team Connection Status */}
      {isRelayLive && (
        <div className="settings-group">
          <div className={`documents-sync-status ${authenticated ? 'connected' : 'disconnected'}`}>
            <span className="documents-sync-indicator"></span>
            <span className="documents-sync-text">
              {!hostConnected
                ? 'Not connected to host'
                : !authenticated
                  ? 'Connecting...'
                  : `Connected to host (${teamDocCount} team docs)`}
            </span>
            {authenticated && (
              <button
                className="documents-refresh-btn"
                onClick={() => fetchDocumentList()}
                disabled={isLoadingList}
                title="Refresh relay documents"
              >
                {isLoadingList ? '...' : '↻'}
              </button>
            )}
          </div>
          {teamStoreError && (
            <div className="documents-error">{teamStoreError}</div>
          )}
        </div>
      )}

      {/* Document List */}
      <div className="settings-group">
        <div className="documents-header">
          <h4 className="settings-group-title">Saved Documents ({documentList.length})</h4>
          {isInTeamMode && (
            <div className="documents-filter">
              <button
                className={`documents-filter-btn ${filterMode === 'all' ? 'active' : ''}`}
                onClick={() => setFilterMode('all')}
                title="Show all documents"
              >
                All
              </button>
              <button
                className={`documents-filter-btn ${filterMode === 'team' ? 'active' : ''}`}
                onClick={() => setFilterMode('team')}
                title={`Show relay documents (${teamDocCount})`}
              >
                Team ({teamDocCount})
              </button>
              <button
                className={`documents-filter-btn ${filterMode === 'personal' ? 'active' : ''}`}
                onClick={() => setFilterMode('personal')}
                title={`Show personal documents (${personalDocCount})`}
              >
                Personal ({personalDocCount})
              </button>
            </div>
          )}
        </div>
        <div className="documents-list">
          {documentList.length === 0 ? (
            <div className="documents-empty">
              {filterMode === 'all'
                ? 'No saved documents yet'
                : filterMode === 'team'
                  ? 'No relay documents'
                  : 'No personal documents'}
            </div>
          ) : (
            documentList.map(([docId, doc]) => {
              const isActive = docId === currentDocumentId;
              const isEditing = editingId === docId;
              const isDeleting = confirmDeleteId === docId;

              return (
                <div
                  key={docId}
                  className={`documents-item ${isActive ? 'active' : ''}`}
                  onClick={() => !isEditing && !isDeleting && handleLoad(docId)}
                >
                  <div className="documents-item-content">
                    {isEditing ? (
                      <input
                        type="text"
                        className="documents-item-input"
                        value={editingName}
                        onChange={(e) => setEditingName(e.target.value)}
                        onBlur={handleRename}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') handleRename();
                          if (e.key === 'Escape') {
                            setEditingId(null);
                            setEditingName('');
                          }
                        }}
                        onClick={(e) => e.stopPropagation()}
                        autoFocus
                      />
                    ) : (
                      <>
                        <div className="documents-item-name-row">
                          <span className="documents-item-name">{doc.name}</span>
                          {doc.isRelayDocument && (
                            <span className="documents-item-team-badge" title="Team document">
                              T
                            </span>
                          )}
                        </div>
                        <span className="documents-item-date">
                          {formatDate(doc.modifiedAt)}
                        </span>
                      </>
                    )}
                  </div>
                  <div className="documents-item-actions" onClick={(e) => e.stopPropagation()}>
                    {isDeleting ? (
                      <>
                        <button
                          className="documents-item-btn documents-item-btn-danger"
                          onClick={() => handleDelete(docId)}
                          title="Confirm delete"
                        >
                          ✓
                        </button>
                        <button
                          className="documents-item-btn"
                          onClick={() => setConfirmDeleteId(null)}
                          title="Cancel"
                        >
                          ✕
                        </button>
                      </>
                    ) : (
                      <>
                        {isActive && (
                          <span className="documents-item-badge">Current</span>
                        )}
                        <button
                          className="documents-item-btn"
                          onClick={() => handleStartRename(docId, doc.name)}
                          title="Rename"
                        >
                          ✏️
                        </button>
                        {isInTeamMode && (
                          <button
                            className={`documents-item-btn documents-item-btn-transfer ${doc.isRelayDocument ? 'to-personal' : 'to-relay'}`}
                            onClick={() => handleStartTransfer(docId, doc)}
                            title={doc.isRelayDocument ? 'Transfer to Personal' : 'Transfer to Team'}
                          >
                            {doc.isRelayDocument ? '👤' : '👥'}
                          </button>
                        )}
                        <button
                          className="documents-item-btn"
                          onClick={() => setConfirmDeleteId(docId)}
                          title="Delete"
                          disabled={isActive}
                        >
                          🗑️
                        </button>
                      </>
                    )}
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Keyboard Shortcuts Info */}
      <div className="settings-info-box">
        <div className="settings-info-icon">⌨</div>
        <div className="settings-info-content">
          <strong>Keyboard Shortcuts:</strong> Ctrl+N (New), Ctrl+O (Open), Ctrl+S (Save)
        </div>
      </div>

      {/* Transfer Confirmation Modal */}
      {transferDocId && (
        <div className="documents-transfer-modal-overlay" onClick={handleCancelTransfer}>
          <div className="documents-transfer-modal" onClick={(e) => e.stopPropagation()}>
            <h4 className="documents-transfer-modal-title">
              {transferDirection === 'toTeam' ? 'Transfer to Team' : 'Transfer to Personal'}
            </h4>
            <p className="documents-transfer-modal-text">
              {transferDirection === 'toTeam'
                ? 'This document will become a relay document and can be shared with relay members.'
                : 'This document will become a personal document and will no longer be shared with the team.'}
            </p>
            <p className="documents-transfer-modal-doc">
              "{documents[transferDocId]?.name}"
            </p>
            <div className="documents-transfer-modal-actions">
              <button
                className="documents-transfer-modal-btn documents-transfer-modal-btn-cancel"
                onClick={handleCancelTransfer}
              >
                Cancel
              </button>
              <button
                className={`documents-transfer-modal-btn documents-transfer-modal-btn-confirm ${transferDirection}`}
                onClick={handleConfirmTransfer}
              >
                {transferDirection === 'toTeam' ? 'Transfer to Team' : 'Transfer to Personal'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* PDF Export Dialog */}
      <PDFExportDialog isOpen={pdfExportOpen} onClose={() => setPdfExportOpen(false)} />
    </div>
  );
}
