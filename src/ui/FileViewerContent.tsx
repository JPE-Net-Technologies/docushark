/**
 * FileViewerContent — the host-independent core of the file viewer: blob
 * resolution, header (name/meta/actions/info), missing-blob recovery, and the
 * per-category viewer dispatch. Hosted by FileViewerModal (full-screen) and
 * FloatingFileViewer (side panel) — hosts own chrome, Escape, and placement.
 */

import { useState, useEffect, useCallback, useRef, lazy, Suspense } from 'react';
import { useDocumentStore } from '../store/documentStore';
import { blobStorage } from '../storage/BlobStorage';
import { resolveBlobObjectUrl } from '../storage/blobResolver';
import { isFile, type FileShape } from '../shapes/Shape';
import {
  Copy,
  Download,
  FolderOpen,
  Info,
  Quote,
  RotateCw,
  TriangleAlert,
  X,
} from 'lucide-react';
import { formatFileSize, resolveViewerCategory } from '../utils/fileUtils';
import { downloadBlob } from '../utils/downloadUtils';
import { getFileTypeLucideIcon } from '../utils/fileTypeIcons';
import { Icon } from './icons';
import { replaceFileContents, reuploadMissingBlob } from '../services/FileReplaceService';
import { citePdf, citeDoi, citeMinimal, type CitePdfStatus } from '../services/citations/citePdf';
import { useNotificationStore } from '../store/notificationStore';
import './FileViewerModal.css';

// Lazy-load viewer components to keep main bundle small
const PdfViewer = lazy(() => import('./viewers/PdfViewer'));
const SpreadsheetViewer = lazy(() => import('./viewers/SpreadsheetViewer'));
const ImageViewer = lazy(() => import('./viewers/ImageViewer'));
const AudioViewer = lazy(() => import('./viewers/AudioViewer'));
const VideoViewer = lazy(() => import('./viewers/VideoViewer'));
const TextViewer = lazy(() => import('./viewers/TextViewer'));
const GenericFileViewer = lazy(() => import('./viewers/GenericFileViewer'));

/** Resolve a shape id to its FileShape, or null when absent/not a file. */
export function useFileShape(shapeId: string): FileShape | null {
  const shapes = useDocumentStore((state) => state.shapes);
  const shape = shapes[shapeId];
  return shape && isFile(shape) ? shape : null;
}

export interface FileViewerContentProps {
  shapeId: string;
  onClose: () => void;
  /** Host-owned immersive reading mode (PDF only). */
  immersive?: boolean | undefined;
  /** Absent hides the immersive affordance (e.g. in the floating host). */
  onImmersiveChange?: ((immersive: boolean) => void) | undefined;
  /** Collapse the header (the modal does this while immersive). */
  hideHeader?: boolean | undefined;
  /** Host-provided header buttons (pop-out / dock-back). */
  headerExtras?: React.ReactNode;
  /** Host drag-start hook — makes the header the floating panel's handle. */
  headerPointerDown?: ((e: React.PointerEvent<HTMLDivElement>) => void) | undefined;
}

export function FileViewerContent({
  shapeId,
  onClose,
  immersive,
  onImmersiveChange,
  hideHeader,
  headerExtras,
  headerPointerDown,
}: FileViewerContentProps) {
  const fileShape = useFileShape(shapeId);

  const [blobUrl, setBlobUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isMissingBlob, setIsMissingBlob] = useState(false);
  const [isReplacing, setIsReplacing] = useState(false);
  const [showInfo, setShowInfo] = useState(false);
  const [hashCopied, setHashCopied] = useState(false);
  const [citing, setCiting] = useState(false);
  // Non-null opens the manual-DOI popover (auto-detect found nothing).
  const [citePrompt, setCitePrompt] = useState<{ title: string | null } | null>(null);
  const [doiInput, setDoiInput] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const recoveryInputRef = useRef<HTMLInputElement>(null);

  const blobRef = fileShape?.blobRef;
  const fileName = fileShape?.fileName ?? '';

  // Load blob on mount. resolveBlobObjectUrl checks the shared object-URL cache,
  // then local IndexedDB, then downloads from the relay/R2 on a miss — so a file
  // uploaded on another device (or never pulled locally) still opens (JP-129).
  // The returned URL is owned by the resolver cache; we never revoke it here.
  useEffect(() => {
    if (!blobRef) return;

    let cancelled = false;

    async function loadBlob() {
      setLoading(true);
      setError(null);
      setIsMissingBlob(false);

      try {
        const url = await resolveBlobObjectUrl(blobRef!);
        if (cancelled) return;
        if (!url) {
          // Truly unavailable: not local, and not downloadable (local-only doc
          // or the relay fetch failed). resolveBlobObjectUrl already marked the
          // blob missing, so the canvas overlay reflects it too.
          setIsMissingBlob(true);
          setError('File not found in storage.');
          setLoading(false);
          return;
        }
        setBlobUrl(url);
      } catch (err) {
        if (!cancelled) {
          setError('Failed to load file.');
          console.error('FileViewerContent: Failed to load blob', err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadBlob();

    return () => {
      cancelled = true;
    };
  }, [blobRef]);

  // Download file
  const handleDownload = useCallback(async () => {
    if (!blobRef) return;
    try {
      const blob = await blobStorage.loadBlob(blobRef);
      if (!blob) return;
      downloadBlob(blob, fileName);
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
          // Trigger reload. The old object URL is owned by the resolver cache
          // (content-addressed, reclaimed on doc switch) — don't revoke it here.
          // The new blobRef makes the load effect re-resolve the replacement.
          setBlobUrl(null);
          setLoading(true);
          setError(null);
          setIsMissingBlob(false);
        }
      } finally {
        setIsReplacing(false);
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }
    },
    [shapeId]
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
          setIsMissingBlob(false);
          setError(null);
          setLoading(true);
        }
      } finally {
        setIsReplacing(false);
        if (recoveryInputRef.current) {
          recoveryInputRef.current.value = '';
        }
      }
    },
    [shapeId]
  );

  // Cite this PDF: auto-detect the DOI, resolve, import. No DOI → popover.
  const notifyCiteStatus = useCallback((status: CitePdfStatus, doi: string | null) => {
    const notifications = useNotificationStore.getState();
    if (status === 'added') {
      notifications.success('Reference added to the library');
    } else if (status === 'duplicate') {
      notifications.info('This reference is already in the library');
    } else if (status === 'resolve-failed') {
      notifications.warning(
        doi ? `Couldn't resolve DOI ${doi}` : "Couldn't resolve that DOI",
      );
    }
  }, []);

  const handleCite = useCallback(async () => {
    if (!blobRef || citing) return;
    setCiting(true);
    try {
      const blob = await blobStorage.loadBlob(blobRef);
      if (!blob) return;
      const result = await citePdf(blob);
      if (result.status === 'no-doi' || result.status === 'resolve-failed') {
        if (result.status === 'resolve-failed') notifyCiteStatus(result.status, result.doi);
        setDoiInput(result.doi ?? '');
        setCitePrompt({ title: result.title });
      } else {
        notifyCiteStatus(result.status, result.doi);
        setCitePrompt(null);
      }
    } catch (err) {
      console.error('Cite failed:', err);
      useNotificationStore.getState().error('Citing this PDF failed');
    } finally {
      setCiting(false);
    }
  }, [blobRef, citing, notifyCiteStatus]);

  const handleCiteDoiSubmit = useCallback(async () => {
    const doi = doiInput.trim();
    if (doi === '' || citing) return;
    setCiting(true);
    try {
      const status = await citeDoi(doi);
      notifyCiteStatus(status, doi);
      if (status === 'added' || status === 'duplicate') setCitePrompt(null);
    } finally {
      setCiting(false);
    }
  }, [doiInput, citing, notifyCiteStatus]);

  const handleCiteMinimal = useCallback(() => {
    const status = citeMinimal(fileName, citePrompt?.title ?? null);
    notifyCiteStatus(status, null);
    setCitePrompt(null);
  }, [fileName, citePrompt, notifyCiteStatus]);

  const handleCopyHash = useCallback(async () => {
    if (!blobRef) return;
    try {
      await navigator.clipboard.writeText(blobRef);
      setHashCopied(true);
      setTimeout(() => setHashCopied(false), 1500);
    } catch {
      /* clipboard unavailable — the short hash is still visible to copy by hand */
    }
  }, [blobRef]);

  if (!fileShape) {
    return null;
  }

  const displayName = fileShape.label || fileShape.fileName;
  const FileIcon = getFileTypeLucideIcon(fileShape.fileCategory);

  return (
    <div className="file-viewer-content">
      {/* Header */}
      <div
        className="file-viewer-header"
        hidden={hideHeader === true}
        onPointerDown={headerPointerDown}
      >
        <div className="file-viewer-header-info">
          <span className="file-viewer-icon"><Icon icon={FileIcon} size={18} /></span>
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
          {headerExtras}
          {resolveViewerCategory(fileShape.fileCategory, fileShape.mimeType) === 'pdf' && (
            <button
              className="file-viewer-action-btn"
              onClick={handleCite}
              title="Cite this PDF — add it to the reference library"
              disabled={citing || isMissingBlob}
            >
              <Icon icon={Quote} size={14} />
              {citing ? 'Citing…' : 'Cite'}
            </button>
          )}
          <button
            className={`file-viewer-action-btn${showInfo ? ' file-viewer-action-btn--active' : ''}`}
            onClick={() => setShowInfo((v) => !v)}
            title="File info"
            aria-pressed={showInfo}
          >
            <Icon icon={Info} size={14} />
          </button>
          <button
            className="file-viewer-action-btn"
            onClick={handleReplaceClick}
            title="Replace with different file"
            disabled={isReplacing}
          >
            {isReplacing ? '...' : <><Icon icon={RotateCw} size={14} />Replace</>}
          </button>
          <button
            className="file-viewer-action-btn"
            onClick={handleDownload}
            title="Download file"
            disabled={isMissingBlob}
          >
            <Icon icon={Download} size={14} />Download
          </button>
          <button
            className="file-viewer-close-btn"
            onClick={onClose}
            title="Close (Escape)"
          >
            <Icon icon={X} size={16} />
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

      {/* Manual-DOI popover — auto-detection found no DOI in the PDF */}
      {citePrompt && !hideHeader && (
        <div className="file-viewer-info file-viewer-cite" role="dialog" aria-label="Cite this PDF">
          <p className="file-viewer-cite-text">
            No DOI was found in this PDF. Paste one, or add a minimal reference
            from the file's details.
          </p>
          <div className="file-viewer-cite-row">
            <input
              className="file-viewer-cite-input"
              placeholder="10.xxxx/…"
              value={doiInput}
              onChange={(e) => setDoiInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void handleCiteDoiSubmit();
                else if (e.key === 'Escape') {
                  e.stopPropagation();
                  setCitePrompt(null);
                }
              }}
              aria-label="DOI"
            />
            <button
              className="file-viewer-action-btn"
              onClick={handleCiteDoiSubmit}
              disabled={citing || doiInput.trim() === ''}
            >
              Add
            </button>
          </div>
          <div className="file-viewer-cite-row">
            <button className="file-viewer-cite-minimal" onClick={handleCiteMinimal}>
              Add minimal reference instead
            </button>
            <button className="file-viewer-cite-minimal" onClick={() => setCitePrompt(null)}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* File info popover — the shape's storage properties at a glance */}
      {showInfo && !hideHeader && (
        <div className="file-viewer-info" role="dialog" aria-label="File info">
          <dl className="file-viewer-info-grid">
            <dt>Name</dt>
            <dd title={fileShape.fileName}>{fileShape.fileName}</dd>
            <dt>Size</dt>
            <dd>{formatFileSize(fileShape.fileSize)}</dd>
            <dt>Type</dt>
            <dd>{fileShape.mimeType}</dd>
            {fileShape.preview?.pageCount !== undefined && (
              <>
                <dt>Pages</dt>
                <dd>{fileShape.preview.pageCount}</dd>
              </>
            )}
            <dt>Checksum</dt>
            <dd className="file-viewer-info-hash">
              <code title={fileShape.blobRef}>{fileShape.blobRef.slice(0, 12)}…</code>
              <button
                className="file-viewer-info-copy"
                onClick={handleCopyHash}
                title="Copy full SHA-256"
              >
                <Icon icon={Copy} size={12} />
                {hashCopied ? 'Copied' : 'Copy'}
              </button>
            </dd>
            <dt>Storage</dt>
            <dd>{isMissingBlob ? 'Missing from this device' : 'Stored on this device'}</dd>
          </dl>
        </div>
      )}

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
            <span className="file-viewer-error-icon"><Icon icon={TriangleAlert} size={20} /></span>
            <span>{error}</span>
          </div>
        )}
        {isMissingBlob && (
          <div className="file-viewer-recovery">
            <span className="file-viewer-recovery-icon"><Icon icon={FolderOpen} size={28} /></span>
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
            {renderViewer(fileShape, blobUrl, immersive === true, onImmersiveChange)}
          </Suspense>
        )}
      </div>
    </div>
  );
}

function renderViewer(
  shape: FileShape,
  blobUrl: string,
  immersive: boolean,
  onImmersiveChange: ((immersive: boolean) => void) | undefined,
) {
  // resolveViewerCategory upgrades pre-audio/video 'generic' shapes at view
  // time from their stored MIME — no doc migration needed.
  switch (resolveViewerCategory(shape.fileCategory, shape.mimeType)) {
    case 'pdf':
      return (
        <PdfViewer
          blobUrl={blobUrl}
          fileName={shape.fileName}
          shapeId={shape.id}
          blobHash={shape.blobRef}
          immersive={immersive}
          onImmersiveChange={onImmersiveChange}
        />
      );
    case 'spreadsheet':
      return <SpreadsheetViewer blobUrl={blobUrl} fileName={shape.fileName} />;
    case 'image':
      return <ImageViewer blobUrl={blobUrl} fileName={shape.fileName} />;
    case 'audio':
      return <AudioViewer blobUrl={blobUrl} fileName={shape.fileName} />;
    case 'video':
      return <VideoViewer blobUrl={blobUrl} fileName={shape.fileName} />;
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

export default FileViewerContent;
