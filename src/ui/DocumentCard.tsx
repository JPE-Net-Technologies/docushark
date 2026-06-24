/**
 * DocumentCard component
 *
 * Displays a document with its metadata, type badge, sync status, and actions.
 * Used in the DocumentBrowser for unified document listing.
 */

import { memo, useState, useCallback, useEffect, useRef } from 'react';
import {
  Check,
  ChevronDown,
  Cloud,
  CloudCheck,
  CloudDownload,
  CloudOff,
  Download,
  FolderInput,
  HardDrive,
  Loader2,
  Network,
  Pencil,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { SyncStatusBadge, type ExtendedSyncState } from './SyncStatusBadge';
import { isForeignRelayDoc, type DocumentRecord, type Permission } from '../types/DocumentRegistry';
import type { Collection } from '../store/collectionStore';
import type { OfflineProgress, OfflineStatus } from '../store/offlineAvailability';
import { useConnectionStore } from '../store/connectionStore';
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
  /** Callback when delete is requested (soft delete → Trash) */
  onDelete?: ((id: string) => void | Promise<void>) | undefined;
  /** Callback when permanent delete is requested (bypasses Trash) */
  onPermanentDelete?: ((id: string) => void | Promise<void>) | undefined;
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
  /** Optional collection accent (used to surface collection membership in the card). */
  collectionAccent?: { name: string; color?: string | undefined } | undefined;
  /** All collections, for the per-card "Move to collection" menu. */
  collections?: Collection[] | undefined;
  /** The collection this doc currently belongs to (null = unassigned). */
  currentCollectionId?: string | null | undefined;
  /** Assign this doc to a collection (or null to remove). Enables the move menu. */
  onAssignCollection?: ((id: string, collectionId: string | null) => void) | undefined;
  /** Create a new collection and assign this doc to it (styled prompt). */
  onCreateCollectionFor?: ((id: string) => void) | undefined;
  /** Address (host:port) of the currently-connected relay, for connected/disconnected badge state. */
  connectedRelayAddress?: string | undefined;
  /** Offline-cache status for relay/cached docs (JP-281). Drives the offline-ready badge. */
  offlineStatus?: OfflineStatus | undefined;
  /** In-flight "make available offline" progress; non-null while caching. */
  offlineProgress?: OfflineProgress | null | undefined;
  /** Callback to proactively cache this doc's body + all referenced blobs offline. */
  onMakeAvailableOffline?: ((id: string) => void) | undefined;
  /** Display mode */
  mode?: 'compact' | 'full' | 'grid' | undefined;
}

interface OfflineBadge {
  Icon: typeof CloudCheck;
  className: string;
  title: string;
  /** When true the badge doubles as the "make available offline" trigger. */
  actionable: boolean;
}

/**
 * Offline-cache indicator for a relay/cached document. Always returns a config
 * (never hidden) — an unknown status (not yet computed) is treated as
 * actionable so the affordance is visible from the first paint.
 */
function offlineBadge(status: OfflineStatus | undefined): OfflineBadge {
  switch (status?.state) {
    case 'ready':
      return {
        Icon: CloudCheck,
        className: 'document-card__offline--ready',
        title: 'Available offline — body and all files cached locally',
        actionable: false,
      };
    case 'partial':
      return {
        Icon: CloudDownload,
        className: 'document-card__offline--partial',
        title: `Partially offline — ${status.present}/${status.total} files cached · click to finish`,
        actionable: true,
      };
    case 'online-only':
    default:
      return {
        Icon: CloudDownload,
        className: 'document-card__offline--online-only',
        title: 'Not saved offline · click to make available offline',
        actionable: true,
      };
  }
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

/** Leading icon for the document type badge. */
function TypeIcon({ type }: { type: DocumentRecord['type'] }) {
  switch (type) {
    case 'local':
      return <HardDrive size={12} aria-hidden="true" />;
    case 'remote':
      return <Cloud size={12} aria-hidden="true" />;
    case 'cached':
      return <CloudOff size={12} aria-hidden="true" />;
  }
}

export function getSyncState(
  record: DocumentRecord,
  relayConnected: boolean,
  reconnectable: boolean,
): ExtendedSyncState {
  switch (record.type) {
    case 'local':
      return 'local';
    case 'remote':
      // A remote doc whose relay isn't connected is not "synced":
      // `record.syncState` only tracks REST save/queue outcomes and defaults to
      // 'synced' (registerRemote) — it never reflects a dropped connection. When
      // disconnected, distinguish 'idle' (still signed in — left the doc but the
      // relay token is valid, so reopening reconnects instantly, JP-190) from
      // 'offline' (no valid token). Always surface a real 'error' so it isn't hidden.
      if (!relayConnected && record.syncState !== 'error') {
        return reconnectable ? 'idle' : 'offline';
      }
      return record.syncState;
    case 'cached':
      return reconnectable ? 'idle' : 'offline';
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

/** Relay host identifier (host:port) for records that belong to a relay. */
export function getRelayId(record: DocumentRecord): string | undefined {
  return record.type === 'remote' || record.type === 'cached' ? record.relayId : undefined;
}

/** Relay badge label + connected/disconnected state for a card. */
export interface RelayLabel {
  host: string;
  status: 'connected' | 'disconnected';
}

/**
 * Build the relay badge for a document, comparing its relayId against the
 * currently-connected relay address. Returns undefined for local documents,
 * which have no relay. A relayId of 'unknown' is always treated as
 * disconnected and labelled accordingly.
 */
export function formatRelayLabel(
  record: DocumentRecord,
  connectedRelayAddress: string | undefined
): RelayLabel | undefined {
  const relayId = getRelayId(record);
  if (!relayId) return undefined;
  if (relayId === 'unknown') {
    return { host: 'Unknown relay', status: 'disconnected' };
  }
  return {
    host: relayId,
    status: relayId === connectedRelayAddress ? 'connected' : 'disconnected',
  };
}

function DocumentCardImpl({
  record,
  isActive = false,
  isSelected = false,
  showSelectionCheckbox = false,
  isOfflineAvailable = false,
  onOpen,
  onDelete,
  onPermanentDelete,
  onRename,
  onEditPermissions,
  onPublishToTeam,
  onMoveToPersonal,
  onSelectToggle,
  collectionAccent,
  collections,
  currentCollectionId,
  onAssignCollection,
  onCreateCollectionFor,
  connectedRelayAddress,
  offlineStatus,
  offlineProgress,
  onMakeAvailableOffline,
  mode = 'compact',
}: DocumentCardProps) {
  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(record.name);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isMovingToPersonal, setIsMovingToPersonal] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [collMenuOpen, setCollMenuOpen] = useState(false);
  const collMenuRef = useRef<HTMLDivElement | null>(null);

  // Close the collection menu on an outside click.
  useEffect(() => {
    if (!collMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (collMenuRef.current && !collMenuRef.current.contains(e.target as Node)) {
        setCollMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [collMenuOpen]);

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

  const handlePermanentDeleteConfirm = useCallback(() => {
    if (onPermanentDelete) {
      onPermanentDelete(record.id);
    }
    setShowDeleteConfirm(false);
  }, [onPermanentDelete, record.id]);

  const handleDeleteCancel = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    setShowDeleteConfirm(false);
  }, []);

  const handleMakeOffline = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (onMakeAvailableOffline) onMakeAvailableOffline(record.id);
  }, [onMakeAvailableOffline, record.id]);

  // A still-valid cached relay token means a disconnected relay doc is only
  // *idle* (reopen reconnects instantly), not *offline*. Re-evaluates on any
  // connection-store change (token set/cleared on sign-in / sign-out).
  const relaySignedIn = useConnectionStore(
    (s) => s.token !== null && (s.tokenExpiresAt === null || Date.now() < s.tokenExpiresAt),
  );

  const relay = formatRelayLabel(record, connectedRelayAddress);
  // JP-308: the doc belongs to a relay other than the one we're connected to —
  // mark it explicitly ("Other relay") so it reads as intentionally-elsewhere
  // rather than offline/online-ambiguous. Same discriminant the demote guard uses.
  const isForeign = isForeignRelayDoc(record, connectedRelayAddress);
  // The sync badge must reflect the live connection, not the stale registry
  // default — drive it off the same connected/disconnected signal as the relay
  // badge above it. `relaySignedIn` (a valid cached token) splits a disconnected
  // doc into 'idle' (reopens instantly) vs 'offline' (JP-190).
  const syncState = getSyncState(record, relay?.status === 'connected', relaySignedIn);
  const showDetails = mode === 'full';

  const showCheckbox = Boolean(onSelectToggle) && (showSelectionCheckbox || isSelected);

  // Offline-cache surfacing (JP-281) — relay/cached docs only. Rendered in the
  // always-visible meta row (NOT the hover-only actions row) so the offline
  // state reads as passive status for every doc and the "save offline" action
  // is discoverable without hovering. Local docs are inherently offline.
  const isRelayBacked = record.type === 'remote' || record.type === 'cached';
  const isCaching = offlineProgress != null;
  const offline = isRelayBacked ? offlineBadge(offlineStatus) : null;
  const offlineActionable = Boolean(offline?.actionable && onMakeAvailableOffline);

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
          {isSelected ? <Check size={14} aria-hidden="true" /> : null}
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
          {collectionAccent && (
            <span
              className="document-card__collection-chip"
              title={`Collection: ${collectionAccent.name}`}
              style={collectionAccent.color ? { background: collectionAccent.color } : undefined}
            >
              {collectionAccent.name}
            </span>
          )}
        </div>

        {/* Metadata row — lean: type, relay, sync, modified date.
            Permission / pages / owner / full host live in the details panel. */}
        <div className="document-card__meta">
          {/* Type badge */}
          <span className={`document-card__type document-card__type--${record.type}`}>
            <TypeIcon type={record.type} />
            {getTypeLabel(record.type)}
          </span>

          {/* Sync status. The connection/offline state lives here only — a
              separate relay badge would duplicate it and leak the relay host. */}
          <SyncStatusBadge state={syncState} size="small" showLabel />

          {/* JP-308: document from another relay than the one we're on. Labelled
              generically (no host:port leak — the full host lives in the details
              panel); disambiguates "belongs elsewhere" from idle/offline. */}
          {isForeign && relay && (
            <span
              className="document-card__foreign-relay"
              title={`Stored on another relay (${relay.host}) — open it there to sync`}
            >
              <Network size={12} aria-hidden="true" />
              Other relay
            </span>
          )}

          {/* Offline-cache status + action (JP-281): always-visible (not in the
              hover-only actions row), so it reads as passive status for every
              relay doc and the "save offline" action is discoverable without
              hovering. Distinct from the sync badge — answers "is the content
              saved locally for offline use?". */}
          {offline && (
            isCaching ? (
              <span
                className="document-card__offline document-card__offline--caching"
                title="Caching for offline use…"
              >
                <Loader2 className="document-card__spin" size={12} aria-hidden="true" />
                {offlineProgress && offlineProgress.total > 0 && (
                  <span className="document-card__offline-count">
                    {offlineProgress.done}/{offlineProgress.total}
                  </span>
                )}
              </span>
            ) : offlineActionable ? (
              <button
                type="button"
                className={`document-card__offline document-card__offline--action ${offline.className}`}
                onClick={handleMakeOffline}
                title={offline.title}
                aria-label="Make available offline"
              >
                <offline.Icon size={12} aria-hidden="true" />
              </button>
            ) : (
              <span className={`document-card__offline ${offline.className}`} title={offline.title}>
                <offline.Icon size={12} aria-hidden="true" />
              </span>
            )
          )}

          {/* Modified time */}
          <span className="document-card__date">{formatDate(record.modifiedAt)}</span>
        </div>

        {/* Expandable details panel */}
        {showDetails && isExpanded && (
          <dl className="document-card__details" onClick={(e) => e.stopPropagation()}>
            {record.type === 'remote' && (
              <>
                <div className="document-card__detail">
                  <dt>Owner</dt>
                  <dd>{record.ownerName || '—'}</dd>
                </div>
                <div className="document-card__detail">
                  <dt>Permission</dt>
                  <dd>{getPermissionLabel(record.permission)}</dd>
                </div>
                <div className="document-card__detail">
                  <dt>Last synced</dt>
                  <dd>{formatDate(record.lastSyncedAt)}</dd>
                </div>
                <div className="document-card__detail">
                  <dt>Offline available</dt>
                  <dd>{isOfflineAvailable ? 'Yes' : 'No'}</dd>
                </div>
              </>
            )}
            {record.type === 'cached' && (
              <>
                <div className="document-card__detail">
                  <dt>Permission</dt>
                  <dd>{getPermissionLabel(record.permission)}</dd>
                </div>
                <div className="document-card__detail">
                  <dt>Cached</dt>
                  <dd>{formatDate(record.cachedAt)}</dd>
                </div>
                <div className="document-card__detail">
                  <dt>Pending changes</dt>
                  <dd>{record.pendingChanges}</dd>
                </div>
              </>
            )}
            <div className="document-card__detail">
              <dt>Sync state</dt>
              <dd>{syncState}</dd>
            </div>
            <div className="document-card__detail">
              <dt>Pages</dt>
              <dd>{record.pageCount}</dd>
            </div>
            <div className="document-card__detail">
              <dt>Created</dt>
              <dd>{formatDate(record.createdAt)}</dd>
            </div>
            <div className="document-card__detail">
              <dt>Modified</dt>
              <dd>{formatDate(record.modifiedAt)}</dd>
            </div>
            <div className="document-card__detail document-card__detail--id">
              <dt>Document ID</dt>
              <dd title={record.id}>{record.id}</dd>
            </div>
          </dl>
        )}
      </div>

      {/* Details toggle (full mode only) — sibling of actions so it stays visible */}
      {showDetails && (
        <button
          type="button"
          className="document-card__expand"
          aria-expanded={isExpanded}
          title={isExpanded ? 'Hide details' : 'Show details'}
          onClick={(e) => {
            e.stopPropagation();
            setIsExpanded((v) => !v);
          }}
        >
          <ChevronDown
            className={`document-card__chevron ${isExpanded ? 'document-card__chevron--open' : ''}`}
            size={16}
            aria-hidden="true"
          />
        </button>
      )}

      {/* Actions */}
      <div className="document-card__actions">
        {onPublishToTeam && (
          <button
            className="document-card__action document-card__action--publish"
            onClick={handlePublish}
            disabled={isPublishing}
            title="Move to relay"
            aria-label="Move to relay"
          >
            {isPublishing ? (
              <Loader2 className="document-card__spin" size={16} aria-hidden="true" />
            ) : (
              <Upload size={16} aria-hidden="true" />
            )}
          </button>
        )}
        {onMoveToPersonal && (
          <button
            className="document-card__action document-card__action--move-personal"
            onClick={handleMoveToPersonal}
            disabled={isMovingToPersonal}
            title="Move to personal"
            aria-label="Move to personal"
          >
            {isMovingToPersonal ? (
              <Loader2 className="document-card__spin" size={16} aria-hidden="true" />
            ) : (
              <Download size={16} aria-hidden="true" />
            )}
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
            aria-label="Manage access"
          >
            <Users size={16} aria-hidden="true" />
          </button>
        )}
        {onAssignCollection && (
          <div className="document-card__collection-wrap" ref={collMenuRef}>
            <button
              className="document-card__action"
              onClick={(e) => {
                e.stopPropagation();
                setCollMenuOpen((o) => !o);
              }}
              title="Move to collection"
              aria-label="Move to collection"
              aria-haspopup="menu"
              aria-expanded={collMenuOpen}
            >
              <FolderInput size={16} aria-hidden="true" />
            </button>
            {collMenuOpen && (
              <div
                className="document-card__collection-menu"
                role="menu"
                onClick={(e) => e.stopPropagation()}
              >
                {(collections ?? []).map((c) => (
                  <button
                    key={c.id}
                    className="document-card__collection-item"
                    role="menuitem"
                    onClick={() => {
                      onAssignCollection(record.id, c.id);
                      setCollMenuOpen(false);
                    }}
                  >
                    <span
                      className="document-card__collection-swatch"
                      style={c.color ? { background: c.color } : undefined}
                    />
                    <span className="document-card__collection-name">{c.name}</span>
                    {currentCollectionId === c.id && <Check size={14} aria-hidden="true" />}
                  </button>
                ))}
                {currentCollectionId && (
                  <button
                    className="document-card__collection-item"
                    role="menuitem"
                    onClick={() => {
                      onAssignCollection(record.id, null);
                      setCollMenuOpen(false);
                    }}
                  >
                    Remove from collection
                  </button>
                )}
                {onCreateCollectionFor && (
                  <button
                    className="document-card__collection-item document-card__collection-item--new"
                    role="menuitem"
                    onClick={() => {
                      onCreateCollectionFor(record.id);
                      setCollMenuOpen(false);
                    }}
                  >
                    + New collection…
                  </button>
                )}
              </div>
            )}
          </div>
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
            aria-label="Rename"
          >
            <Pencil size={16} aria-hidden="true" />
          </button>
        )}
        {onDelete && !showDeleteConfirm && (
          <button
            className="document-card__action document-card__action--danger"
            onClick={handleDeleteClick}
            title="Delete"
            aria-label="Delete"
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
        {showDeleteConfirm && (
          <div className="document-card__confirm" onClick={(e) => e.stopPropagation()}>
            <span className="document-card__confirm-text">Delete?</span>
            <button
              className="document-card__confirm-btn document-card__confirm-yes"
              onClick={handleDeleteConfirm}
              title="Move to Trash (recoverable)"
            >
              Trash
            </button>
            {onPermanentDelete && (
              <button
                className="document-card__confirm-btn document-card__confirm-forever"
                onClick={handlePermanentDeleteConfirm}
                title="Delete permanently — bypasses the Trash"
              >
                Forever
              </button>
            )}
            <button className="document-card__confirm-btn document-card__confirm-no" onClick={handleDeleteCancel}>
              Cancel
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Memoized so an action on one card (e.g. an in-flight "make available offline"
 * progress tick) re-renders only that card, not the whole list. Relies on the
 * browser passing referentially-stable props — notably a stable `collectionAccent`
 * and per-doc offline status/progress (JP-281).
 */
export const DocumentCard = memo(DocumentCardImpl);

export default DocumentCard;
