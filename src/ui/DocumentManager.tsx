/**
 * DocumentManager modal for managing saved documents.
 *
 * Features:
 * - List of saved documents
 * - Create new document
 * - Open existing document
 * - Delete documents
 * - Import JSON file
 */

import { useState, useCallback, useEffect } from 'react';
import {
  usePersistenceStore,
  uploadDocument,
} from '../store/persistenceStore';
import { importDocumentArchive } from '../storage/DocumentArchiveService';
import { useNotificationStore } from '../store/notificationStore';
import { DocumentMetadata } from '../types/Document';
import './DocumentManager.css';

interface DocumentManagerProps {
  isOpen: boolean;
  onClose: () => void;
}

export function DocumentManager({ isOpen, onClose }: DocumentManagerProps) {
  const documents = usePersistenceStore((state) => state.documents);
  const currentDocumentId = usePersistenceStore((state) => state.currentDocumentId);
  const getDocumentList = usePersistenceStore((state) => state.getDocumentList);
  const newDocument = usePersistenceStore((state) => state.newDocument);
  const loadDocument = usePersistenceStore((state) => state.loadDocument);
  const deleteDocument = usePersistenceStore((state) => state.deleteDocument);
  const isDirty = usePersistenceStore((state) => state.isDirty);
  const saveDocument = usePersistenceStore((state) => state.saveDocument);

  const [documentList, setDocumentList] = useState<DocumentMetadata[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  // Update document list when documents change
  useEffect(() => {
    setDocumentList(getDocumentList());
  }, [documents, getDocumentList]);

  // Close on escape key
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  // Handle create new document
  const handleNew = useCallback(() => {
    // Warn if there are unsaved changes
    if (isDirty) {
      const confirmed = window.confirm(
        'You have unsaved changes. Do you want to save before creating a new document?'
      );
      if (confirmed) {
        saveDocument();
      }
    }

    newDocument();
    onClose();
  }, [isDirty, saveDocument, newDocument, onClose]);

  // Handle open document
  const handleOpen = useCallback(() => {
    if (!selectedId) return;

    // Warn if there are unsaved changes
    if (isDirty) {
      const confirmed = window.confirm(
        'You have unsaved changes. Do you want to save before opening another document?'
      );
      if (confirmed) {
        saveDocument();
      }
    }

    loadDocument(selectedId);
    onClose();
  }, [selectedId, isDirty, saveDocument, loadDocument, onClose]);

  // Handle delete document
  const handleDelete = useCallback(() => {
    if (!confirmDelete) return;

    deleteDocument(confirmDelete);
    setConfirmDelete(null);
    setSelectedId(null);
  }, [confirmDelete, deleteDocument]);

  // Handle import
  const handleImport = useCallback(async () => {
    // Warn if there are unsaved changes
    if (isDirty) {
      const confirmed = window.confirm(
        'You have unsaved changes. Do you want to save before importing?'
      );
      if (confirmed) {
        saveDocument();
      }
    }

    const success = await uploadDocument();
    if (success) {
      onClose();
    }
  }, [isDirty, saveDocument, onClose]);

  // Handle import of a native .docushark archive (document + bundled blobs)
  const handleImportArchive = useCallback(() => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.docushark';
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (isDirty) {
        const confirmed = window.confirm(
          'You have unsaved changes. Do you want to save before importing?'
        );
        if (confirmed) saveDocument();
      }
      try {
        const result = await importDocumentArchive(file);
        if (result.success && result.documentId) {
          loadDocument(result.documentId);
          onClose();
        } else {
          useNotificationStore
            .getState()
            .error(result.warnings[0] ?? 'Failed to import document');
        }
      } catch (err) {
        useNotificationStore
          .getState()
          .error(`Import failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    input.click();
  }, [isDirty, saveDocument, loadDocument, onClose]);

  // Format date for display
  const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp);
    const now = new Date();
    const isToday = date.toDateString() === now.toDateString();

    if (isToday) {
      return `Today at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    const yesterday = new Date(now);
    yesterday.setDate(yesterday.getDate() - 1);
    const isYesterday = date.toDateString() === yesterday.toDateString();

    if (isYesterday) {
      return `Yesterday at ${date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    return date.toLocaleDateString([], {
      month: 'short',
      day: 'numeric',
      year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
    });
  };

  if (!isOpen) return null;

  return (
    <div className="document-manager-overlay" onClick={onClose}>
      <div className="document-manager" onClick={(e) => e.stopPropagation()}>
        <div className="document-manager-header">
          <h2>Documents</h2>
          <button className="document-manager-close" onClick={onClose}>
            ×
          </button>
        </div>

        <div className="document-manager-content">
          <div className="document-manager-actions">
            <button className="document-manager-action-btn primary" onClick={handleNew}>
              + New Document
            </button>
            <button
              className="document-manager-action-btn"
              onClick={handleImportArchive}
              title="Import a .docushark document (with its assets)"
            >
              Import .docushark
            </button>
            <button
              className="document-manager-action-btn"
              onClick={handleImport}
              title="Import a document from a JSON file"
            >
              Import JSON
            </button>
          </div>

          <div className="document-manager-list">
            {documentList.length === 0 ? (
              <div className="document-manager-empty">
                No saved documents yet.
                <br />
                Create a new document to get started.
              </div>
            ) : (
              documentList.map((doc) => (
                <div
                  key={doc.id}
                  className={`document-manager-item ${selectedId === doc.id ? 'selected' : ''} ${currentDocumentId === doc.id ? 'current' : ''}`}
                  onClick={() => setSelectedId(doc.id)}
                  onDoubleClick={() => {
                    setSelectedId(doc.id);
                    handleOpen();
                  }}
                >
                  <div className="document-manager-item-icon">📄</div>
                  <div className="document-manager-item-info">
                    <div className="document-manager-item-name">
                      {doc.name}
                      {currentDocumentId === doc.id && (
                        <span className="document-manager-item-current">(Current)</span>
                      )}
                    </div>
                    <div className="document-manager-item-meta">
                      {doc.pageCount} page{doc.pageCount !== 1 ? 's' : ''} •{' '}
                      {formatDate(doc.modifiedAt)}
                    </div>
                  </div>
                  {confirmDelete === doc.id ? (
                    <div className="document-manager-item-confirm">
                      <button
                        className="document-manager-confirm-btn danger"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleDelete();
                        }}
                      >
                        Delete
                      </button>
                      <button
                        className="document-manager-confirm-btn"
                        onClick={(e) => {
                          e.stopPropagation();
                          setConfirmDelete(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      className="document-manager-item-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        setConfirmDelete(doc.id);
                      }}
                      title="Delete document"
                    >
                      🗑
                    </button>
                  )}
                </div>
              ))
            )}
          </div>
        </div>

        <div className="document-manager-footer">
          <button className="document-manager-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="document-manager-btn primary"
            onClick={handleOpen}
            disabled={!selectedId || selectedId === currentDocumentId}
          >
            Open
          </button>
        </div>
      </div>
    </div>
  );
}
