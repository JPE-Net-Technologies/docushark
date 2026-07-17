/**
 * PdfToolbar — chrome row for the PDF reader: page navigation, zoom controls,
 * find/sidebar/immersive/dim toggles. Pure presentation over the controller.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  ChevronDown,
  ChevronUp,
  Maximize2,
  PanelLeft,
  Search,
  SunDim,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
import { Icon } from '../../icons';
import type { PdfViewerController } from './usePdfViewerController';
import { clampPage } from './zoom';

export interface PdfToolbarProps {
  controller: PdfViewerController;
  showFind: boolean;
  onToggleFind: () => void;
  showSidebar: boolean;
  onToggleSidebar: () => void;
  dimmed: boolean;
  onToggleDimmed: () => void;
  /** Absent when the host doesn't support immersive mode. */
  onEnterImmersive?: (() => void) | undefined;
}

export function PdfToolbar({
  controller,
  showFind,
  onToggleFind,
  showSidebar,
  onToggleSidebar,
  dimmed,
  onToggleDimmed,
  onEnterImmersive,
}: PdfToolbarProps) {
  const { currentPage, numPages, zoomPercent, zoomMode } = controller;
  const [pageInput, setPageInput] = useState(String(currentPage));

  // Keep the input following navigation (scroll, outline jumps, find).
  useEffect(() => {
    setPageInput(String(currentPage));
  }, [currentPage]);

  const commitPageInput = useCallback(() => {
    const num = parseInt(pageInput, 10);
    if (!Number.isNaN(num)) {
      controller.goToPage(clampPage(num, numPages));
    } else {
      setPageInput(String(currentPage));
    }
  }, [pageInput, numPages, currentPage, controller]);

  const handlePageInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        commitPageInput();
        (e.target as HTMLInputElement).blur();
      }
    },
    [commitPageInput],
  );

  return (
    <div className="pdf-reader__toolbar">
      <div className="pdf-reader__toolbar-group">
        <button
          className={`pdf-reader__btn${showSidebar ? ' pdf-reader__btn--active' : ''}`}
          onClick={onToggleSidebar}
          title="Toggle sidebar"
          aria-pressed={showSidebar}
        >
          <Icon icon={PanelLeft} size={16} />
        </button>
        <button
          className={`pdf-reader__btn${showFind ? ' pdf-reader__btn--active' : ''}`}
          onClick={onToggleFind}
          title="Find in document (Ctrl+F)"
          aria-pressed={showFind}
        >
          <Icon icon={Search} size={16} />
        </button>
      </div>

      <div className="pdf-reader__toolbar-divider" />

      <div className="pdf-reader__toolbar-group">
        <button
          className="pdf-reader__btn"
          onClick={() => controller.goToPage(currentPage - 1)}
          disabled={currentPage <= 1}
          title="Previous page"
        >
          <Icon icon={ChevronUp} size={16} />
        </button>
        <span className="pdf-reader__page-info">
          <input
            className="pdf-reader__page-input"
            type="number"
            min={1}
            max={numPages}
            value={pageInput}
            onChange={(e) => setPageInput(e.target.value)}
            onBlur={commitPageInput}
            onKeyDown={handlePageInputKeyDown}
            aria-label="Page number"
          />
          <span className="pdf-reader__page-total">/ {numPages}</span>
        </span>
        <button
          className="pdf-reader__btn"
          onClick={() => controller.goToPage(currentPage + 1)}
          disabled={currentPage >= numPages}
          title="Next page"
        >
          <Icon icon={ChevronDown} size={16} />
        </button>
      </div>

      <div className="pdf-reader__toolbar-divider" />

      <div className="pdf-reader__toolbar-group">
        <button
          className="pdf-reader__btn"
          onClick={controller.zoomOut}
          title="Zoom out"
        >
          <Icon icon={ZoomOut} size={16} />
        </button>
        <span className="pdf-reader__zoom-level">{zoomPercent}%</span>
        <button
          className="pdf-reader__btn"
          onClick={controller.zoomIn}
          title="Zoom in"
        >
          <Icon icon={ZoomIn} size={16} />
        </button>
        <button
          className={`pdf-reader__btn${zoomMode === 'page-width' ? ' pdf-reader__btn--active' : ''}`}
          onClick={() => controller.setFitMode('page-width')}
          title="Fit to width"
        >
          Width
        </button>
        <button
          className={`pdf-reader__btn${zoomMode === 'page-fit' ? ' pdf-reader__btn--active' : ''}`}
          onClick={() => controller.setFitMode('page-fit')}
          title="Fit whole page"
        >
          Page
        </button>
      </div>

      <div className="pdf-reader__toolbar-divider" />

      <div className="pdf-reader__toolbar-group">
        <button
          className={`pdf-reader__btn pdf-reader__dim-btn${dimmed ? ' pdf-reader__btn--active' : ''}`}
          onClick={onToggleDimmed}
          title="Dim pages"
          aria-pressed={dimmed}
        >
          <Icon icon={SunDim} size={16} />
        </button>
        {onEnterImmersive && (
          <button
            className="pdf-reader__btn"
            onClick={onEnterImmersive}
            title="Immersive reading (Escape to exit)"
          >
            <Icon icon={Maximize2} size={16} />
          </button>
        )}
      </div>
    </div>
  );
}
