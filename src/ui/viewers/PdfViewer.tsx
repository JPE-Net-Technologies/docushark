/**
 * PdfViewer — continuous-scroll PDF reader built on pdf.js viewer components
 * (PDFViewer + EventBus + PDFLinkService + PDFFindController). The pdf.js
 * lifecycle lives in usePdfViewerController; this shell composes the toolbar,
 * find bar, outline/bookmarks sidebar, and the scroll container, and owns the
 * reader's UI-only state (find/sidebar visibility, page dimming).
 *
 * Reading state (last page, zoom, bookmarks) persists per-user via
 * fileViewStateStore, keyed by the active document + shape — never into the
 * document itself. Hosts that can't provide `shapeId`/`blobHash` still get a
 * fully working (just stateless) reader.
 *
 * Immersive mode is host-owned (the modal's chrome collapses too): the host
 * passes `immersive` + `onImmersiveChange`, and this shell swaps its toolbar
 * for a minimal floating strip while immersive.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Bookmark, Minimize2, TriangleAlert } from 'lucide-react';
import { Icon } from '../icons';
import { useActiveDocumentId } from '../../store/documentRegistry';
import {
  getFileViewRecord,
  useFileViewStateStore,
} from '../../store/fileViewStateStore';
import {
  reconcileRecord,
  removeBookmark,
  renameBookmark,
  toggleBookmark,
  viewKey,
} from '../../store/fileViewState';
import { usePdfViewerController } from './pdf/usePdfViewerController';
import { PdfToolbar } from './pdf/PdfToolbar';
import { PdfFindBar } from './pdf/PdfFindBar';
import { PdfSidebar } from './pdf/PdfSidebar';
import { clampPage } from './pdf/zoom';
import { exportPdfPageAsPngFile } from './pdf/exportPageImage';
import { importFilesAtViewportCenter } from '../../services/canvasImportSeam';
import { useNotificationStore } from '../../store/notificationStore';
import { useSessionStore } from '../../store/sessionStore';
import 'pdfjs-dist/web/pdf_viewer.css';
import './pdf/PdfReader.css';

export interface PdfViewerProps {
  blobUrl: string;
  fileName: string;
  /** Identity for per-user reading state; omit to disable persistence. */
  shapeId?: string | undefined;
  /** Content hash (`FileShape.blobRef`) for replacement staleness detection. */
  blobHash?: string | undefined;
  /** Host-owned immersive reading mode (modal chrome collapses with it). */
  immersive?: boolean | undefined;
  onImmersiveChange?: ((immersive: boolean) => void) | undefined;
}

export function PdfViewer({
  blobUrl,
  fileName,
  shapeId,
  blobHash,
  immersive,
  onImmersiveChange,
}: PdfViewerProps) {
  const [showFind, setShowFind] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [dimmed, setDimmed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // ---------------------------------------------------------------------------
  // Per-user reading state (skipped entirely when identity is unavailable)
  // ---------------------------------------------------------------------------
  const docId = useActiveDocumentId();
  const persistId = docId && shapeId && blobHash ? { docId, shapeId, hash: blobHash } : null;
  const upsert = useFileViewStateStore((s) => s.upsert);
  const bookmarks = useFileViewStateStore((s) =>
    persistId ? s.records[viewKey(persistId.docId, persistId.shapeId)]?.bookmarks : undefined,
  );
  const persistRef = useRef(persistId);
  persistRef.current = persistId;

  const controller = usePdfViewerController(blobUrl, {
    getInitialView: (numPages) => {
      const id = persistRef.current;
      if (!id) return null;
      const rec = getFileViewRecord(id.docId, id.shapeId);
      if (!rec) return null;
      const reconciled = reconcileRecord(rec, id.hash, numPages);
      if (reconciled !== rec) {
        // Write the clamp back so a replacement reconciles once, not per open.
        upsert(id.docId, id.shapeId, reconciled);
      }
      return {
        page: reconciled.lastPage,
        zoomMode: reconciled.zoomMode,
        zoomPercent: reconciled.zoomPercent,
      };
    },
  });

  // Debounced write of page + zoom; gated on the restore-guard so the initial
  // page-1/scale events during load never stomp the stored position.
  const { currentPage, zoomMode, zoomPercent, viewRestored } = controller;
  useEffect(() => {
    if (!persistId || !viewRestored) return undefined;
    const { docId: d, shapeId: s, hash } = persistId;
    const t = setTimeout(() => {
      upsert(d, s, {
        hash,
        lastPage: currentPage,
        zoomMode,
        ...(zoomMode === 'custom' ? { zoomPercent } : {}),
      });
    }, 500);
    return () => clearTimeout(t);
    // persistId is identity-stable per (docId, shapeId, hash) via the strings below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId, shapeId, blobHash, viewRestored, currentPage, zoomMode, zoomPercent, upsert]);

  const isCurrentBookmarked =
    bookmarks?.some((b) => b.page === controller.currentPage) ?? false;

  const handleToggleBookmark = useCallback(() => {
    const id = persistRef.current;
    if (!id) return;
    const current = getFileViewRecord(id.docId, id.shapeId)?.bookmarks ?? [];
    upsert(id.docId, id.shapeId, {
      hash: id.hash,
      bookmarks: toggleBookmark(current, controller.currentPage, Date.now()),
    });
  }, [controller.currentPage, upsert]);

  const handleRenameBookmark = useCallback(
    (page: number, label: string) => {
      const id = persistRef.current;
      if (!id) return;
      const current = getFileViewRecord(id.docId, id.shapeId)?.bookmarks ?? [];
      upsert(id.docId, id.shapeId, { hash: id.hash, bookmarks: renameBookmark(current, page, label) });
    },
    [upsert],
  );

  const handleRemoveBookmark = useCallback(
    (page: number) => {
      const id = persistRef.current;
      if (!id) return;
      const current = getFileViewRecord(id.docId, id.shapeId)?.bookmarks ?? [];
      upsert(id.docId, id.shapeId, { hash: id.hash, bookmarks: removeBookmark(current, page) });
    },
    [upsert],
  );

  // Send the current page to the canvas as a high-res PNG file shape.
  const sendingPageRef = useRef(false);
  const handleSendPageToCanvas = useCallback(async () => {
    if (sendingPageRef.current) return;
    sendingPageRef.current = true;
    const notifications = useNotificationStore.getState();
    const page = controller.currentPage;
    try {
      const blob = await (await fetch(blobUrl)).blob();
      const file = await exportPdfPageAsPngFile(blob, page, fileName);
      if (!file) {
        notifications.error('Rendering that page failed');
        return;
      }
      const imported = await importFilesAtViewportCenter([file]);
      if (!imported) {
        notifications.warning('No canvas available to receive the page');
        return;
      }
      notifications.success(`Page ${page} sent to the canvas`, {
        actionLabel: 'Show',
        onAction: () => useSessionStore.getState().closeFileViewer(),
      });
    } catch (err) {
      console.error('Send page to canvas failed:', err);
      notifications.error('Sending the page to the canvas failed');
    } finally {
      sendingPageRef.current = false;
    }
  }, [blobUrl, fileName, controller.currentPage]);

  // ---------------------------------------------------------------------------
  // Reader chrome state + keyboard
  // ---------------------------------------------------------------------------

  // Focus the reader so keyboard scrolling and shortcuts work immediately.
  useEffect(() => {
    rootRef.current?.focus();
  }, []);

  const closeFindBar = useCallback(() => {
    setShowFind(false);
    controller.closeFind();
    rootRef.current?.focus();
  }, [controller]);

  const toggleFindBar = useCallback(() => {
    if (showFind) closeFindBar();
    else setShowFind(true);
  }, [showFind, closeFindBar]);

  // Ctrl/Cmd+F opens find. Native capture listener scoped to the reader root
  // so it wins over the browser default without touching app-level shortcuts.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') {
        e.preventDefault();
        e.stopPropagation();
        setShowFind(true);
      }
    };
    root.addEventListener('keydown', onKeyDown, true);
    return () => root.removeEventListener('keydown', onKeyDown, true);
  }, []);

  // Escape closes the find bar before the host's window-level handler sees it
  // (host handles immersive-exit, then close). `b` bookmarks the current page.
  const handleRootKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && showFind) {
        e.stopPropagation();
        closeFindBar();
        return;
      }
      const target = e.target as HTMLElement;
      const inField =
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.isContentEditable;
      if (e.key === 'b' && !e.ctrlKey && !e.metaKey && !e.altKey && !inField && persistRef.current) {
        e.stopPropagation();
        handleToggleBookmark();
      }
    },
    [showFind, closeFindBar, handleToggleBookmark],
  );

  const rootClass = [
    'pdf-reader',
    immersive ? 'pdf-reader--immersive' : '',
    dimmed ? 'pdf-reader--dimmed' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClass} ref={rootRef} tabIndex={-1} onKeyDown={handleRootKeyDown}>
      {!immersive && (
        <PdfToolbar
          controller={controller}
          showFind={showFind}
          onToggleFind={toggleFindBar}
          showSidebar={showSidebar}
          onToggleSidebar={() => setShowSidebar((v) => !v)}
          dimmed={dimmed}
          onToggleDimmed={() => setDimmed((v) => !v)}
          onEnterImmersive={onImmersiveChange ? () => onImmersiveChange(true) : undefined}
          bookmarkState={
            persistId ? { active: isCurrentBookmarked, onToggle: handleToggleBookmark } : undefined
          }
          onSendPageToCanvas={handleSendPageToCanvas}
        />
      )}

      {showFind && <PdfFindBar controller={controller} onClose={closeFindBar} />}

      <div className="pdf-reader__main">
        {showSidebar && !immersive && (
          <PdfSidebar
            outline={controller.outline}
            onNavigate={controller.goToDestination}
            bookmarks={persistId ? (bookmarks ?? []) : undefined}
            currentPage={controller.currentPage}
            onJumpToPage={controller.goToPage}
            onRenameBookmark={handleRenameBookmark}
            onRemoveBookmark={handleRemoveBookmark}
            onBookmarkCurrent={handleToggleBookmark}
          />
        )}
        <div className="pdf-reader__body">
          {/* pdf.js container contract: absolutely-positioned scroll container
              with a `.pdfViewer` child. Always mounted — the controller binds
              on mount; loading/error panels overlay it. */}
          <div className="pdf-reader__container" ref={controller.containerRef}>
            <div className="pdfViewer" ref={controller.viewerRef} />
          </div>

          {controller.loading && (
            <div className="pdf-reader__overlay">
              <div className="pdf-reader__spinner" />
              <span>Loading PDF…</span>
            </div>
          )}
          {controller.error && (
            <div className="pdf-reader__overlay">
              <span className="pdf-reader__error-icon">
                <Icon icon={TriangleAlert} size={24} />
              </span>
              <span>{controller.error}</span>
            </div>
          )}
        </div>
      </div>

      {immersive && (
        <div className="pdf-reader__immersive-strip">
          <ImmersivePageInput controller={controller} />
          {persistId && (
            <button
              className={`pdf-reader__btn${isCurrentBookmarked ? ' pdf-reader__btn--active' : ''}`}
              onClick={handleToggleBookmark}
              title={isCurrentBookmarked ? 'Remove bookmark (b)' : 'Bookmark this page (b)'}
              aria-pressed={isCurrentBookmarked}
            >
              <Icon icon={Bookmark} size={16} />
            </button>
          )}
          <button
            className="pdf-reader__btn"
            onClick={() => onImmersiveChange?.(false)}
            title="Exit immersive reading (Escape)"
          >
            <Icon icon={Minimize2} size={16} />
          </button>
        </div>
      )}
    </div>
  );
}

/** Compact page indicator + input for the immersive strip. */
function ImmersivePageInput({
  controller,
}: {
  controller: ReturnType<typeof usePdfViewerController>;
}) {
  const { currentPage, numPages } = controller;
  const [value, setValue] = useState(String(currentPage));

  useEffect(() => {
    setValue(String(currentPage));
  }, [currentPage]);

  const commit = useCallback(() => {
    const num = parseInt(value, 10);
    if (!Number.isNaN(num)) controller.goToPage(clampPage(num, numPages));
    else setValue(String(currentPage));
  }, [value, numPages, currentPage, controller]);

  return (
    <span className="pdf-reader__page-info">
      <input
        className="pdf-reader__page-input"
        type="number"
        min={1}
        max={numPages}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            commit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        aria-label="Page number"
      />
      <span className="pdf-reader__page-total">/ {numPages}</span>
    </span>
  );
}

export default PdfViewer;
