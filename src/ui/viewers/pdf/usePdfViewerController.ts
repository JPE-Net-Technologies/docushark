/**
 * usePdfViewerController — owns the pdf.js viewer-components lifecycle
 * (EventBus + PDFLinkService + PDFFindController + PDFViewer) behind a small
 * React-friendly controller, so the presentational shell (PdfViewer.tsx) and
 * its toolbar/sidebar/find-bar stay free of pdf.js specifics.
 *
 * Lifecycle contract:
 * - Mount effect builds the component graph against the container/viewer divs
 *   and tears it down symmetrically (StrictMode double-mount safe).
 * - Document effect (keyed on blobUrl) loads via getDocument and hands the doc
 *   to the viewer + link service; cleanup unbinds and destroys the loading
 *   task. The blob URL is owned by the blobResolver cache — never revoked here.
 * - Continuous scroll, page virtualization, and the text/annotation layers all
 *   come from PDFViewer itself; this hook only surfaces state (page, zoom,
 *   find matches, outline) and imperative actions.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import {
  EventBus,
  FindState,
  PDFFindController,
  PDFLinkService,
  PDFViewer,
} from 'pdfjs-dist/web/pdf_viewer.mjs';
import { clampPage, nextZoomIn, nextZoomOut } from './zoom';

// Configure pdf.js worker — same idiom as ThumbnailGenerator.ts.
if (!pdfjsLib.GlobalWorkerOptions.workerSrc) {
  pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
    'pdfjs-dist/build/pdf.worker.min.mjs',
    import.meta.url,
  ).toString();
}

export type PdfFitMode = 'page-width' | 'page-fit';
export type PdfZoomMode = PdfFitMode | 'custom';

export interface PdfOutlineNode {
  title: string;
  dest: unknown;
  items: PdfOutlineNode[];
}

export interface PdfMatchesCount {
  current: number;
  total: number;
}

export interface PdfFindRequest {
  query: string;
  highlightAll: boolean;
  /** Re-run the previous query (Enter / next-match). */
  again?: boolean;
  /** Search backwards (Shift+Enter / previous-match). */
  previous?: boolean;
}

export interface PdfViewerController {
  /** Attach to the scroll container (absolutely-positioned). */
  containerRef: React.RefObject<HTMLDivElement>;
  /** Attach to the inner `<div class="pdfViewer">` element. */
  viewerRef: React.RefObject<HTMLDivElement>;

  loading: boolean;
  error: string | null;
  currentPage: number;
  numPages: number;
  zoomPercent: number;
  zoomMode: PdfZoomMode;
  outline: PdfOutlineNode[] | null;
  findMatches: PdfMatchesCount | null;
  findNotFound: boolean;

  goToPage(page: number): void;
  zoomIn(): void;
  zoomOut(): void;
  setFitMode(mode: PdfFitMode): void;
  goToDestination(dest: unknown): void;
  find(request: PdfFindRequest): void;
  /** Clear find highlights (find bar closed). */
  closeFind(): void;
  /** Live document proxy for metadata/text consumers; null while loading. */
  getDocument(): PDFDocumentProxy | null;
}

interface ViewerParts {
  eventBus: EventBus;
  linkService: PDFLinkService;
  findController: PDFFindController;
  viewer: PDFViewer;
}

/** Shapes of the eventBus payloads this hook consumes. */
interface PageChangingEvent {
  pageNumber: number;
}
interface ScaleChangingEvent {
  scale: number;
  presetValue?: string | undefined;
}
interface FindMatchesCountEvent {
  matchesCount: PdfMatchesCount;
}
interface FindControlStateEvent {
  state: number;
  matchesCount: PdfMatchesCount;
}

const DEFAULT_FIT_MODE: PdfFitMode = 'page-width';

/** Wheel deltas accumulate to this threshold before a zoom step fires. */
const WHEEL_ZOOM_THRESHOLD = 50;

export function usePdfViewerController(blobUrl: string): PdfViewerController {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<HTMLDivElement>(null);
  const partsRef = useRef<ViewerParts | null>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [currentPage, setCurrentPage] = useState(1);
  const [numPages, setNumPages] = useState(0);
  const [zoomPercent, setZoomPercent] = useState(100);
  const [zoomMode, setZoomMode] = useState<PdfZoomMode>(DEFAULT_FIT_MODE);
  const [outline, setOutline] = useState<PdfOutlineNode[] | null>(null);
  const [findMatches, setFindMatches] = useState<PdfMatchesCount | null>(null);
  const [findNotFound, setFindNotFound] = useState(false);

  // Listener-visible mirrors (event handlers must not close over stale state).
  const zoomModeRef = useRef<PdfZoomMode>(DEFAULT_FIT_MODE);
  const fitModeRef = useRef<PdfFitMode>(DEFAULT_FIT_MODE);

  // -------------------------------------------------------------------------
  // Component graph lifecycle
  // -------------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    const viewerEl = viewerRef.current;
    if (!container || !viewerEl) return;

    const eventBus = new EventBus();
    const linkService = new PDFLinkService({ eventBus });
    const findController = new PDFFindController({ eventBus, linkService });
    const viewer = new PDFViewer({
      container,
      viewer: viewerEl,
      eventBus,
      linkService,
      findController,
    });
    linkService.setViewer(viewer);

    const onPagesInit = () => {
      // Apply the active fit mode once the pages exist; if the user had
      // switched to a custom zoom before a reload, fall back to the last fit.
      viewer.currentScaleValue =
        zoomModeRef.current === 'custom' ? fitModeRef.current : zoomModeRef.current;
    };
    const onPageChanging = (evt: PageChangingEvent) => {
      setCurrentPage(evt.pageNumber);
    };
    const onScaleChanging = (evt: ScaleChangingEvent) => {
      setZoomPercent(Math.round(evt.scale * 100));
      const preset = evt.presetValue;
      const mode: PdfZoomMode =
        preset === 'page-width' || preset === 'page-fit' ? preset : 'custom';
      zoomModeRef.current = mode;
      if (mode !== 'custom') fitModeRef.current = mode;
      setZoomMode(mode);
    };
    const onMatchesCount = (evt: FindMatchesCountEvent) => {
      setFindMatches(evt.matchesCount);
    };
    const onFindControlState = (evt: FindControlStateEvent) => {
      setFindNotFound(evt.state === FindState.NOT_FOUND);
      setFindMatches(evt.matchesCount);
    };

    eventBus.on('pagesinit', onPagesInit);
    eventBus.on('pagechanging', onPageChanging as (evt: object) => void);
    eventBus.on('scalechanging', onScaleChanging as (evt: object) => void);
    eventBus.on('updatefindmatchescount', onMatchesCount as (evt: object) => void);
    eventBus.on('updatefindcontrolstate', onFindControlState as (evt: object) => void);

    partsRef.current = { eventBus, linkService, findController, viewer };

    return () => {
      eventBus.off('pagesinit', onPagesInit);
      eventBus.off('pagechanging', onPageChanging as (evt: object) => void);
      eventBus.off('scalechanging', onScaleChanging as (evt: object) => void);
      eventBus.off('updatefindmatchescount', onMatchesCount as (evt: object) => void);
      eventBus.off('updatefindcontrolstate', onFindControlState as (evt: object) => void);
      partsRef.current = null;
    };
  }, []);

  // -------------------------------------------------------------------------
  // Document load (keyed on the resolver-owned blob URL)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const parts = partsRef.current;
    if (!parts) return;

    let cancelled = false;
    setLoading(true);
    setError(null);
    setOutline(null);
    setFindMatches(null);
    setFindNotFound(false);

    const loadingTask = pdfjsLib.getDocument(blobUrl);

    loadingTask.promise
      .then((doc) => {
        if (cancelled) return;
        docRef.current = doc;
        parts.viewer.setDocument(doc);
        parts.linkService.setDocument(doc, null);
        setNumPages(doc.numPages);
        setCurrentPage(1);
        setLoading(false);
        doc
          .getOutline()
          .then((items: PdfOutlineNode[] | null) => {
            if (!cancelled) setOutline(items ?? null);
          })
          .catch(() => {
            if (!cancelled) setOutline(null);
          });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        console.error('PdfViewer: Failed to load PDF', err);
        setError('Failed to load PDF. The file may be corrupt or not a valid PDF.');
        setLoading(false);
      });

    return () => {
      cancelled = true;
      docRef.current = null;
      const current = partsRef.current;
      if (current) {
        current.viewer.setDocument(null as unknown as PDFDocumentProxy);
        current.linkService.setDocument(null, null);
      }
      // destroy() tears down the worker task and the document proxy together.
      void loadingTask.destroy().catch(() => undefined);
    };
  }, [blobUrl]);

  // -------------------------------------------------------------------------
  // Refit on container resize (modal resize, sidebar toggle, window resize)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let frame: number | null = null;
    const observer = new ResizeObserver(() => {
      if (frame !== null) cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = null;
        const parts = partsRef.current;
        const mode = zoomModeRef.current;
        if (!parts || !parts.viewer.pdfDocument || mode === 'custom') return;
        parts.viewer.currentScaleValue = mode;
        parts.viewer.update();
      });
    });
    observer.observe(container);

    return () => {
      observer.disconnect();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, []);

  // -------------------------------------------------------------------------
  // Ctrl/Cmd+wheel zoom (reader expectation; keeps browser zoom untouched)
  // -------------------------------------------------------------------------
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let accumulated = 0;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey && !e.metaKey) return;
      e.preventDefault();
      const parts = partsRef.current;
      if (!parts || !parts.viewer.pdfDocument) return;
      accumulated += e.deltaY;
      if (Math.abs(accumulated) < WHEEL_ZOOM_THRESHOLD) return;
      const zoomingIn = accumulated < 0;
      accumulated = 0;
      const next = zoomingIn
        ? nextZoomIn(parts.viewer.currentScale)
        : nextZoomOut(parts.viewer.currentScale);
      parts.viewer.currentScale = next;
    };

    container.addEventListener('wheel', onWheel, { passive: false });
    return () => container.removeEventListener('wheel', onWheel);
  }, []);

  // -------------------------------------------------------------------------
  // Imperative actions
  // -------------------------------------------------------------------------
  const goToPage = useCallback((page: number) => {
    const parts = partsRef.current;
    if (!parts || !parts.viewer.pdfDocument) return;
    parts.viewer.currentPageNumber = clampPage(page, parts.viewer.pagesCount);
  }, []);

  const zoomIn = useCallback(() => {
    const parts = partsRef.current;
    if (!parts || !parts.viewer.pdfDocument) return;
    parts.viewer.currentScale = nextZoomIn(parts.viewer.currentScale);
  }, []);

  const zoomOut = useCallback(() => {
    const parts = partsRef.current;
    if (!parts || !parts.viewer.pdfDocument) return;
    parts.viewer.currentScale = nextZoomOut(parts.viewer.currentScale);
  }, []);

  const setFitMode = useCallback((mode: PdfFitMode) => {
    const parts = partsRef.current;
    if (!parts || !parts.viewer.pdfDocument) return;
    fitModeRef.current = mode;
    parts.viewer.currentScaleValue = mode;
  }, []);

  const goToDestination = useCallback((dest: unknown) => {
    const parts = partsRef.current;
    if (!parts || dest == null) return;
    void parts.linkService.goToDestination(dest as string | unknown[]);
  }, []);

  const find = useCallback((request: PdfFindRequest) => {
    const parts = partsRef.current;
    if (!parts) return;
    parts.eventBus.dispatch('find', {
      source: null,
      type: request.again ? 'again' : '',
      query: request.query,
      caseSensitive: false,
      entireWord: false,
      highlightAll: request.highlightAll,
      findPrevious: request.previous === true,
      matchDiacritics: false,
    });
  }, []);

  const closeFind = useCallback(() => {
    const parts = partsRef.current;
    if (!parts) return;
    parts.eventBus.dispatch('findbarclose', { source: null });
    setFindMatches(null);
    setFindNotFound(false);
  }, []);

  const getDocument = useCallback(() => docRef.current, []);

  return {
    containerRef,
    viewerRef,
    loading,
    error,
    currentPage,
    numPages,
    zoomPercent,
    zoomMode,
    outline,
    findMatches,
    findNotFound,
    goToPage,
    zoomIn,
    zoomOut,
    setFitMode,
    goToDestination,
    find,
    closeFind,
    getDocument,
  };
}
