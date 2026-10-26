/**
 * SaveStatusIndicator component for displaying document name and save status.
 *
 * Shows:
 * - Document name (editable on click)
 * - Save status indicator (dirty/saving/saved)
 * - Last saved timestamp
 */

import { useState, useRef, useEffect, useCallback } from 'react';
import { usePersistenceStore } from '../store/persistenceStore';
import { useAutoSave, formatLastSaved } from '../hooks/useAutoSave';
import './SaveStatusIndicator.css';

export function SaveStatusIndicator() {
  const currentDocumentName = usePersistenceStore((state) => state.currentDocumentName);
  const renameDocument = usePersistenceStore((state) => state.renameDocument);

  const { status, isDirty, lastSavedAt, saveNow } = useAutoSave();

  // Editing state
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Time display state (for updating "X minutes ago")
  const [, setTick] = useState(0);

  // Update time display periodically
  useEffect(() => {
    const interval = setInterval(() => {
      setTick((t) => t + 1);
    }, 30000); // Update every 30 seconds

    return () => clearInterval(interval);
  }, []);

  // Start editing
  const handleStartEdit = useCallback(() => {
    setEditValue(currentDocumentName);
    setIsEditing(true);
  }, [currentDocumentName]);

  // Submit edit
  const handleSubmit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== currentDocumentName) {
      renameDocument(trimmed);
    }
    setIsEditing(false);
  }, [editValue, currentDocumentName, renameDocument]);

  // Cancel edit
  const handleCancel = useCallback(() => {
    setIsEditing(false);
    setEditValue('');
  }, []);

  // Handle key events
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleSubmit();
      } else if (e.key === 'Escape') {
        handleCancel();
      }
    },
    [handleSubmit, handleCancel]
  );

  // Focus input when editing starts
  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  // Get status icon and text
  const getStatusDisplay = () => {
    if (status === 'saving') {
      return { icon: 'saving', text: 'Saving...', className: 'saving' };
    }
    if (isDirty) {
      return { icon: 'dirty', text: 'Unsaved', className: 'dirty' };
    }
    if (status === 'saved' || lastSavedAt) {
      return { icon: 'saved', text: formatLastSaved(lastSavedAt), className: 'saved' };
    }
    return { icon: '', text: '', className: '' };
  };

  const statusDisplay = getStatusDisplay();

  const renderStatusIcon = () => {
    switch (statusDisplay.icon) {
      case 'saving':
        return <SavingIcon />;
      case 'dirty':
        return <DirtyIcon />;
      case 'saved':
        return <SavedIcon />;
      default:
        return null;
    }
  };

  return (
    <div className="save-status-indicator">
      <div className="save-status-name">
        {isEditing ? (
          <input
            ref={inputRef}
            type="text"
            className="save-status-input"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={handleSubmit}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <button
            className="save-status-name-button"
            onClick={handleStartEdit}
            title="Click to rename document"
          >
            {currentDocumentName}
            {isDirty && <span className="save-status-dirty-dot">●</span>}
          </button>
        )}
      </div>

      {statusDisplay.text && (
        <div className={`save-status-badge ${statusDisplay.className}`}>
          <span className="save-status-icon">{renderStatusIcon()}</span>
          <span className="save-status-text">{statusDisplay.text}</span>
        </div>
      )}

      {isDirty && (
        <button className="save-status-save-button" onClick={saveNow} title="Save now">
          Save
        </button>
      )}
    </div>
  );
}

// SVG Icons for save status

function SavingIcon() {
  return (
    <svg className="save-icon-svg saving-spin" width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="20 8" />
    </svg>
  );
}

function DirtyIcon() {
  return (
    <svg className="save-icon-svg" width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <circle cx="7" cy="7" r="4" />
    </svg>
  );
}

function SavedIcon() {
  return (
    <svg className="save-icon-svg saved-check" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path className="check-path" d="M3 7l3 3 5-6" />
    </svg>
  );
}
