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
  History,
  Loader2,
  MoreVertical,
  Network,
  Pencil,
  Tags,
  Trash2,
  Upload,
  Users,
} from 'lucide-react';
import { SyncStatusBadge, type ExtendedSyncState } from './SyncStatusBadge';
import { isForeignRelayDoc, isSyncedDocument, type DocumentRecord, type Permission } from '../types/DocumentRegistry';
import type { Collection } from '../store/collectionStore';
import type { OfflineProgress, OfflineStatus } from '../store/offlineAvailability';
import { useConnectionStore } from '../store/connectionStore';
import {
  DropdownMenu,
  menuAction,
  MENU_SEPARATOR,
  type DropdownMenuEntry,
} from './components/DropdownMenu';
import { confirmDialog } from './confirm/confirmStore';
import { formatFileSize } from '../utils/byteSize';
import { PeopleStack } from './home/PeopleStack';
import { DocumentPreview, useDocumentPreview } from './home/DocumentPreview';
import { usePersonName, UNKNOWN_PERSON } from '../store/workspaceDirectoryStore';
import { TagChips } from './TagChips';
import { TagEditorPopover } from './TagEditorPopover';
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
  /** Callback to open the document's backups/recovery drawer (JP-183). */
  onViewBackups?: ((id: string) => void) | undefined;
  /** Callback to publish local document to relay */
  onPublishToRelay?: ((id: string) => void | Promise<void>) | undefined;
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
  /** Persist this doc's tags (JP-388). Enables the "Edit tags…" action. */
  onSetTags?: ((id: string, tags: string[]) => void | Promise<void>) | undefined;
  /** Click a tag chip to filter by it (the browser fills `#tag` into search). */
  onTagClick?: ((tag: string) => void) | undefined;
  /** Union of tags across the library — suggestions for the tag editor. */
  tagSuggestions?: string[] | undefined;
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

export function formatDate(timestamp: number): string {
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
      return 'Cloud';
    case 'cached':
      return 'Offline';
    // Unreachable from the browser (external records are filtered out of
    // listings), but the type system rightly demands the case exist.
    case 'external':
      return 'Shared';
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
    case 'external':
      return <Cloud size={12} aria-hidden="true" />;
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
    // A guest snapshot never syncs; 'local' renders as the no-sync state.
    case 'external':
      return 'local';
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
    // JP-458: the relay filters its listing to documents you may read, so this
    // normally can't render. It survives on a stale cached entry whose share
    // was revoked — say so plainly rather than implying view access.
    case 'none':
      return 'No access';
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

/**
 * A collection may hold a document only when their scopes match: a local
 * (personal) document → local collections; a workspace document (remote or
 * cached-offline) → workspace collections. Mirrors `docScopeOf` in collectionSync
 * so the menu only offers collections the assign guard will actually accept.
 */
function collectionMatchesDocScope(c: Collection, record: DocumentRecord): boolean {
  const docScope = record.type === 'local' ? 'local' : 'workspace';
  const colScope = c.scope === 'workspace' ? 'workspace' : 'local';
  return docScope === colScope;
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
  onViewBackups,
  onPublishToRelay,
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
  onSetTags,
  onTagClick,
  tagSuggestions,
  mode = 'compact',
}: DocumentCardProps) {
  // JP-459: resolve the last editor to a person. Returns '' when we can't —
  // the tooltip is then omitted rather than showing a raw account id.
  const lastEditedByRaw = usePersonName(
    isSyncedDocument(record) ? record.lastModifiedBy : undefined,
    isSyncedDocument(record) ? record.lastModifiedByName : undefined,
  );
  const lastEditedBy = lastEditedByRaw === UNKNOWN_PERSON ? '' : lastEditedByRaw;

  const [isEditing, setIsEditing] = useState(false);
  const [editName, setEditName] = useState(record.name);
  const [isPublishing, setIsPublishing] = useState(false);
  const [isMovingToPersonal, setIsMovingToPersonal] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  // Overflow menu open state — pins the hover-revealed actions row visible
  // while the (portaled) menu is open, since the pointer leaves the card.
  const [menuOpen, setMenuOpen] = useState(false);
  // Anchor (viewport rect) for the tag editor popover; null = closed (JP-388).
  const [tagEditorAnchor, setTagEditorAnchor] = useState<{
    top: number;
    bottom: number;
    left: number;
    right: number;
  } | null>(null);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // Grid cards lead with a thumbnail (JP-477); every other mode skips the work.
  const gridPreview = useDocumentPreview(record, mode === 'grid');

  // Sync editName when record.name changes externally
  useEffect(() => {
    if (!isEditing) {
      setEditName(record.name);
    }
  }, [record.name, isEditing]);

  const handlePublish = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!onPublishToRelay) return;
    setIsPublishing(true);
    try {
      await onPublishToRelay(record.id);
    } finally {
      setIsPublishing(false);
    }
  }, [onPublishToRelay, record.id]);

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

  /**
   * Select mode: the browser already has a selection, so the surface is being
   * used to pick documents rather than to open one. Driven by the same flag
   * that reveals the checkboxes, so what the card looks like and what a click
   * does can't disagree.
   */
  const selectMode = showSelectionCheckbox;

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
      // Once a selection exists, the browser is IN select mode and a plain
      // click extends that selection instead of opening (JP-480). Opening
      // navigates away from the surface, which threw the whole selection away —
      // so the click that costs the most was the easiest one to make. Every
      // file manager behaves this way; clear the selection to open again.
      if (selectMode && onSelectToggle) {
        e.preventDefault();
        onSelectToggle(record.id, { shift: false, meta: true });
        return;
      }
      if (onOpen) {
        onOpen(record.id);
      }
    },
    [isEditing, onOpen, onSelectToggle, record.id, selectMode]
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

  // The always-visible row/card Trash button is one misclick from trashing a
  // doc (JP-444) — guard it with a confirm. Remote docs skip the local confirm
  // because the model already shows its shared-impact dialog (don't stack
  // two); the overflow menu's "Move to Trash" stays one-step, since opening
  // the menu is already a deliberate second click.
  const handleTrashClick = useCallback(
    (e: React.MouseEvent) => {
      e.stopPropagation();
      if (!onDelete) return;
      void (async () => {
        if (record.type !== 'remote') {
          const ok = await confirmDialog({
            title: `Move “${record.name}” to Trash?`,
            message: 'You can restore it from the Trash later.',
            confirmLabel: 'Move to Trash',
          });
          if (!ok) return;
        }
        void onDelete(record.id);
      })();
    },
    [onDelete, record.id, record.name, record.type],
  );

  // Permanent delete bypasses the Trash — always behind a styled danger
  // confirm, matching the bulk-delete dialog in the browser model.
  const handlePermanentDelete = useCallback(async () => {
    if (!onPermanentDelete) return;
    const ok = await confirmDialog({
      title: `Delete “${record.name}” permanently?`,
      message: 'This bypasses the Trash and cannot be undone.',
      confirmLabel: 'Delete permanently',
      danger: true,
    });
    if (ok) void onPermanentDelete(record.id);
  }, [onPermanentDelete, record.id, record.name]);

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

  // Overflow ("kebab") menu — everything beyond the two visible quick actions
  // (contextual transfer + Trash). Entries are gated on the same optional
  // callbacks as before, so permission logic stays in the list renderer.
  const menuEntries: DropdownMenuEntry[] = [];
  if (onRename) {
    menuEntries.push(
      menuAction({
        id: 'rename',
        label: 'Rename',
        icon: <Pencil size={16} aria-hidden="true" />,
        onSelect: () => {
          setEditName(record.name);
          setIsEditing(true);
        },
      }),
    );
  }
  if (onAssignCollection) {
    const collectionEntries: DropdownMenuEntry[] = (collections ?? [])
      .filter((c) => collectionMatchesDocScope(c, record))
      .map((c) =>
        menuAction({
          id: `collection-${c.id}`,
          label: c.name,
          swatchColor: c.color ?? null,
          checked: currentCollectionId === c.id,
          onSelect: () => onAssignCollection(record.id, c.id),
        }),
      );
    if (currentCollectionId) {
      collectionEntries.push(
        menuAction({
          id: 'collection-remove',
          label: 'Remove from collection',
          onSelect: () => onAssignCollection(record.id, null),
        }),
      );
    }
    if (onCreateCollectionFor) {
      if (collectionEntries.length > 0) collectionEntries.push(MENU_SEPARATOR);
      collectionEntries.push(
        menuAction({
          id: 'collection-new',
          label: '+ New collection…',
          onSelect: () => onCreateCollectionFor(record.id),
        }),
      );
    }
    menuEntries.push({
      kind: 'submenu',
      id: 'collection',
      label: 'Move to collection',
      icon: <FolderInput size={16} aria-hidden="true" />,
      entries: collectionEntries,
    });
  }
  if (onSetTags) {
    menuEntries.push(
      menuAction({
        id: 'tags',
        label: 'Edit tags…',
        icon: <Tags size={16} aria-hidden="true" />,
        onSelect: () => {
          const rect = cardRef.current?.getBoundingClientRect();
          if (rect) {
            setTagEditorAnchor({
              top: rect.top,
              bottom: rect.bottom,
              left: rect.left,
              right: rect.right,
            });
          }
        },
      }),
    );
  }
  if (onEditPermissions) {
    menuEntries.push(
      menuAction({
        id: 'permissions',
        label: 'Manage access',
        icon: <Users size={16} aria-hidden="true" />,
        onSelect: () => onEditPermissions(record.id),
      }),
    );
  }
  if (onViewBackups) {
    menuEntries.push(
      menuAction({
        id: 'backups',
        label: 'Version history',
        icon: <History size={16} aria-hidden="true" />,
        onSelect: () => onViewBackups(record.id),
      }),
    );
  }
  if (onDelete || onPermanentDelete) {
    if (menuEntries.length > 0) menuEntries.push(MENU_SEPARATOR);
    if (onDelete) {
      menuEntries.push(
        menuAction({
          id: 'trash',
          label: 'Move to Trash',
          icon: <Trash2 size={16} aria-hidden="true" />,
          onSelect: () => void onDelete(record.id),
        }),
      );
    }
    if (onPermanentDelete) {
      menuEntries.push(
        menuAction({
          id: 'delete-forever',
          label: 'Delete permanently…',
          danger: true,
          onSelect: () => void handlePermanentDelete(),
        }),
      );
    }
  }

  return (
    <div
      ref={cardRef}
      className={`document-card document-card--${mode} ${isActive ? 'document-card--active' : ''} ${isSelected ? 'document-card--selected' : ''} ${selectMode ? 'document-card--select-mode' : ''} ${menuOpen || tagEditorAnchor ? 'document-card--menu-open' : ''}`}
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
      {/* Grid cards lead with the document itself (JP-477). The same preview
          engine the "Continue working" strip uses — without it the grid was a
          strictly worse view of the same documents shown as thumbnails
          immediately above it. */}
      {mode === 'grid' && (
        <div className="document-card__preview">
          <DocumentPreview preview={gridPreview} />
        </div>
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

          {/* Sync status — relay-backed docs only. A local doc's sync state is
              always 'local', which just restates the "Personal" type badge, so
              it renders nothing extra. The connection/offline state lives here
              only — a separate relay badge would duplicate it and leak the
              relay host. */}
          {record.type !== 'local' && <SyncStatusBadge state={syncState} size="small" showLabel />}

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

          {/* Restored copy (JP-481) — provenance, not part of the name. The
              chip says WHAT it is; the tooltip says which point in time the
              content came from, which is the detail that used to be jammed
              into the document's title. */}
          {record.restoredFrom !== undefined && (
            <span
              className="document-card__restored"
              title={`Restored from a version saved ${formatDate(record.restoredFrom)}`}
            >
              <History size={11} aria-hidden="true" />
              Restored
            </span>
          )}

          {/* Tags (JP-388) — deterministic-color chips; clicking one filters
              the browser (`#tag` search). */}
          {record.tags && record.tags.length > 0 && (
            <TagChips tags={record.tags} onTagClick={onTagClick} />
          )}

          {/* Modified time — hidden in full/list mode, where it lives in its
              own column cell instead (JP-444). */}
          <span className="document-card__date">{formatDate(record.modifiedAt)}</span>
        </div>

        {/* Grid-card foot (JP-444): people + size in the kit's mono style. */}
        {mode === 'grid' && (
          <div className="document-card__grid-foot">
            <PeopleStack
              record={record}
              onOpenAccess={onEditPermissions ? () => onEditPermissions(record.id) : undefined}
            />
            {typeof record.sizeBytes === 'number' && (
              <span className="document-card__grid-size">{formatFileSize(record.sizeBytes)}</span>
            )}
          </div>
        )}

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
            {typeof record.sizeBytes === 'number' && (
              /* JP-443: the doc's metered size — makes "move the big one to
                 personal / delete it to free space" actionable at a glance. */
              <div className="document-card__detail">
                <dt>Size</dt>
                <dd>{formatFileSize(record.sizeBytes)}</dd>
              </div>
            )}
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

      {/* Table cells (JP-444, full/list mode only): last-edited, people, size.
          Widths come from the shared --dh-col-* tracks so every row lines up
          under the DocumentsHome column header. */}
      {mode === 'full' && (
        <>
          <span
            className="document-card__cell document-card__cell--time"
            title={
              // JP-459: `lastModifiedByName` is an account UUID on every record
              // written before names were resolved at display time. Resolve it,
              // and say nothing rather than show an id we can't turn into a
              // person.
              lastEditedBy ? `Last edited by ${lastEditedBy}` : undefined
            }
          >
            {formatDate(record.modifiedAt)}
          </span>
          <span className="document-card__cell document-card__cell--people">
            <PeopleStack
              record={record}
              onOpenAccess={onEditPermissions ? () => onEditPermissions(record.id) : undefined}
            />
          </span>
          <span className="document-card__cell document-card__cell--size">
            {typeof record.sizeBytes === 'number' ? formatFileSize(record.sizeBytes) : '—'}
          </span>
        </>
      )}

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
        {onPublishToRelay && (
          <button
            className="document-card__action document-card__action--publish"
            onClick={handlePublish}
            disabled={isPublishing}
            title="Move to Cloud"
            aria-label="Move to Cloud"
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
        {onDelete && (
          <button
            className="document-card__action document-card__action--danger"
            onClick={handleTrashClick}
            title="Move to Trash"
            aria-label="Move to Trash"
          >
            <Trash2 size={16} aria-hidden="true" />
          </button>
        )}
        {menuEntries.length > 0 && (
          <DropdownMenu
            trigger={<MoreVertical size={16} aria-hidden="true" />}
            triggerClassName="document-card__action"
            triggerTitle="More actions"
            entries={menuEntries}
            align="right"
            onOpenChange={setMenuOpen}
          />
        )}
      </div>

      {/* Tag editor (JP-388) — anchored to the card, opened from the overflow menu. */}
      {tagEditorAnchor && onSetTags && (
        <TagEditorPopover
          tags={record.tags ?? []}
          suggestions={tagSuggestions ?? []}
          anchor={tagEditorAnchor}
          onCommit={(next) => void onSetTags(record.id, next)}
          onClose={() => setTagEditorAnchor(null)}
        />
      )}
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
