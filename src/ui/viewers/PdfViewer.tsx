/**
 * PdfViewer — Renders PDF files page-by-page using pdf.js with
 * navigation controls, zoom (fit-width / fit-page / custom), and
 * high-DPI canvas rendering.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import './PdfViewer.css';

// Configure pdf.js worker — matches pattern in ThumbnailGenerator.ts
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
}

export interface PdfViewerProps {
  blobUrl: string;
  fileName: string;
}

type ZoomMode = 'custom' | 'fit-width' | 'fit-page';

const MIN_ZOOM = 0.25;
const MAX_ZOOM = 5.0;
const ZOOM_STEP = 0.25;

export function PdfViewer({ blobUrl }: PdfViewerProps) {
  const [pdfDoc, setPdfDoc] = useState<PDFDocumentProxy | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(0);
  const [zoomLevel, setZoomLevel] = useState(1.0);
  const [zoomMode, setZoomMode] = useState<ZoomMode>('fit-width');
  const [displayZoomPercent, setDisplayZoomPercent] = useState(100);
  const [rendering, setRendering] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState('1');
  const [resizeTrigger, setResizeTrigger] = useState(0);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const renderTaskRef = useRef<{ promise: Promise<void>; cancel(): void } | null>(null);

  // ---------------------------------------------------------------------------
  // Load PDF document from blob URL
  // ---------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    let doc: PDFDocumentProxy | null = null;

    async function loadPdf() {
      setLoading(true);
      setError(null);

      try {
        const loadingTask = pdfjsLib.getDocument(blobUrl);
        doc = await loadingTask.promise;

        if (cancelled) {
          doc.destroy();
          return;
        }

        setPdfDoc(doc);
        setTotalPages(doc.numPages);
        setCurrentPage(1);
        setPageInput('1');
      } catch (err) {
        if (!cancelled) {
          console.error('PdfViewer: Failed to load PDF', err);
          setError(
            'Failed to load PDF. The file may be corrupt or not a valid PDF.',
          );
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    loadPdf();

    return () => {
      cancelled = true;
      // Cancel any in-flight render before destroying the document
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          /* already cleaned up */
        }
        renderTaskRef.current = null;
      }
      if (doc) doc.destroy();
      setPdfDoc(null);
    };
  }, [blobUrl]);

  // ---------------------------------------------------------------------------
  // Observe container resize so fit modes recalculate
  // ---------------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (zoomMode === 'custom' || !container) return;

    let timeoutId: ReturnType<typeof setTimeout> | null = null;
    const observer = new ResizeObserver(() => {
      if (timeoutId !== null) clearTimeout(timeoutId);
      timeoutId = setTimeout(() => {
        setResizeTrigger((n) => n + 1);
      }, 150);
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (timeoutId !== null) clearTimeout(timeoutId);
    };
  }, [zoomMode, loading]);

  // ---------------------------------------------------------------------------
  // Render current page to canvas
  // ---------------------------------------------------------------------------
  useEffect(() => {
    if (!pdfDoc) return;
    const doc = pdfDoc; // local binding for TypeScript narrowing

    let cancelled = false;

    async function render() {
      // Cancel any previous render in progress
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          /* noop */
        }
        renderTaskRef.current = null;
      }

      setRendering(true);

      try {
        const page = await doc.getPage(currentPage);
        if (cancelled) return;

        // Compute effective zoom scale
        let scale: number;
        if (zoomMode === 'custom') {
          scale = zoomLevel;
        } else {
          const container = containerRef.current;
          if (!container || container.clientWidth === 0) {
            scale = 1.0;
          } else {
            const baseViewport = page.getViewport({ scale: 1.0 });
            const availableWidth = container.clientWidth - 32;
            const availableHeight = container.clientHeight - 32;

            if (zoomMode === 'fit-width') {
              scale = availableWidth / baseViewport.width;
            } else {
              scale = Math.min(
                availableWidth / baseViewport.width,
                availableHeight / baseViewport.height,
              );
            }
          }
        }

        scale = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, scale));
        setDisplayZoomPercent(Math.round(scale * 100));

        const viewport = page.getViewport({ scale });
        const cvs = canvasRef.current;
        if (!cvs || cancelled) return;

        // High-DPI rendering
        const dpr = window.devicePixelRatio || 1;
        cvs.width = viewport.width * dpr;
        cvs.height = viewport.height * dpr;
        cvs.style.width = `${viewport.width}px`;
        cvs.style.height = `${viewport.height}px`;

        const ctx = cvs.getContext('2d');
        if (!ctx || cancelled) return;

        ctx.scale(dpr, dpr);

        // pdf.js v5 requires explicit `canvas: null` when passing canvasContext
        const renderTask = page.render({
          canvas: null,
          canvasContext: ctx as unknown as CanvasRenderingContext2D,
          viewport,
        });
        renderTaskRef.current = renderTask;

        await renderTask.promise;

        if (!cancelled) {
          setRendering(false);
          renderTaskRef.current = null;
        }
      } catch (err: unknown) {
        if (!cancelled) {
          const isCancel =
            err instanceof Error && err.name === 'RenderingCancelledException';
          if (!isCancel) {
            console.error('PdfViewer: Render error', err);
            setRendering(false);
          }
        }
      }
    }

    render();

    return () => {
      cancelled = true;
      if (renderTaskRef.current) {
        try {
          renderTaskRef.current.cancel();
        } catch {
          /* noop */
        }
        renderTaskRef.current = null;
      }
    };
    // resizeTrigger forces a re-render when the container is resized in fit modes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pdfDoc, currentPage, zoomLevel, zoomMode, resizeTrigger]);

  // Keep page input in sync with navigation
  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  // ---------------------------------------------------------------------------
  // Navigation handlers
  // ---------------------------------------------------------------------------
  const goToPrevPage = useCallback(() => {
    setCurrentPage((p) => Math.max(1, p - 1));
  }, []);

  const goToNextPage = useCallback(() => {
    setCurrentPage((p) => Math.min(totalPages, p + 1));
  }, [totalPages]);

  const handlePageInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setPageInput(e.target.value);
    },
    [],
  );

  const commitPageInput = useCallback(() => {
    const num = parseInt(pageInput, 10);
    if (!isNaN(num) && num >= 1 && num <= totalPages) {
      setCurrentPage(num);
    } else {
      setPageInput(String(currentPage));
    }
  }, [pageInput, totalPages, currentPage]);

  const handlePageInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        commitPageInput();
        (e.target as HTMLInputElement).blur();
      }
    },
    [commitPageInput],
  );

  // ---------------------------------------------------------------------------
  // Zoom handlers
  // ---------------------------------------------------------------------------
  const handleZoomIn = useCallback(() => {
    const current = displayZoomPercent / 100;
    const newZoom = Math.min(
      Math.round((current + ZOOM_STEP) * 100) / 100,
      MAX_ZOOM,
    );
    setZoomLevel(newZoom);
    setZoomMode('custom');
  }, [displayZoomPercent]);

  const handleZoomOut = useCallback(() => {
    const current = displayZoomPercent / 100;
    const newZoom = Math.max(
      Math.round((current - ZOOM_STEP) * 100) / 100,
      MIN_ZOOM,
    );
    setZoomLevel(newZoom);
    setZoomMode('custom');
  }, [displayZoomPercent]);

  const handleFitWidth = useCallback(() => {
    setZoomMode('fit-width');
  }, []);

  const handleFitPage = useCallback(() => {
    setZoomMode('fit-page');
  }, []);

  // ---------------------------------------------------------------------------
  // Loading state — shown before the PDF document is ready
  // ---------------------------------------------------------------------------
  if (loading) {
    return (
      <div className="pdf-viewer">
        <div className="pdf-viewer__loading">
          <div className="pdf-viewer__spinner" />
          <span>Loading PDF…</span>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Error state
  // ---------------------------------------------------------------------------
  if (error) {
    return (
      <div className="pdf-viewer">
        <div className="pdf-viewer__error">
          <span className="pdf-viewer__error-icon">⚠️</span>
          <span>{error}</span>
        </div>
      </div>
    );
  }

  // ---------------------------------------------------------------------------
  // Full viewer with toolbar + canvas
  // ---------------------------------------------------------------------------
  return (
    <div className="pdf-viewer">
      {/* Toolbar */}
      <div className="pdf-viewer__toolbar">
        <div className="pdf-viewer__nav">
          <button
            className="pdf-viewer__btn"
            onClick={goToPrevPage}
            disabled={currentPage <= 1}
            title="Previous page"
          >
            ◀
          </button>
          <span className="pdf-viewer__page-info">
            Page{' '}
            <input
              className="pdf-viewer__page-input"
              type="number"
              min={1}
              max={totalPages}
              value={pageInput}
              onChange={handlePageInputChange}
              onBlur={commitPageInput}
              onKeyDown={handlePageInputKeyDown}
            />{' '}
            of {totalPages}
          </span>
          <button
            className="pdf-viewer__btn"
            onClick={goToNextPage}
            disabled={currentPage >= totalPages}
            title="Next page"
          >
            ▶
          </button>
        </div>

        <div className="pdf-viewer__toolbar-divider" />

        <div className="pdf-viewer__zoom">
          <button
            className="pdf-viewer__btn"
            onClick={handleZoomOut}
            disabled={displayZoomPercent <= MIN_ZOOM * 100}
            title="Zoom out"
          >
            −
          </button>
          <span className="pdf-viewer__zoom-level">{displayZoomPercent}%</span>
          <button
            className="pdf-viewer__btn"
            onClick={handleZoomIn}
            disabled={displayZoomPercent >= MAX_ZOOM * 100}
            title="Zoom in"
          >
            +
          </button>
          <button
            className={`pdf-viewer__btn${zoomMode === 'fit-width' ? ' pdf-viewer__btn--active' : ''}`}
            onClick={handleFitWidth}
            title="Fit width"
          >
            Fit W
          </button>
          <button
            className={`pdf-viewer__btn${zoomMode === 'fit-page' ? ' pdf-viewer__btn--active' : ''}`}
            onClick={handleFitPage}
            title="Fit page"
          >
            Fit P
          </button>
        </div>
      </div>

      {/* Scrollable canvas area */}
      <div className="pdf-viewer__content" ref={containerRef}>
        {rendering && (
          <div className="pdf-viewer__rendering-indicator">
            <div className="pdf-viewer__spinner pdf-viewer__spinner--small" />
          </div>
        )}
        <canvas ref={canvasRef} className="pdf-viewer__canvas" />
      </div>
    </div>
  );
}

export default PdfViewer;
