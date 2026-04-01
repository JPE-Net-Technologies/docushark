/**
 * StorageManager - UI for managing IndexedDB blob storage.
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
import { blobStorage } from '../storage/BlobStorage';
import { BlobGarbageCollector } from '../storage/BlobGarbageCollector';
import type { BlobMetadata, StorageStats, GCStats } from '../storage/BlobTypes';
import { useIconLibraryStore, initializeIconLibrary } from '../store/iconLibraryStore';
import type { IconMetadata } from '../storage/IconTypes';
import { formatFileSize } from '../utils/imageUtils';
import { usePersistenceStore, loadDocumentFromStorage } from '../store/persistenceStore';
import './StorageManager.css';

/**
 * Extract blob IDs from Tiptap rich text content.
 * Duplicated from persistenceStore for use in recalculation.
 */
function extractBlobIds(richTextContent: any): string[] {
  const blobIds: string[] = [];

  function traverse(node: any) {
    if (!node) return;
    if (node.type === 'image' && node.attrs?.src) {
      const src = node.attrs.src as string;
      if (src.startsWith('blob://')) {
        blobIds.push(src.replace('blob://', ''));
      }
    }
    if (node.content && Array.isArray(node.content)) {
      node.content.forEach((child: any) => traverse(child));
    }
  }

  const tiptapContent = richTextContent?.content;
  if (tiptapContent) {
    traverse(tiptapContent);
  }
  return blobIds;
}

/**
 * Extract blob IDs from shape data across all pages.
 * Scans FileShape blobRef fields.
 */
function extractShapeBlobIds(pages: Record<string, any>): string[] {
  const blobIds: string[] = [];
  for (const pageId in pages) {
    if (!Object.prototype.hasOwnProperty.call(pages, pageId)) continue;
    const page = pages[pageId];
    const shapes = page?.shapes;
    if (!shapes || typeof shapes !== 'object') continue;
    for (const shapeId in shapes) {
      if (!Object.prototype.hasOwnProperty.call(shapes, shapeId)) continue;
      const shape = shapes[shapeId];
      if (shape?.type === 'file' && shape.blobRef) {
        blobIds.push(shape.blobRef);
      }
    }
  }
  return blobIds;
}

type TabId = 'images' | 'icons';

export interface StorageManagerProps {
  /** Called when the modal should close */
  onClose: () => void;
}

export function StorageManager({ onClose }: StorageManagerProps) {
  const [activeTab, setActiveTab] = useState<TabId>('images');
  const [blobs, setBlobs] = useState<BlobMetadata[]>([]);
  const [stats, setStats] = useState<StorageStats | null>(null);
  const [orphanedBlobs, setOrphanedBlobs] = useState<BlobMetadata[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isCollecting, setIsCollecting] = useState(false);
  const [isRecalculating, setIsRecalculating] = useState(false);
  const [gcResult, setGcResult] = useState<GCStats | null>(null);
  const [showCleanupConfirm, setShowCleanupConfirm] = useState(false);

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
      // Only consider truly orphaned blobs (not referenced AND zero usage)
      const safeOrphans = orphaned.filter((b) => b.usageCount === 0);
      setOrphanedBlobs(safeOrphans);
    } catch (error) {
      console.error('Failed to load storage data:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const loadIconData2 = useCallback(async () => {
    setIsLoadingIcons(true);
    try {
      // Initialize icon library if needed
      await initializeIconLibrary();

      const allIcons = getAllIcons();
      setIcons(allIcons);

      // Load previews for icons
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

  // Show confirmation dialog before cleanup
  const handleCleanupClick = () => {
    if (orphanedBlobs.length === 0) return;
    setShowCleanupConfirm(true);
  };

  // Actually perform the cleanup after confirmation
  const handleConfirmCleanup = async () => {
    setShowCleanupConfirm(false);
    setIsCollecting(true);
    setGcResult(null);

    try {
      // Only delete blobs that are truly orphaned (no references AND zero usage)
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

      // Reload data
      await loadBlobData();

      // Clear result after 5 seconds
      setTimeout(() => setGcResult(null), 5000);
    } catch (error) {
      console.error('Cleanup failed:', error);
      alert('Cleanup failed. See console for details.');
    } finally {
      setIsCollecting(false);
    }
  };

  // Recalculate usage counts by scanning all documents
  const handleRecalculateUsage = async () => {
    setIsRecalculating(true);
    try {
      // Get all blobs
      const allBlobs = await blobStorage.listAllBlobs();

      // Initialize counts to 0
      const usageCounts: Record<string, number> = {};
      for (const blob of allBlobs) {
        usageCounts[blob.id] = 0;
      }

      // Scan all documents for blob references
      const documents = getDocumentList();
      for (const docMeta of documents) {
        try {
          const doc = loadDocumentFromStorage(docMeta.id);
          if (doc) {
            const richTextBlobs = doc.richTextContent ? extractBlobIds(doc.richTextContent) : [];
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

      // Update all blob usage counts
      for (const [blobId, count] of Object.entries(usageCounts)) {
        await blobStorage.setUsageCount(blobId, count);
      }

      // Reload data to show updated counts
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

    // Reset input so the same file can be selected again
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

      // Reload icons
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
    <div className="storage-manager-overlay" onClick={onClose}>
      <div className="storage-manager" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="storage-manager-header">
          <h2>Storage Manager</h2>
          <button
            className="storage-manager-close"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            ✕
          </button>
        </div>

        {/* Tabs */}
        <div className="storage-manager-tabs">
          <button
            className={`storage-manager-tab ${activeTab === 'images' ? 'active' : ''}`}
            onClick={() => setActiveTab('images')}
          >
            Images ({blobs.length})
          </button>
          <button
            className={`storage-manager-tab ${activeTab === 'icons' ? 'active' : ''}`}
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
              <div className="storage-manager-stats">
                <div className="storage-stat">
                  <span className="storage-stat-label">Used:</span>
                  <span className="storage-stat-value">{formatFileSize(stats.used)}</span>
                </div>
                <div className="storage-stat">
                  <span className="storage-stat-label">Available:</span>
                  <span className="storage-stat-value">{formatFileSize(stats.available)}</span>
                </div>
                <div className="storage-stat">
                  <span className="storage-stat-label">Usage:</span>
                  <span className="storage-stat-value">{stats.percentUsed.toFixed(1)}%</span>
                </div>
                {orphanedBlobs.length > 0 && (
                  <div className="storage-stat storage-stat-warning">
                    <span className="storage-stat-label">Orphaned blobs:</span>
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
            <div className="storage-manager-actions">
              <button
                className="storage-manager-btn"
                onClick={handleRecalculateUsage}
                disabled={isRecalculating || isLoading}
                title="Scan all documents to recalculate accurate usage counts"
              >
                {isRecalculating ? 'Scanning...' : 'Recalculate Usage'}
              </button>
              <button
                className="storage-manager-btn storage-manager-btn-primary"
                onClick={handleCleanupClick}
                disabled={isCollecting || orphanedBlobs.length === 0}
              >
                {isCollecting ? 'Cleaning up...' : `Clean Up${orphanedBlobs.length > 0 ? ` (${orphanedBlobs.length})` : ''}`}
              </button>

              {gcResult && (
                <div className="storage-manager-gc-result">
                  Freed {formatFileSize(gcResult.bytesFreed)} ({gcResult.blobsDeleted} blob
                  {gcResult.blobsDeleted !== 1 ? 's' : ''})
                </div>
              )}
            </div>

            {/* Blob list */}
            <div className="storage-manager-content">
              {isLoading ? (
                <div className="storage-manager-loading">Loading...</div>
              ) : blobs.length === 0 ? (
                <div className="storage-manager-empty">No images stored</div>
              ) : (
                <div className="storage-manager-list">
                  <div className="storage-manager-list-header">
                    <span className="storage-blob-name">Name</span>
                    <span className="storage-blob-type">Type</span>
                    <span className="storage-blob-size">Size</span>
                    <span className="storage-blob-usage">Usage</span>
                    <span className="storage-blob-date">Created</span>
                    <span className="storage-blob-actions">Actions</span>
                  </div>

                  {blobs.map((blob) => (
                    <div key={blob.id} className="storage-manager-list-item">
                      <span className="storage-blob-name" title={blob.name}>
                        {blob.name}
                      </span>
                      <span className="storage-blob-type">{blob.type.replace('image/', '')}</span>
                      <span className="storage-blob-size">{formatFileSize(blob.size)}</span>
                      <span className="storage-blob-usage">
                        {blob.usageCount === 0 ? (
                          <span className="storage-orphan-badge">Orphaned</span>
                        ) : (
                          `${blob.usageCount}×`
                        )}
                      </span>
                      <span className="storage-blob-date" title={formatDate(blob.createdAt)}>
                        {new Date(blob.createdAt).toLocaleDateString()}
                      </span>
                      <span className="storage-blob-actions">
                        <button
                          className="storage-manager-btn-small"
                          onClick={() => handleDeleteBlob(blob.id, blob.name)}
                          title="Delete blob"
                        >
                          Delete
                        </button>
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}

        {/* Icons Tab */}
        {activeTab === 'icons' && (
          <>
            {/* Icon stats */}
            <div className="storage-manager-stats">
              <div className="storage-stat">
                <span className="storage-stat-label">Built-in:</span>
                <span className="storage-stat-value">{builtinIconCount}</span>
              </div>
              <div className="storage-stat">
                <span className="storage-stat-label">Custom:</span>
                <span className="storage-stat-value">{customIconCount}</span>
              </div>
            </div>

            {/* Upload button */}
            <div className="storage-manager-actions">
              <button
                className="storage-manager-btn storage-manager-btn-primary"
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
            <div className="storage-manager-content">
              {isLoadingIcons ? (
                <div className="storage-manager-loading">Loading...</div>
              ) : icons.length === 0 ? (
                <div className="storage-manager-empty">No icons available</div>
              ) : (
                <div className="storage-icon-grid">
                  {icons.map((icon) => (
                    <div key={icon.id} className="storage-icon-item">
                      <div
                        className="storage-icon-preview"
                        title={icon.name}
                      >
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
                          ✕
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* Cleanup confirmation modal */}
      {showCleanupConfirm && (
        <div className="storage-manager-modal-overlay" onClick={() => setShowCleanupConfirm(false)}>
          <div className="storage-manager-modal" onClick={(e) => e.stopPropagation()}>
            <h3 className="storage-manager-modal-title">Confirm Cleanup</h3>
            <p className="storage-manager-modal-text">
              The following {orphanedBlobs.length} orphaned blob{orphanedBlobs.length !== 1 ? 's' : ''} will be permanently deleted:
            </p>
            <div className="storage-manager-modal-preview">
              {orphanedBlobs.map((blob) => (
                <div key={blob.id} className="storage-manager-modal-item">
                  <span className="storage-manager-modal-item-name">{blob.name}</span>
                  <span className="storage-manager-modal-item-size">{formatFileSize(blob.size)}</span>
                </div>
              ))}
            </div>
            <p className="storage-manager-modal-total">
              Total: {formatFileSize(orphanedBlobs.reduce((sum, b) => sum + b.size, 0))}
            </p>
            <div className="storage-manager-modal-actions">
              <button
                className="storage-manager-btn"
                onClick={() => setShowCleanupConfirm(false)}
              >
                Cancel
              </button>
              <button
                className="storage-manager-btn storage-manager-btn-danger"
                onClick={handleConfirmCleanup}
              >
                Delete {orphanedBlobs.length} Blob{orphanedBlobs.length !== 1 ? 's' : ''}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
