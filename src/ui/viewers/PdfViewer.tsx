/**
 * PdfViewer — continuous-scroll PDF reader built on pdf.js viewer components
 * (PDFViewer + EventBus + PDFLinkService + PDFFindController). The pdf.js
 * lifecycle lives in usePdfViewerController; this shell composes the toolbar,
 * find bar, outline sidebar, and the scroll container, and owns the reader's
 * UI-only state (find/sidebar visibility, page dimming).
 *
 * Immersive mode is host-owned (the modal's chrome collapses too): the host
 * passes `immersive` + `onImmersiveChange`, and this shell swaps its toolbar
 * for a minimal floating strip while immersive.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Minimize2, TriangleAlert } from 'lucide-react';
import { Icon } from '../icons';
import { usePdfViewerController } from './pdf/usePdfViewerController';
import { PdfToolbar } from './pdf/PdfToolbar';
import { PdfFindBar } from './pdf/PdfFindBar';
import { PdfSidebar } from './pdf/PdfSidebar';
import { clampPage } from './pdf/zoom';
import 'pdfjs-dist/web/pdf_viewer.css';
import './pdf/PdfReader.css';

export interface PdfViewerProps {
  blobUrl: string;
  fileName: string;
  /** Host-owned immersive reading mode (modal chrome collapses with it). */
  immersive?: boolean | undefined;
  onImmersiveChange?: ((immersive: boolean) => void) | undefined;
}

export function PdfViewer({ blobUrl, immersive, onImmersiveChange }: PdfViewerProps) {
  const controller = usePdfViewerController(blobUrl);
  const [showFind, setShowFind] = useState(false);
  const [showSidebar, setShowSidebar] = useState(false);
  const [dimmed, setDimmed] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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
  // (host handles immersive-exit, then close).
  const handleRootKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape' && showFind) {
        e.stopPropagation();
        closeFindBar();
      }
    },
    [showFind, closeFindBar],
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
        />
      )}

      {showFind && <PdfFindBar controller={controller} onClose={closeFindBar} />}

      <div className="pdf-reader__main">
        {showSidebar && !immersive && (
          <PdfSidebar outline={controller.outline} onNavigate={controller.goToDestination} />
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
