/**
 * UnifiedToolbar - The global app bar.
 *
 * App-level chrome only: document name + save status, the Relaxed focus switch,
 * the layout selector, whiteboard, help, and settings. Canvas-editing controls
 * (drawing tools, shape pickers, import, rebuild, undo/redo, canvas page tabs)
 * live in CanvasToolbar inside the canvas region so they don't leak app-wide.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { StickyNote, CircleHelp, Settings, FileInput, FolderOpen, MoreHorizontal } from 'lucide-react';
import { Icon, PdfIcon } from './icons';
import { useMobileAdaptation } from './layout/useMobileAdaptation';
import { ToolbarGroup } from './ToolbarGroup';
import { PDFExportDialog } from './PDFExportDialog';
import { usePersistenceStore } from '../store/persistenceStore';
import { useWhiteboardStore } from '../store/whiteboardStore';
import { useActiveDocReadOnly } from '../store/documentRegistry';
import { useAutoSave } from '../hooks/useAutoSave';
import { opener } from '../platform/opener';
import { LayoutSelector } from './layout/LayoutSelector';
import { RelaxedFocusControl } from './layout/RelaxedFocusControl';
import { useActiveLayoutMode } from './layout/useLayout';
import './UnifiedToolbar.css';

/**
 * Inline document name with save status.
 */
function DocumentInfo() {
  const currentDocumentName = usePersistenceStore((state) => state.currentDocumentName);
  const renameDocument = usePersistenceStore((state) => state.renameDocument);
  const { isDirty, status, saveNow } = useAutoSave();

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleStartEdit = useCallback(() => {
    setEditValue(currentDocumentName);
    setIsEditing(true);
  }, [currentDocumentName]);

  const handleSubmit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== currentDocumentName) {
      renameDocument(trimmed);
    }
    setIsEditing(false);
  }, [editValue, currentDocumentName, renameDocument]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSubmit();
      else if (e.key === 'Escape') handleCancel();
    },
    [handleSubmit, handleCancel]
  );

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  return (
    <div className="document-info">
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          className="document-name-input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSubmit}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <button className="document-name-button" onClick={handleStartEdit} title="Click to rename">
          {currentDocumentName}
        </button>
      )}
      <span
        className={`document-status ${status === 'saving' ? 'saving' : isDirty ? 'dirty' : 'saved'}`}
        onClick={isDirty ? saveNow : undefined}
        title={status === 'saving' ? 'Saving...' : isDirty ? 'Unsaved changes - click to save' : 'Saved'}
      >
        {status === 'saving' ? (
          <SavingIcon />
        ) : isDirty ? (
          <DirtyIcon />
        ) : (
          <SavedIcon />
        )}
      </span>
    </div>
  );
}

function SavingIcon() {
  return (
    <svg className="status-icon saving-spin" width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="20 8" />
    </svg>
  );
}

function DirtyIcon() {
  return (
    <svg className="status-icon" width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <circle cx="7" cy="7" r="4" />
    </svg>
  );
}

function SavedIcon() {
  return (
    <svg className="status-icon saved-check" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path className="check-path" d="M3 7l3 3 5-6" />
    </svg>
  );
}

/**
 * Props for UnifiedToolbar.
 */
interface UnifiedToolbarProps {
  onOpenSettings?: () => void;
  onOpenLayoutSettings?: () => void;
  /** Open the first-class Documents surface (JP-218). */
  onOpenDocuments?: () => void;
}

/**
 * Open documentation in the system browser. `platform.opener` uses the
 * bundled/offline docs on desktop and the online docs on web (and as a
 * desktop fallback).
 */
async function openDocsHandler() {
  await opener.openDocs();
}

/**
 * UnifiedToolbar component — the global app bar.
 */
export function UnifiedToolbar({
  onOpenSettings,
  onOpenLayoutSettings,
  onOpenDocuments,
}: UnifiedToolbarProps) {
  const activeLayout = useActiveLayoutMode();
  const [showPdfExport, setShowPdfExport] = useState(false);
  // JP-370: import writes into the active doc → disable it on a view-only doc.
  // Whiteboard (scratch overlay), Export, Help and Settings stay read-safe.
  const isReadOnly = useActiveDocReadOnly();
  // On mobile the low-frequency actions collapse into the command palette; the
  // bar keeps just Documents, the doc identity, the view cluster, and Settings.
  const { mobileActive } = useMobileAdaptation();

  // The PDF export dialog lives in this component's local state, so the palette
  // (and any other caller) opens it via an event — mirroring the import bridge.
  useEffect(() => {
    const open = () => setShowPdfExport(true);
    window.addEventListener('docushark:open-pdf-export', open);
    return () => window.removeEventListener('docushark:open-pdf-export', open);
  }, []);

  return (
    <>
    <div className="unified-toolbar">
      {/* Left: Documents launcher + document identity */}
      <div className="unified-toolbar-left">
        {onOpenDocuments && (
          <button
            className="toolbar-documents-btn"
            onClick={onOpenDocuments}
            title="Documents (Ctrl+Shift+O)"
            aria-label="Documents"
          >
            <Icon icon={FolderOpen} size={14} />
            <span>Documents</span>
          </button>
        )}
        <DocumentInfo />
      </div>

      {/* Right: view controls (the context cluster) + app actions */}
      <div className="unified-toolbar-right">
        <ToolbarGroup label="View" className="unified-toolbar-view">
          {activeLayout === 'relaxed' && <RelaxedFocusControl />}
          <LayoutSelector onOpenLayoutSettings={onOpenLayoutSettings} />
        </ToolbarGroup>

        <ToolbarGroup label="Actions" className="unified-toolbar-actions">
          {mobileActive ? (
            // Collapse Import / Whiteboard / Export / Help into the command
            // palette (which doubles as the touch action menu). One affordance.
            <button
              className="toolbar-help-btn"
              onClick={() =>
                window.dispatchEvent(new CustomEvent('docushark:toggle-command-palette'))
              }
              title="More actions"
              aria-label="More actions"
            >
              <Icon icon={MoreHorizontal} />
            </button>
          ) : (
            <>
              <button
                className="toolbar-help-btn"
                onClick={() => window.dispatchEvent(new CustomEvent('docushark:import-diagram'))}
                disabled={isReadOnly}
                title={
                  isReadOnly
                    ? 'Import is unavailable on a view-only document'
                    : 'Import diagram (Excalidraw, drawio, Mermaid)'
                }
                aria-label="Import diagram (Excalidraw, drawio, Mermaid)"
              >
                <Icon icon={FileInput} />
              </button>
              <button
                className="toolbar-whiteboard-btn"
                onClick={() => useWhiteboardStore.getState().toggleVisibility()}
                title="Whiteboard — sticky notes for brainstorming (Ctrl+I)"
                aria-label="Whiteboard"
              >
                <Icon icon={StickyNote} />
              </button>
              <button
                className="toolbar-export-btn"
                onClick={() => setShowPdfExport(true)}
                title="Export to PDF"
                aria-label="Export to PDF"
              >
                <PdfIcon />
              </button>
              <button
                className="toolbar-help-btn"
                onClick={() => void openDocsHandler()}
                title="Open documentation (F1)"
              >
                <Icon icon={CircleHelp} />
              </button>
            </>
          )}
          {onOpenSettings && (
            <button
              className="toolbar-settings-btn"
              onClick={onOpenSettings}
              title="Settings (Documents, Theme, Storage, Libraries)"
            >
              <Icon icon={Settings} size={14} />
              <span>Settings</span>
            </button>
          )}
        </ToolbarGroup>
      </div>
    </div>
    <PDFExportDialog isOpen={showPdfExport} onClose={() => setShowPdfExport(false)} />
    </>
  );
}

export default UnifiedToolbar;
