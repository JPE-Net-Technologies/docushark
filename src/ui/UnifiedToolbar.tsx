/**
 * UnifiedToolbar - The global app bar.
 *
 * App-level chrome only: document name + save status, the Relaxed focus switch,
 * the layout selector, whiteboard, help, and settings. Canvas-editing controls
 * (drawing tools, shape pickers, import, rebuild, undo/redo, canvas page tabs)
 * live in CanvasToolbar inside the canvas region so they don't leak app-wide.
 */

import { useState, useRef, useCallback, useEffect } from 'react';
import { StickyNote, CircleHelp, Settings, Import } from 'lucide-react';
import { Icon } from './icons';
import { ToolbarGroup } from './ToolbarGroup';
import { usePersistenceStore } from '../store/persistenceStore';
import { useWhiteboardStore } from '../store/whiteboardStore';
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
export function UnifiedToolbar({ onOpenSettings, onOpenLayoutSettings }: UnifiedToolbarProps) {
  const activeLayout = useActiveLayoutMode();

  return (
    <div className="unified-toolbar">
      {/* Left: document identity */}
      <div className="unified-toolbar-left">
        <DocumentInfo />
      </div>

      {/* Right: view controls (the context cluster) + app actions */}
      <div className="unified-toolbar-right">
        <ToolbarGroup label="View" className="unified-toolbar-view">
          {activeLayout === 'relaxed' && <RelaxedFocusControl />}
          <LayoutSelector onOpenLayoutSettings={onOpenLayoutSettings} />
        </ToolbarGroup>

        <ToolbarGroup label="Actions" className="unified-toolbar-actions">
          <button
            className="toolbar-help-btn"
            onClick={() => window.dispatchEvent(new CustomEvent('docushark:import-diagram'))}
            title="Import diagram (Excalidraw)"
            aria-label="Import diagram"
          >
            <Icon icon={Import} />
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
            className="toolbar-help-btn"
            onClick={() => void openDocsHandler()}
            title="Open documentation (F1)"
          >
            <Icon icon={CircleHelp} />
          </button>
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
  );
}

export default UnifiedToolbar;
