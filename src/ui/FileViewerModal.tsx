/**
 * FileViewerModal — Full-screen modal for viewing embedded file content.
 *
 * Dispatches to specialized viewers based on file category:
 * - PDF → PdfViewer
 * - Spreadsheet → SpreadsheetViewer
 * - Image → ImageViewer
 * - Text → TextViewer
 * - Generic → GenericFileViewer
 */

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useDocumentStore } from '../store/documentStore';
import { blobStorage } from '../storage/BlobStorage';
import { isFile, type FileShape } from '../shapes/Shape';
import { markBlobAvailable, markBlobMissing } from '../shapes/FileShape';
import { formatFileSize, getFileTypeIcon } from '../utils/fileUtils';
import { replaceFileContents, reuploadMissingBlob } from '../services/FileReplaceService';
import { getFileContentCache } from '../services/FileContentCache';
import './FileViewerModal.css';

// Lazy-load viewer components to keep main bundle small
const PdfViewer = lazy(() => import('./viewers/PdfViewer'));
const SpreadsheetViewer = lazy(() => import('./viewers/SpreadsheetViewer'));
const ImageViewer = lazy(() => import('./viewers/ImageViewer'));
const TextViewer = lazy(() => import('./viewers/TextViewer'));
const GenericFileViewer = lazy(() => import('./viewers/GenericFileViewer'));

export interface FileViewerModalProps {
  shapeId: string;
  onClose: () => void;
}

export function FileViewerModal({ shapeId, onClose }: FileViewerModalProps) {
  const shapes = useDocumentStore((state) => state.shapes);
  const shape = shapes[shapeId];

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMissingBlob, setIsMissingBlob] = useState(false);
  const [isReplacing, setIsReplacing] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recoveryInputRef = useRef<HTMLInputElement>(null);

  // Derive file shape properties safely (hooks must run unconditionally)
  const fileShape = shape && isFile(shape) ? shape : null;
  const blobRef = fileShape?.blobRef;
  const fileName = fileShape?.fileName ?? '';

  // Load blob on mount (with caching)
  useEffect(() => {
    if (!blobRef) return;

    let objectUrl: string | null = null;
    let cancelled = false;
    let fromCache = false;

    async function loadBlob() {
      setLoading(true);
      setError(null);
      setIsMissingBlob(false);

      // Check cache first
      const cache = getFileContentCache();
      const cachedUrl = cache.get(blobRef!);
      if (cachedUrl) {
        if (!cancelled) {
          objectUrl = cachedUrl;
          fromCache = true;
          setBlobUrl(cachedUrl);
          setLoading(false);
        }
        return;
      }

      try {
        const blob = await blobStorage.loadBlob(blobRef!);
        if (cancelled) return;
        if (!blob) {
          markBlobMissing(blobRef!);
          setIsMissingBlob(true);
          setError('File not found in storage.');
          setLoading(false);
          return;
        }
        markBlobAvailable(blobRef!);

        // Add to cache and get the URL
        objectUrl = cache.set(blobRef!, blob);
        fromCache = false;
        setBlobUrl(objectUrl);
      } catch (err) {
        if (!cancelled) {
          setError('Failed to load file.');
          console.error('FileViewerModal: Failed to load blob', err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadBlob();

    return () => {
      cancelled = true;
      // Only revoke if we created it (not from cache)
      // Cache manages its own URL lifecycle
      if (objectUrl && !fromCache) {
        // Actually, the cache owns the URL now, don't revoke
        // The cache will handle cleanup via LRU eviction
      }
    };
  }, [blobRef]);

  // Close on Escape
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Download file
  const handleDownload = useCallback(async () => {
    if (!blobRef) return;
    try {
      const blob = await blobStorage.loadBlob(blobRef);
      if (!blob) return;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Download failed:', err);
    }
  }, [blobRef, fileName]);

  // Replace file
  const handleReplaceClick = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  const handleReplaceFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setIsReplacing(true);
      try {
        const result = await replaceFileContents(shapeId, file);
        if (result.success) {
          // Trigger reload by clearing the blob URL
          if (blobUrl) {
            URL.revokeObjectURL(blobUrl);
          }
          setBlobUrl(null);
          setLoading(true);
          setError(null);
          setIsMissingBlob(false);
          // The blob will be reloaded via the useEffect when blobRef changes
        }
      } finally {
        setIsReplacing(false);
        // Reset file input
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [shapeId, blobUrl]
  );

  // Recovery: re-upload missing blob
  const handleRecoveryClick = useCallback(() => {
    recoveryInputRef.current?.click();
  }, []);

  const handleRecoveryFile = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (!file) return;

      setIsReplacing(true);
      try {
        const result = await reuploadMissingBlob(shapeId, file);
        if (result.success) {
          // Trigger reload
          setIsMissingBlob(false);
          setError(null);
          setLoading(true);
        }
      } finally {
        setIsReplacing(false);
        // Reset file input
        if (recoveryInputRef.current) {
          recoveryInputRef.current.value = '';
        }
      }
    },
    [shapeId]
  );

  // Close when clicking the overlay background
  const handleOverlayClick = useCallback(
    (e: React.MouseEvent) => {
      if (e.target === e.currentTarget) {
        onClose();
      }
    },
    [onClose]
  );

  // Early return AFTER all hooks
  if (!fileShape) {
    return null;
  }

  const displayName = fileShape.label || fileShape.fileName;
  const icon = getFileTypeIcon(fileShape.fileCategory);

  return (
    <div className="file-viewer-overlay" onClick={handleOverlayClick}>
      <div className="file-viewer-modal">
        {/* Header */}
        <div className="file-viewer-header">
          <div className="file-viewer-header-info">
            <span className="file-viewer-icon">{icon}</span>
            <span className="file-viewer-filename" title={fileShape.fileName}>
              {displayName}
            </span>
            <span className="file-viewer-meta">
              {formatFileSize(fileShape.fileSize)}
            </span>
            <span className="file-viewer-meta file-viewer-mime">
              {fileShape.mimeType}
            </span>
          </div>
          <div className="file-viewer-header-actions">
            <button
              className="file-viewer-action-btn"
              onClick={handleReplaceClick}
              title="Replace with different file"
              disabled={isReplacing}
            >
              {isReplacing ? '...' : '↻ Replace'}
            </button>
            <button
              className="file-viewer-action-btn"
              onClick={handleDownload}
              title="Download file"
              disabled={isMissingBlob}
            >
              ⬇ Download
            </button>
            <button
              className="file-viewer-close-btn"
              onClick={onClose}
              title="Close (Escape)"
            >
              ✕
            </button>
            {/* Hidden file inputs */}
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: 'none' }}
              onChange={handleReplaceFile}
            />
            <input
              ref={recoveryInputRef}
              type="file"
              style={{ display: 'none' }}
              onChange={handleRecoveryFile}
            />
          </div>
        </div>

        {/* Body */}
        <div className="file-viewer-body">
          {loading && (
            <div className="file-viewer-loading">
              <div className="file-viewer-spinner" />
              <span>Loading file…</span>
            </div>
          )}
          {error && !isMissingBlob && (
            <div className="file-viewer-error">
              <span className="file-viewer-error-icon">⚠️</span>
              <span>{error}</span>
            </div>
          )}
          {isMissingBlob && (
            <div className="file-viewer-recovery">
              <span className="file-viewer-recovery-icon">📂</span>
              <span className="file-viewer-recovery-title">File Not Found</span>
              <p className="file-viewer-recovery-message">
                The file content is missing from local storage.
                Re-upload the original file to restore it.
              </p>
              <button
                className="file-viewer-recovery-btn"
                onClick={handleRecoveryClick}
                disabled={isReplacing}
              >
                {isReplacing ? 'Uploading...' : 'Re-upload File'}
              </button>
            </div>
          )}
          {!loading && !error && blobUrl && (
            <Suspense
              fallback={
                <div className="file-viewer-loading">
                  <div className="file-viewer-spinner" />
                  <span>Loading viewer…</span>
                </div>
              }
            >
              {renderViewer(fileShape, blobUrl)}
            </Suspense>
          )}
        </div>
      </div>
    </div>
  );
}

function renderViewer(shape: FileShape, blobUrl: string) {
  switch (shape.fileCategory) {
    case 'pdf':
      return <PdfViewer blobUrl={blobUrl} fileName={shape.fileName} />;
    case 'spreadsheet':
      return <SpreadsheetViewer blobUrl={blobUrl} fileName={shape.fileName} />;
    case 'image':
      return <ImageViewer blobUrl={blobUrl} fileName={shape.fileName} />;
    case 'text':
      return <TextViewer blobUrl={blobUrl} fileName={shape.fileName} />;
    case 'generic':
    default:
      return (
        <GenericFileViewer
          fileName={shape.fileName}
          fileSize={shape.fileSize}
          mimeType={shape.mimeType}
          blobRef={shape.blobRef}
        />
      );
  }
}

export default FileViewerModal;
