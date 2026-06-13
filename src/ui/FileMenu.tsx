/**
 * File menu component with document and export options.
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';
import { Icon } from './icons';
import { useSessionStore } from '../store/sessionStore';
import {
  usePersistenceStore,
  downloadDocument,
  uploadDocument,
} from '../store/persistenceStore';
import { ExportDialog } from './ExportDialog';
import { StorageManager } from './StorageManager';
import './FileMenu.css';

export function FileMenu() {
  const [isMenuOpen, setIsMenuOpen] = useState(false);
  const [exportDialogOpen, setExportDialogOpen] = useState(false);
  const [storageManagerOpen, setStorageManagerOpen] = useState(false);
  const [exportScope, setExportScope] = useState<'all' | 'selection'>('all');
  const menuRef = useRef<HTMLDivElement>(null);

  const selectedIds = useSessionStore((s) => s.selectedIds);
  const hasSelection = selectedIds.size > 0;

  const isDirty = usePersistenceStore((s) => s.isDirty);
  const newDocument = usePersistenceStore((s) => s.newDocument);
  const saveDocument = usePersistenceStore((s) => s.saveDocument);
  const currentDocumentName = usePersistenceStore((s) => s.currentDocumentName);

  // Close menu when clicking outside
  useEffect(() => {
    if (!isMenuOpen) return;

    function handleClickOutside(event: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setIsMenuOpen(false);
      }
    }

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isMenuOpen]);

  // Close menu on escape
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape' && isMenuOpen) {
        setIsMenuOpen(false);
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isMenuOpen]);

  const handleExport = useCallback((scope: 'all' | 'selection') => {
    setExportScope(scope);
    setExportDialogOpen(true);
    setIsMenuOpen(false);
  }, []);

  const handleCloseExportDialog = useCallback(() => {
    setExportDialogOpen(false);
  }, []);

  const handleOpenStorageManager = useCallback(() => {
    setStorageManagerOpen(true);
    setIsMenuOpen(false);
  }, []);

  const handleCloseStorageManager = useCallback(() => {
    setStorageManagerOpen(false);
  }, []);

  // Document operations
  const handleNew = useCallback(() => {
    if (isDirty) {
      const confirmed = window.confirm(
        'You have unsaved changes. Do you want to save before creating a new document?'
      );
      if (confirmed) {
        saveDocument();
      }
    }
    newDocument();
    setIsMenuOpen(false);
  }, [isDirty, saveDocument, newDocument]);

  const handleSave = useCallback(() => {
    saveDocument();
    setIsMenuOpen(false);
  }, [saveDocument]);

  const handleExportDocument = useCallback(() => {
    downloadDocument(`${currentDocumentName}.json`);
    setIsMenuOpen(false);
  }, [currentDocumentName]);

  const handleImportDocument = useCallback(async () => {
    if (isDirty) {
      const confirmed = window.confirm(
        'You have unsaved changes. Do you want to save before importing?'
      );
      if (confirmed) {
        saveDocument();
      }
    }
    await uploadDocument();
    setIsMenuOpen(false);
  }, [isDirty, saveDocument]);

  // Keyboard shortcuts
  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Ctrl+N - New document
      if (event.ctrlKey && event.key === 'n') {
        event.preventDefault();
        handleNew();
      }
      // Ctrl+S - Save
      if (event.ctrlKey && !event.shiftKey && event.key === 's') {
        event.preventDefault();
        handleSave();
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [handleNew, handleSave]);

  return (
    <>
      <div className="file-menu" ref={menuRef}>
        <button
          className={`file-menu-trigger ${isMenuOpen ? 'active' : ''}`}
          onClick={() => setIsMenuOpen(!isMenuOpen)}
          aria-haspopup="true"
          aria-expanded={isMenuOpen}
        >
          File
          <Icon icon={ChevronDown} size={12} className="file-menu-arrow" />
        </button>

        {isMenuOpen && (
          <div className="file-menu-dropdown">
            {/* Document operations */}
            <button className="file-menu-item" onClick={handleNew}>
              <span className="file-menu-item-label">New Document</span>
              <span className="file-menu-item-shortcut">Ctrl+N</span>
            </button>
            <button className="file-menu-item" onClick={handleSave}>
              <span className="file-menu-item-label">Save</span>
              <span className="file-menu-item-shortcut">Ctrl+S</span>
            </button>

            <div className="file-menu-separator" />

            {/* Import/Export document */}
            <button className="file-menu-item" onClick={handleImportDocument}>
              <span className="file-menu-item-label">Import Document...</span>
            </button>
            <button className="file-menu-item" onClick={handleExportDocument}>
              <span className="file-menu-item-label">Export Document...</span>
            </button>

            <div className="file-menu-separator" />

            {/* Storage management */}
            <button className="file-menu-item" onClick={handleOpenStorageManager}>
              <span className="file-menu-item-label">Storage Manager...</span>
            </button>

            <div className="file-menu-separator" />

            {/* Image export */}
            <button
              className="file-menu-item"
              onClick={() => handleExport('all')}
            >
              <span className="file-menu-item-label">Export as PNG...</span>
              <span className="file-menu-item-shortcut">Ctrl+Shift+E</span>
            </button>
            <button
              className="file-menu-item"
              onClick={() => handleExport('all')}
            >
              <span className="file-menu-item-label">Export as SVG...</span>
            </button>

            <div className="file-menu-separator" />

            <button
              className={`file-menu-item ${!hasSelection ? 'disabled' : ''}`}
              onClick={() => hasSelection && handleExport('selection')}
              disabled={!hasSelection}
            >
              <span className="file-menu-item-label">Export Selection as PNG...</span>
            </button>
            <button
              className={`file-menu-item ${!hasSelection ? 'disabled' : ''}`}
              onClick={() => hasSelection && handleExport('selection')}
              disabled={!hasSelection}
            >
              <span className="file-menu-item-label">Export Selection as SVG...</span>
            </button>
          </div>
        )}
      </div>

      <ExportDialog
        isOpen={exportDialogOpen}
        onClose={handleCloseExportDialog}
        scope={exportScope}
        defaultFilename="diagram"
      />

      {storageManagerOpen && (
        <StorageManager onClose={handleCloseStorageManager} />
      )}
    </>
  );
}
