/**
 * DocumentCard component
 *
 * Displays a document with its metadata, type badge, sync status, and actions.
 * Used in the DocumentBrowser for unified document listing.
 */

import { useState, useCallback, useEffect } from 'react';
import { SyncStatusBadge, type ExtendedSyncState } from './SyncStatusBadge';
import type { DocumentRecord, Permission } from '../types/DocumentRegistry';
import './DocumentCard.css';

interface DocumentCardProps {
  /** Document record to display */
  record: DocumentRecord;
  /** Whether this document is available in offline cache */
  isOfflineAvailable?: boolean | undefined;
  /** Whether this document is currently active/open */
  isActive?: boolean | undefined;
  /** Whether the document is currently selected (multi-select) */
  isSelected?: boolean | undefined;
  /** Show the selection checkbox affordance even when not hovered */
  showSelectionCheckbox?: boolean | undefined;
  /** Callback when document is clicked (to open) */
  onOpen?: ((id: string) => void | Promise<void>) | undefined;
  /** Callback when delete is requested */
  onDelete?: ((id: string) => void | Promise<void>) | undefined;
  /** Callback when rename is requested */
  onRename?: ((id: string, newName: string) => void) | undefined;
  /** Callback to edit permissions (ownership/access) */
  onEditPermissions?: ((id: string) => void) | undefined;
  /** Callback to publish local document to relay */
  onPublishToTeam?: ((id: string) => void | Promise<void>) | undefined;
  /** Callback to move a relay document back to personal */
  onMoveToPersonal?: ((id: string) => void | Promise<void>) | undefined;
  /** Callback when the card's selection checkbox is toggled. Receives the modifier flags so callers can implement range-select on shift-click. */
  onSelectToggle?:
    | ((id: string, mods: { shift: boolean; meta: boolean }) => void)
    | undefined;
  /** Optional group accent (used to surface group membership in the card). */
  groupAccent?: { name: string; color?: string | undefined } | undefined;
  /** Display mode */
  mode?: 'compact' | 'full' | 'grid' | undefined;
}

function formatDate(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 7) return `${diffDays}d ago`;

  return date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: date.getFullYear() !== now.getFullYear() ? 'numeric' : undefined,
  });
}

function getTypeLabel(type: DocumentRecord['type']): string {
  switch (type) {
    case 'local':
      return 'Personal';
    case 'remote':
      return 'Team';
    case 'cached':
      return 'Offline';
  }
}

function getSyncState(record: DocumentRecord): ExtendedSyncState {
  switch (record.type) {
    case 'local':
      return 'local';
    case 'remote':
      return record.syncState;
    case 'cached':
      return 'offline';
  }
}

function getPermissionLabel(permission: Permission): string {
  switch (permission) {
    case 'owner':
      return 'Owner';
    case 'editor':
      return 'Edit';
    case 'viewer':
      return 'View';
  }
}

export function DocumentCard({
  record,
  isActive = false,
  isSelected = false,
  showSelectionCheckbox = false,
  isOfflineAvailable = false,
  onOpen,
  onDelete,
  onRename,
  onEditPermissions,
  onPublishToTeam,
  onMoveToPersonal,
  onSelectToggle,
  groupAccent,
  mode = 'compact',
}: DocumentCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(record.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isMovingToPersonal, setIsMovingToPersonal] = useState(false);

  // Sync editName when record.name changes externally
  useEffect(() => {
    if (!isEditing) {
      setEditName(record.name);
    }
  }, [record.name, isEditing]);

  const handlePublish = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onPublishToTeam) return;
    setIsPublishing(true);
    try {
      await onPublishToTeam(record.id);
    } finally {
      setIsPublishing(false);
    }
  }, [onPublishToTeam, record.id]);

  const handleMoveToPersonal = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onMoveToPersonal) return;
    setIsMovingToPersonal(true);
    try {
      await onMoveToPersonal(record.id);
    } finally {
      setIsMovingToPersonal(false);
    }
  }, [onMoveToPersonal, record.id]);

  const handleClick = useCallback(
    (e: React.MouseEvent) => {
      if (isEditing) return;
      // Modifier-click selects rather than opens, when selection is available.
      if (onSelectToggle && (e.metaKey || e.ctrlKey || e.shiftKey)) {
        e.preventDefault();
        onSelectToggle(record.id, {
          shift: e.shiftKey,
          meta: e.metaKey || e.ctrlKey,
        });
        return;
      }
      if (onOpen) {
        onOpen(record.id);
      }
    },
    [isEditing, onOpen, onSelectToggle, record.id]
  );

  const handleCheckboxClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!onSelectToggle) return;
      onSelectToggle(record.id, {
        shift: e.shiftKey,
        meta: e.metaKey || e.ctrlKey,
      });
    },
    [onSelectToggle, record.id]
  );

  const handleDoubleClick = useCallback(() => {
    if (onRename) {
      setEditName(record.name);
      setIsEditing(true);
    }
  }, [onRename, record.name]);

  const handleRename = useCallback(() => {
    const trimmedName = editName.trim();
    if (trimmedName && trimmedName !== record.name && onRename) {
      onRename(record.id, trimmedName);
    }
    setIsEditing(false);
  }, [editName, record.id, record.name, onRename]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleRename();
      } else if (e.key === 'Escape') {
        setIsEditing(false);
        setEditName(record.name);
      }
    },
    [handleRename, record.name]
  );

  const handleDeleteClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(true);
  }, []);

  const handleDeleteConfirm = useCallback(() => {
    if (onDelete) {
      onDelete(record.id);
    }
    setShowDeleteConfirm(false);
  }, [onDelete, record.id]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(false);
  }, []);

  const syncState = getSyncState(record);
  const isRemoteOrCached = record.type === 'remote' || record.type === 'cached';

  const showCheckbox = Boolean(onSelectToggle) && (showSelectionCheckbox || isSelected);

  return (
    <div
      className={`document-card document-card--${mode} ${isActive ? 'document-card--active' : ''} ${isSelected ? 'document-card--selected' : ''}`}
      onClick={handleClick}
      onDoubleClick={handleDoubleClick}
    >
      {onSelectToggle && (
        <button
          type="button"
          className={`document-card__select ${showCheckbox ? 'document-card__select--visible' : ''} ${isSelected ? 'document-card__select--checked' : ''}`}
          onClick={handleCheckboxClick}
          title={isSelected ? 'Deselect' : 'Select'}
          aria-pressed={isSelected}
        >
          {isSelected ? '✓' : ''}
        </button>
      )}
      <div className="document-card__content">
        {/* Name */}
        <div className="document-card__name-row">
          {isEditing ? (
            <input
              type="text"
              className="document-card__name-input"
              value={editName}
              onChange={(e) => setEditName(e.target.value)}
              onBlur={handleRename}
              onKeyDown={handleKeyDown}
              autoFocus
              onClick={(e) => e.stopPropagation()}
            />
          ) : (
            <span className="document-card__name" title={record.name}>
              {record.name}
            </span>
          )}
          {isActive && <span className="document-card__active-badge">Open</span>}
          {groupAccent && (
            <span
              className="document-card__group-chip"
              title={`Group: ${groupAccent.name}`}
              style={groupAccent.color ? { background: groupAccent.color } : undefined}
            >
              {groupAccent.name}
            </span>
          )}
        </div>

        {/* Metadata row */}
        <div className="document-card__meta">
          {/* Type badge */}
          <span className={`document-card__type document-card__type--${record.type}`}>
            {getTypeLabel(record.type)}
          </span>

          {/* Offline available indicator (for team docs cached locally) */}
          {record.type === 'remote' && isOfflineAvailable && (
            <span 
              className="document-card__offline-badge" 
              title="Available offline - cached locally"
            >
              📴
            </span>
          )}

          {/* Sync status */}
          <SyncStatusBadge state={syncState} size="small" />

          {/* Permission (for remote/cached) */}
          {isRemoteOrCached && (
            <span className="document-card__permission">
              {getPermissionLabel((record as { permission: Permission }).permission)}
            </span>
          )}

          {/* Page count */}
          <span className="document-card__pages">{record.pageCount} page{record.pageCount !== 1 ? 's' : ''}</span>

          {/* Modified time */}
          <span className="document-card__date">{formatDate(record.modifiedAt)}</span>
        </div>

        {/* Owner info for remote docs */}
        {mode === 'full' && record.type === 'remote' && (
          <div className="document-card__owner">
            Owner: {record.ownerName}
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="document-card__actions">
        {onPublishToTeam && (
          <button
            className="document-card__action document-card__action--publish"
            onClick={handlePublish}
            disabled={isPublishing}
            title="Move to relay"
          >
            {isPublishing ? '⏳' : '📤'}
          </button>
        )}
        {onMoveToPersonal && (
          <button
            className="document-card__action document-card__action--move-personal"
            onClick={handleMoveToPersonal}
            disabled={isMovingToPersonal}
            title="Move to personal"
          >
            {isMovingToPersonal ? '⏳' : '📥'}
          </button>
        )}
        {onEditPermissions && (
          <button
            className="document-card__action"
            onClick={(e) => {
              e.stopPropagation();
              onEditPermissions(record.id);
            }}
            title="Manage access"
          >
            👥
          </button>
        )}
        {onRename && (
          <button
            className="document-card__action"
            onClick={(e) => {
              e.stopPropagation();
              setEditName(record.name);
              setIsEditing(true);
            }}
            title="Rename"
          >
            ✎
          </button>
        )}
        {onDelete && !showDeleteConfirm && (
          <button
            className="document-card__action document-card__action--danger"
            onClick={handleDeleteClick}
            title="Delete"
          >
            🗑
          </button>
        )}
        {showDeleteConfirm && (
          <div className="document-card__confirm" onClick={(e) => e.stopPropagation()}>
            <span className="document-card__confirm-text">Delete?</span>
            <button className="document-card__confirm-btn document-card__confirm-yes" onClick={handleDeleteConfirm}>
              Yes
            </button>
            <button className="document-card__confirm-btn document-card__confirm-no" onClick={handleDeleteCancel}>
              No
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

export default DocumentCard;
