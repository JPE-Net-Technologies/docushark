/**
 * Document Registry Type Definitions
 *
 * Defines the discriminated union types for local, remote, and cached documents.
 * These types provide clear boundaries between document ownership and sync state.
 *
 * Phase 14.1 Collaboration Overhaul
 */

import type { DocumentMetadata, DiagramDocument } from './Document';

// ============ Permission Types ============

/** Document permission levels */
export type Permission = 'owner' | 'editor' | 'viewer';

/** Permission entry for a shared user */
export interface PermissionEntry {
  userId: string;
  username: string;
  permission: Permission;
  sharedAt: number;
}

/** Document permissions structure */
export interface DocumentPermissions {
  ownerId: string;
  ownerName: string;
  sharedWith: PermissionEntry[];
  /** Default permission for "anyone with link" - null means no default access */
  defaultPermission: Permission | null;
}

// ============ Sync State Types ============

/** Synchronization state for remote documents */
export type SyncState =
  | 'synced'    // Up to date with host
  | 'syncing'   // Currently syncing
  | 'pending'   // Local changes waiting to sync
  | 'error';    // Sync failed

// ============ Document Record Types ============

/** Base fields shared by all document record types */
export interface DocumentEntryBase {
  id: string;
  name: string;
  pageCount: number;
  createdAt: number;
  modifiedAt: number;
}

/**
 * Local Document - Personal, stored only in browser localStorage.
 * Never synced to any host. Full ownership by local user.
 */
export interface LocalDocument extends DocumentEntryBase {
  type: 'local';
}

/**
 * Remote Document - Relay-backed document; source of truth on the relay.
 * Synced via CRDT in real-time when connected.
 */
export interface RemoteDocument extends DocumentEntryBase {
  type: 'remote';
  /** Host identifier (address:port) this document belongs to */
  relayId: string;
  /**
   * Workspace this document belongs to (JP-370). The scope key for the doc
   * browser — two workspaces can share one relay host, so listing/clearing by
   * `relayId` alone would mix them. `relayId` is retained for JP-117 save-routing
   * (which relay holds the doc); `workspaceId` is who can see it in the browser.
   */
  workspaceId: string;
  /** User ID of document owner */
  ownerId: string;
  /** Owner's display name */
  ownerName: string;
  /** Current user's permission level */
  permission: Permission;
  /** Current sync state */
  syncState: SyncState;
  /** Timestamp of last successful sync */
  lastSyncedAt: number;
}

/**
 * Cached Document - Offline snapshot of a remote document.
 * Editable offline, changes queued for later sync.
 * Automatically promoted to RemoteDocument when host reconnects.
 */
export interface CachedDocument extends DocumentEntryBase {
  type: 'cached';
  /** Host identifier this document belongs to */
  relayId: string;
  /** Workspace this document belongs to (JP-370) — see RemoteDocument.workspaceId. */
  workspaceId: string;
  /** Original remote document ID this is a cache of */
  originalDocId: string;
  /** Timestamp when document was cached */
  cachedAt: number;
  /** Number of queued changes waiting to sync */
  pendingChanges: number;
  /** Permission level (preserved from when online) */
  permission: Permission;
}

/** Discriminated union of all document record types */
export type DocumentRecord = LocalDocument | RemoteDocument | CachedDocument;

// ============ Registry Types ============

/** Document registry entry - combines record metadata with optional full document */
export interface DocumentRegistryEntry {
  record: DocumentRecord;
  /** Full document content (loaded on demand) */
  document?: DiagramDocument;
  /** Loading state for document content */
  isLoading: boolean;
  /** Error message if load failed */
  loadError?: string;
}

/** The complete document registry state */
export interface DocumentRegistryState {
  /** All documents indexed by ID */
  entries: Record<string, DocumentRegistryEntry>;
  /** Currently active document ID */
  activeDocumentId: string | null;
  /** Filter for document list display */
  filter: DocumentFilter;
}

/** Filter options for document list */
export interface DocumentFilter {
  /** Show documents of these types */
  types: ('local' | 'remote' | 'cached')[];
  /** Filter by host ID (for remote/cached only) */
  relayId?: string;
  /** Search query for document name */
  searchQuery?: string;
}

// ============ Type Guards ============

/** Check if a document record is a local document */
export function isLocalDocument(record: DocumentRecord): record is LocalDocument {
  return record.type === 'local';
}

/** Check if a document record is a remote document */
export function isRemoteDocument(record: DocumentRecord): record is RemoteDocument {
  return record.type === 'remote';
}

/** Check if a document record is a cached document */
export function isCachedDocument(record: DocumentRecord): record is CachedDocument {
  return record.type === 'cached';
}

/** Check if a document record is synced (either remote or cached) */
export function isSyncedDocument(record: DocumentRecord): record is RemoteDocument | CachedDocument {
  return record.type === 'remote' || record.type === 'cached';
}

/**
 * Whether `record` belongs to a relay *other than the one we're currently
 * connected to* (JP-308). True only for a relay-backed doc with a known origin
 * relay (`relayId` ≠ `'unknown'`) while we ARE connected to some relay
 * (`connectedRelayAddress` set) whose address differs from the doc's.
 *
 * This is the single discriminant for "from another workspace": it gates both
 * the UI badge (`DocumentCard`) and the strand/demote guard
 * (`collaborationStore.onError`), so a doc that's merely on a different relay is
 * never mistaken for a deleted one. A doc on our connected relay, a local doc,
 * an unknown-origin doc, or being offline entirely all return false (each is a
 * different state the existing sync/offline badges already cover).
 */
export function isForeignRelayDoc(
  record: DocumentRecord,
  connectedRelayAddress: string | undefined,
): boolean {
  if (record.type !== 'remote' && record.type !== 'cached') return false;
  if (!connectedRelayAddress) return false;
  if (record.relayId === 'unknown') return false;
  return record.relayId !== connectedRelayAddress;
}

// ============ Conversion Helpers ============

/**
 * Convert DocumentMetadata to LocalDocument record.
 */
export function toLocalDocument(metadata: DocumentMetadata): LocalDocument {
  return {
    type: 'local',
    id: metadata.id,
    name: metadata.name,
    pageCount: metadata.pageCount,
    createdAt: metadata.createdAt,
    modifiedAt: metadata.modifiedAt,
  };
}

/**
 * Convert DocumentMetadata to RemoteDocument record.
 */
export function toRemoteDocument(
  metadata: DocumentMetadata,
  relayId: string,
  workspaceId: string,
  permission: Permission,
  syncState: SyncState = 'synced'
): RemoteDocument {
  return {
    type: 'remote',
    id: metadata.id,
    name: metadata.name,
    pageCount: metadata.pageCount,
    createdAt: metadata.createdAt,
    modifiedAt: metadata.modifiedAt,
    relayId,
    workspaceId,
    ownerId: metadata.ownerId ?? '',
    ownerName: metadata.ownerName ?? '',
    permission,
    syncState,
    lastSyncedAt: Date.now(),
  };
}

/**
 * Convert RemoteDocument to CachedDocument (for offline mode).
 */
export function toCachedDocument(remote: RemoteDocument): CachedDocument {
  return {
    type: 'cached',
    id: remote.id,
    name: remote.name,
    pageCount: remote.pageCount,
    createdAt: remote.createdAt,
    modifiedAt: remote.modifiedAt,
    relayId: remote.relayId,
    workspaceId: remote.workspaceId,
    originalDocId: remote.id,
    cachedAt: Date.now(),
    pendingChanges: 0,
    permission: remote.permission,
  };
}

/**
 * Promote CachedDocument back to RemoteDocument (when reconnected).
 */
export function toRemoteFromCached(cached: CachedDocument, syncState: SyncState = 'syncing'): RemoteDocument {
  return {
    type: 'remote',
    id: cached.originalDocId,
    name: cached.name,
    pageCount: cached.pageCount,
    createdAt: cached.createdAt,
    modifiedAt: cached.modifiedAt,
    relayId: cached.relayId,
    workspaceId: cached.workspaceId,
    ownerId: '', // Will be populated from host
    ownerName: '',
    permission: cached.permission,
    syncState,
    lastSyncedAt: cached.cachedAt,
  };
}

/**
 * Get display label for document type.
 */
export function getDocumentTypeLabel(record: DocumentRecord): string {
  switch (record.type) {
    case 'local':
      return 'Personal';
    case 'remote':
      return 'Relay';
    case 'cached':
      return 'Offline';
  }
}

/**
 * Get sync state display info.
 */
export function getSyncStateInfo(record: DocumentRecord): { label: string; icon: string } {
  if (record.type === 'local') {
    return { label: 'Local only', icon: 'laptop' };
  }

  if (record.type === 'cached') {
    if (record.pendingChanges > 0) {
      return { label: `${record.pendingChanges} pending`, icon: 'clock' };
    }
    return { label: 'Cached', icon: 'cloud-off' };
  }

  // Remote document
  switch (record.syncState) {
    case 'synced':
      return { label: 'Synced', icon: 'check' };
    case 'syncing':
      return { label: 'Syncing...', icon: 'refresh-cw' };
    case 'pending':
      return { label: 'Pending', icon: 'clock' };
    case 'error':
      return { label: 'Sync error', icon: 'alert-triangle' };
  }
}
