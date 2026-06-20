/**
 * Storage Settings component for the Settings modal.
 *
 * Embedded version of StorageManager for managing IndexedDB blob storage.
 *
 * Features:
 * - Display storage usage statistics
 * - List all stored blobs (Images tab)
 * - List and manage icons (Icons tab)
 * - Identify orphaned blobs
 * - Run garbage collection
 * - Delete individual blobs
 * - Upload custom icons
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { blobStorage } from '../../storage/BlobStorage';
import { getTrashItems } from '../../storage/TrashStorage';
import { BlobGarbageCollector } from '../../storage/BlobGarbageCollector';
import type { BlobMetadata, StorageStats, GCStats } from '../../storage/BlobTypes';
import { useIconLibraryStore, initializeIconLibrary } from '../../store/iconLibraryStore';
import type { IconMetadata } from '../../storage/IconTypes';
import { formatFileSize } from '../../utils/imageUtils';
import { usePersistenceStore, loadDocumentFromStorage } from '../../store/persistenceStore';
import { extractRichTextBlobIds, extractShapeBlobIds } from '../../utils/richTextBlobExtractor';
import { useDocumentRegistry } from '../../store/documentRegistry';
import { isRemoteDocument, type DocumentRecord } from '../../types/DocumentRegistry';
import { SyncStatusBadge, type ExtendedSyncState } from '../SyncStatusBadge';
import './StorageSettings.css';

type TabId = 'images' | 'icons';

/** A blob's owning documents + the sync state derived from them (JP-212). */
interface BlobOwnership {
  owners: { id: string; name: string }[];
  /** Trashed documents that reference this blob (JP-293). */
  trashedOwners: { id: string; name: string }[];
  sync: ExtendedSyncState;
}

/**
 * Derive a blob's sync state from the documents that reference it (JP-212): a
 * blob is "synced" (pushed to the relay) when any owning doc is a synced relay
 * document; "local" when only personal docs own it. A non-synced relay state
 * surfaces an asset still in flight.
 */
function deriveBlobSyncState(owners: DocumentRecord[]): ExtendedSyncState {
  const remoteStates = owners.filter(isRemoteDocument).map((r) => r.syncState);
  if (remoteStates.length === 0) return 'local';
  if (remoteStates.includes('synced')) return 'synced';
  if (remoteStates.includes('error')) return 'error';
  if (remoteStates.includes('syncing')) return 'syncing';
  if (remoteStates.includes('pending')) return 'pending';
  return 'synced';
}

export function StorageSettings() {
  const [activeTab, setActiveTab] = useState<TabId>('images');
  const [blobs, setBlobs] = useState<BlobMetadata[]>([]);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [orphanedBlobs, setOrphanedBlobs] = useState<BlobMetadata[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCollecting, setIsCollecting] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [gcResult, setGcResult] = useState<GCStats | null>(null);
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);
  // JP-212: per-blob owning documents + derived sync state.
  const [ownership, setOwnership] = useState<Record<string, BlobOwnership>>({});

  // Icon state
  const [icons, setIcons] = useState<IconMetadata[]>([]);
  const [iconPreviews, setIconPreviews] = useState<Record<string, string>>({});
  const [isLoadingIcons, setIsLoadingIcons] = useState(true);
  const [isUploadingIcon, setIsUploadingIcon] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const getDocumentList = usePersistenceStore((state) => state.getDocumentList);

  const {
    getAllIcons,
    loadIconData,
    uploadIcon,
    deleteIcon,
  } = useIconLibraryStore();

  const loadBlobData = async () => {
    setIsLoading(true);
    try {
      const gc = new BlobGarbageCollector(blobStorage);
      const [blobList, storageStats, orphaned] = await Promise.all([
        blobStorage.listAllBlobs(),
        blobStorage.getStorageStats(),
        gc.getOrphanedBlobs(),
      ]);

      setBlobs(blobList.sort((a, b) => b.createdAt - a.createdAt));
      setStats(storageStats);
      const safeOrphans = orphaned.filter((b) => b.usageCount === 0);
      setOrphanedBlobs(safeOrphans);

      // JP-212: map each blob to the documents that reference it, then derive a
      // per-blob sync state from those docs' registry records. Scans the same
      // locally-loadable docs the usage count is built from.
      const registry = useDocumentRegistry.getState();
      const owners: Record<string, { id: string; name: string }[]> = {};
      for (const docMeta of getDocumentList()) {
        const doc = loadDocumentFromStorage(docMeta.id);
        if (!doc) continue;
        const ids = new Set([
          ...extractRichTextBlobIds(doc.richTextContent),
          ...extractShapeBlobIds(doc.pages ?? {}),
        ]);
        for (const blobId of ids) {
          (owners[blobId] ??= []).push({ id: docMeta.id, name: docMeta.name });
        }
      }

      // JP-293: blobs are also kept alive by *trashed* documents. Tag those so
      // the UI can show a blob is only reachable through the Trash (and would be
      // freed by emptying it). Trash items carry a snapshotted blobReferences list.
      const trashedOwners: Record<string, { id: string; name: string }[]> = {};
      for (const item of getTrashItems()) {
        for (const blobId of item.blobReferences ?? []) {
          (trashedOwners[blobId] ??= []).push({ id: item.id, name: item.name });
        }
      }

      const info: Record<string, BlobOwnership> = {};
      for (const blobId of new Set([...Object.keys(owners), ...Object.keys(trashedOwners)])) {
        const docs = owners[blobId] ?? [];
        const records = docs
          .map((d) => registry.getRecord(d.id))
          .filter((r): r is DocumentRecord => Boolean(r));
        info[blobId] = {
          owners: docs,
          trashedOwners: trashedOwners[blobId] ?? [],
          sync: deriveBlobSyncState(records),
        };
      }
      setOwnership(info);
    } catch (error) {
      console.error('Failed to load storage data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadIconData2 = useCallback(async () => {
    setIsLoadingIcons(true);
    try {
      await initializeIconLibrary();
      const allIcons = getAllIcons();
      setIcons(allIcons);

      const previews: Record<string, string> = {};
      for (const icon of allIcons) {
        try {
          const iconData = await loadIconData(icon.id);
          if (iconData) {
            previews[icon.id] = iconData.dataUrl;
          }
        } catch {
          // Skip failed previews
        }
      }
      setIconPreviews(previews);
    } catch (error) {
      console.error('Failed to load icons:', error);
    } finally {
      setIsLoadingIcons(false);
    }
  }, [getAllIcons, loadIconData]);

  useEffect(() => {
    loadBlobData();
    loadIconData2();
  }, [loadIconData2]);

  const handleCleanupClick = () => {
    if (orphanedBlobs.length === 0) return;
    setShowCleanupConfirm(true);
  };

  const handleConfirmCleanup = async () => {
    setShowCleanupConfirm(false);
    setIsCollecting(true);
    setGcResult(null);

    try {
      let bytesFreed = 0;
      let blobsDeleted = 0;

      for (const blob of orphanedBlobs) {
        try {
          await blobStorage.deleteBlob(blob.id);
          bytesFreed += blob.size;
          blobsDeleted++;
        } catch (error) {
          console.error('Failed to delete blob:', blob.id, error);
        }
      }

      setGcResult({
        blobsDeleted,
        bytesFreed,
        durationMs: 0,
      });

      await loadBlobData();
      setTimeout(() => setGcResult(null), 5000);
    } catch (error) {
      console.error('Cleanup failed:', error);
      alert('Cleanup failed. See console for details.');
    } finally {
      setIsCollecting(false);
    }
  };

  const handleRecalculateUsage = async () => {
    setIsRecalculating(true);
    try {
      const allBlobs = await blobStorage.listAllBlobs();
      const usageCounts: Record<string, number> = {};
      for (const blob of allBlobs) {
        usageCounts[blob.id] = 0;
      }

      const documents = getDocumentList();
      for (const docMeta of documents) {
        try {
          const doc = loadDocumentFromStorage(docMeta.id);
          if (doc) {
            const richTextBlobs = extractRichTextBlobIds(doc.richTextContent);
            const shapeBlobs = extractShapeBlobIds(doc.pages ?? {});
            const allBlobIds = [...richTextBlobs, ...shapeBlobs];
            for (const blobId of allBlobIds) {
              if (usageCounts[blobId] !== undefined) {
                usageCounts[blobId]++;
              }
            }
          }
        } catch (error) {
          console.error('Failed to scan document:', docMeta.id, error);
        }
      }

      for (const [blobId, count] of Object.entries(usageCounts)) {
        await blobStorage.setUsageCount(blobId, count);
      }

      await loadBlobData();
    } catch (error) {
      console.error('Recalculate failed:', error);
      alert('Failed to recalculate usage counts. See console for details.');
    } finally {
      setIsRecalculating(false);
    }
  };

  const handleDeleteBlob = async (blobId: string, name: string) => {
    const confirmed = confirm(
      `Delete blob "${name}"?\n\nWARNING: This will break any documents that reference this image.`
    );
    if (!confirmed) return;

    try {
      await blobStorage.deleteBlob(blobId);
      await loadBlobData();
    } catch (error) {
      console.error('Failed to delete blob:', error);
      alert('Failed to delete blob. See console for details.');
    }
  };

  const handleDeleteIcon = async (iconId: string, name: string) => {
    const confirmed = confirm(
      `Delete icon "${name}"?\n\nWARNING: This will remove the icon from shapes that use it.`
    );
    if (!confirmed) return;

    try {
      await deleteIcon(iconId);
      await loadIconData2();
    } catch (error) {
      console.error('Failed to delete icon:', error);
      alert('Failed to delete icon. See console for details.');
    }
  };

  const handleUploadIconClick = () => {
    fileInputRef.current?.click();
  };

  const handleIconFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    e.target.value = '';

    if (!file.type.includes('svg')) {
      alert('Please select an SVG file.');
      return;
    }

    setIsUploadingIcon(true);

    try {
      const result = await uploadIcon(file, file.name);
      if (!result.success) {
        alert(result.error || 'Failed to upload icon');
        return;
      }
      await loadIconData2();
    } catch (error) {
      console.error('Failed to upload icon:', error);
      alert('Failed to upload icon. See console for details.');
    } finally {
      setIsUploadingIcon(false);
    }
  };

  const formatDate = (timestamp: number) => {
    return new Date(timestamp).toLocaleString();
  };

  const customIconCount = icons.filter((i) => i.type === 'custom').length;
  const builtinIconCount = icons.filter((i) => i.type === 'builtin').length;

  return (
    <div className="storage-settings">
      <h3 className="settings-section-title">Storage Management</h3>

      {/* Tabs */}
      <div className="storage-tabs">
        <button
          className={`storage-tab ${activeTab === 'images' ? 'active' : ''}`}
          onClick={() => setActiveTab('images')}
        >
          Images ({blobs.length})
        </button>
        <button
          className={`storage-tab ${activeTab === 'icons' ? 'active' : ''}`}
          onClick={() => setActiveTab('icons')}
        >
          Icons ({icons.length})
        </button>
      </div>

      {/* Images Tab */}
      {activeTab === 'images' && (
        <>
          {/* Storage stats */}
          {stats && (
            <div className="storage-stats">
              <div className="storage-stat-item">
                <span className="storage-stat-label">Used:</span>
                <span className="storage-stat-value">{formatFileSize(stats.used)}</span>
              </div>
              <div className="storage-stat-item">
                <span className="storage-stat-label">Available:</span>
                <span className="storage-stat-value">{formatFileSize(stats.available)}</span>
              </div>
              <div className="storage-stat-item">
                <span className="storage-stat-label">Usage:</span>
                <span className="storage-stat-value">{stats.percentUsed.toFixed(1)}%</span>
              </div>
              {orphanedBlobs.length > 0 && (
                <div className="storage-stat-item storage-stat-warning">
                  <span className="storage-stat-label">Orphaned:</span>
                  <span className="storage-stat-value">{orphanedBlobs.length}</span>
                </div>
              )}
            </div>
          )}

          {/* Progress bar */}
          {stats && (
            <div className="storage-progress">
              <div
                className="storage-progress-bar"
                style={{ width: `${Math.min(100, stats.percentUsed)}%` }}
              />
            </div>
          )}

          {/* Actions */}
          <div className="storage-actions">
            <button
              className="storage-btn"
              onClick={handleRecalculateUsage}
              disabled={isRecalculating || isLoading}
            >
              {isRecalculating ? 'Scanning...' : 'Recalculate Usage'}
            </button>
            <button
              className="storage-btn storage-btn-primary"
              onClick={handleCleanupClick}
              disabled={isCollecting || orphanedBlobs.length === 0}
            >
              {isCollecting ? 'Cleaning...' : `Clean Up${orphanedBlobs.length > 0 ? ` (${orphanedBlobs.length})` : ''}`}
            </button>
            {gcResult && (
              <span className="storage-gc-result">
                Freed {formatFileSize(gcResult.bytesFreed)} ({gcResult.blobsDeleted} blob
                {gcResult.blobsDeleted !== 1 ? 's' : ''})
              </span>
            )}
          </div>

          {/* Blob list */}
          <div className="storage-list-container">
            {isLoading ? (
              <div className="storage-empty">Loading...</div>
            ) : blobs.length === 0 ? (
              <div className="storage-empty">No images stored</div>
            ) : (
              <div className="storage-card-list">
                {blobs.map((blob) => {
                  const isIcon = blob.type === 'image/svg+xml';
                  const own = ownership[blob.id];
                  const owners = own?.owners ?? [];
                  const trashedOwners = own?.trashedOwners ?? [];
                  // Held alive only by the Trash → reclaimable by emptying it.
                  const trashOnly = owners.length === 0 && trashedOwners.length > 0;
                  return (
                    <div key={blob.id} className="storage-card">
                      <div className="storage-card__body">
                        <div className="storage-card__name-row">
                          <span className="storage-card__name" title={blob.name}>
                            {blob.name}
                          </span>
                          {isIcon && <span className="storage-icon-tag">Icon</span>}
                        </div>
                        <div className="storage-card__meta">
                          <span className="storage-card__type">{blob.type.replace('image/', '')}</span>
                          <span className="storage-card__sep" aria-hidden="true">·</span>
                          <span>{formatFileSize(blob.size)}</span>
                          <span className="storage-card__sep" aria-hidden="true">·</span>
                          <span title={formatDate(blob.createdAt)}>
                            {new Date(blob.createdAt).toLocaleDateString()}
                          </span>
                          <span className="storage-card__usage">
                            {blob.usageCount === 0 ? (
                              <span className={`storage-orphan-badge ${isIcon ? 'protected' : ''}`}>
                                {isIcon ? 'Protected' : 'Orphaned'}
                              </span>
                            ) : trashOnly ? (
                              <span
                                className="storage-orphan-badge storage-trash-badge"
                                title={`Only referenced from the Trash: ${trashedOwners
                                  .map((o) => o.name)
                                  .join(', ')}. Emptying the Trash frees this.`}
                              >
                                In Trash
                              </span>
                            ) : (
                              <span
                                className="storage-usage-cell"
                                title={
                                  owners.length
                                    ? `Used by: ${owners.map((o) => o.name).join(', ')}`
                                    : `${blob.usageCount} document(s)`
                                }
                              >
                                <SyncStatusBadge state={own?.sync ?? 'local'} size="small" />
                                <span className="storage-usage-docs">
                                  {owners.length === 1
                                    ? (owners[0]?.name ?? '1 doc')
                                    : `${blob.usageCount} docs`}
                                </span>
                              </span>
                            )}
                          </span>
                        </div>
                      </div>
                      <div className="storage-card__actions">
                        <button
                          className="storage-delete-btn"
                          onClick={() => handleDeleteBlob(blob.id, blob.name)}
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {/* Icons Tab */}
      {activeTab === 'icons' && (
        <>
          {/* Icon stats */}
          <div className="storage-stats">
            <div className="storage-stat-item">
              <span className="storage-stat-label">Built-in:</span>
              <span className="storage-stat-value">{builtinIconCount}</span>
            </div>
            <div className="storage-stat-item">
              <span className="storage-stat-label">Custom:</span>
              <span className="storage-stat-value">{customIconCount}</span>
            </div>
          </div>

          {/* Upload button */}
          <div className="storage-actions">
            <button
              className="storage-btn storage-btn-primary"
              onClick={handleUploadIconClick}
              disabled={isUploadingIcon}
            >
              {isUploadingIcon ? 'Uploading...' : 'Upload SVG Icon'}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".svg,image/svg+xml"
              onChange={handleIconFileChange}
              style={{ display: 'none' }}
            />
          </div>

          {/* Icon grid */}
          <div className="storage-list-container">
            {isLoadingIcons ? (
              <div className="storage-empty">Loading...</div>
            ) : icons.length === 0 ? (
              <div className="storage-empty">No icons available</div>
            ) : (
              <div className="storage-icon-grid">
                {icons.map((icon) => (
                  <div key={icon.id} className="storage-icon-item">
                    <div className="storage-icon-preview" title={icon.name}>
                      {iconPreviews[icon.id] ? (
                        <img
                          src={iconPreviews[icon.id]}
                          alt={icon.name}
                          className="storage-icon-image"
                        />
                      ) : (
                        <div className="storage-icon-placeholder">?</div>
                      )}
                    </div>
                    <div className="storage-icon-info">
                      <span className="storage-icon-name" title={icon.name}>
                        {icon.name}
                      </span>
                      <span className={`storage-icon-type ${icon.type}`}>
                        {icon.type}
                      </span>
                    </div>
                    {icon.type === 'custom' && (
                      <button
                        className="storage-icon-delete"
                        onClick={() => handleDeleteIcon(icon.id, icon.name)}
                        title="Delete icon"
                      >
                        x
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      {/* Cleanup confirmation */}
      {showCleanupConfirm && (
        <div className="storage-confirm-overlay" onClick={() => setShowCleanupConfirm(false)}>
          <div className="storage-confirm-modal" onClick={(e) => e.stopPropagation()}>
            <h4 className="storage-confirm-title">Confirm Cleanup</h4>
            <p className="storage-confirm-text">
              Delete {orphanedBlobs.length} orphaned blob{orphanedBlobs.length !== 1 ? 's' : ''}?
            </p>
            <p className="storage-confirm-total">
              Total: {formatFileSize(orphanedBlobs.reduce((sum, b) => sum + b.size, 0))}
            </p>
            <div className="storage-confirm-actions">
              <button className="storage-btn" onClick={() => setShowCleanupConfirm(false)}>
                Cancel
              </button>
              <button className="storage-btn storage-btn-danger" onClick={handleConfirmCleanup}>
                Delete
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
