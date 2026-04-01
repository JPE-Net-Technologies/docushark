import { useState, useRef, useCallback, useEffect } from 'react';
import './ImageViewer.css';

export interface ImageViewerProps {
  blobUrl: string;
  fileName: string;
}

const ZOOM_STEP = 0.25;
const MIN_ZOOM = 0.1;
const MAX_ZOOM = 8;

export function ImageViewer({ blobUrl, fileName: _fileName }: ImageViewerProps) {
  const [zoom, setZoom] = useState<number | 'fit'>('fit');
  const [naturalSize, setNaturalSize] = useState<{ w: number; h: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const dragStartRef = useRef({ x: 0, y: 0, ox: 0, oy: 0 });
  const containerRef = useRef<HTMLDivElement>(null);

  // Reset offset when zoom changes
  useEffect(() => {
    setOffset({ x: 0, y: 0 });
  }, [zoom]);

  const handleImageLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setNaturalSize({ w: img.naturalWidth, h: img.naturalHeight });
  }, []);

  const zoomIn = useCallback(() => {
    setZoom((prev) => {
      const current = prev === 'fit' ? 1 : prev;
      return Math.min(current + ZOOM_STEP, MAX_ZOOM);
    });
  }, []);

  const zoomOut = useCallback(() => {
    setZoom((prev) => {
      const current = prev === 'fit' ? 1 : prev;
      return Math.max(current - ZOOM_STEP, MIN_ZOOM);
    });
  }, []);

  const setFit = useCallback(() => setZoom('fit'), []);
  const set100 = useCallback(() => setZoom(1), []);

  const isPannable = zoom !== 'fit';

  const handlePointerDown = useCallback(
    (e: React.PointerEvent) => {
      if (!isPannable) return;
      setDragging(true);
      dragStartRef.current = { x: e.clientX, y: e.clientY, ox: offset.x, oy: offset.y };
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
    },
    [isPannable, offset]
  );

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - dragStartRef.current.x;
      const dy = e.clientY - dragStartRef.current.y;
      setOffset({ x: dragStartRef.current.ox + dx, y: dragStartRef.current.oy + dy });
    },
    [dragging]
  );

  const handlePointerUp = useCallback(
    (e: React.PointerEvent) => {
      if (!dragging) return;
      setDragging(false);
      (e.target as HTMLElement).releasePointerCapture(e.pointerId);
    },
    [dragging]
  );

  const zoomPercent = zoom === 'fit' ? 'Fit' : `${Math.round(zoom * 100)}%`;

  const imageStyle: React.CSSProperties =
    zoom === 'fit'
      ? { maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' as const }
      : {
          transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})`,
          transformOrigin: 'center center',
          maxWidth: 'none',
          maxHeight: 'none',
        };

  return (
    <div className="image-viewer">
      <div className="image-viewer-toolbar">
        <div className="image-viewer-toolbar-group">
          <button
            className={`image-viewer-btn${zoom === 'fit' ? ' active' : ''}`}
            onClick={setFit}
            title="Fit to view"
          >
            Fit
          </button>
          <button
            className={`image-viewer-btn${zoom === 1 ? ' active' : ''}`}
            onClick={set100}
            title="Actual size"
          >
            100%
          </button>
          <button className="image-viewer-btn" onClick={zoomOut} title="Zoom out">
            −
          </button>
          <span className="image-viewer-zoom-label">{zoomPercent}</span>
          <button className="image-viewer-btn" onClick={zoomIn} title="Zoom in">
            +
          </button>
        </div>
        {naturalSize && (
          <span className="image-viewer-dimensions">
            {naturalSize.w} × {naturalSize.h}
          </span>
        )}
      </div>
      <div
        ref={containerRef}
        className={`image-viewer-container${isPannable ? ' pannable' : ''}${dragging ? ' dragging' : ''}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
      >
        <img
          src={blobUrl}
          alt={_fileName}
          style={imageStyle}
          onLoad={handleImageLoad}
          draggable={false}
        />
      </div>
    </div>
  );
}

export default ImageViewer;
