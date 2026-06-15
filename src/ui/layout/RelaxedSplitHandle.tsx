/**
 * RelaxedSplitHandle — draggable divider between the prose editor and the
 * secondary canvas in the Relaxed `split` focus. Lives on the left edge of the
 * canvas pane; dragging resizes the prose editor (the canvas takes a fixed
 * width, the prose flexes to fill the rest). Width persists app-level in
 * `uiPreferencesStore.relaxedSplitCanvasWidth`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import './resizeHandle.css';

const MIN_CANVAS = 280;
const MAX_CANVAS = 960;
const DEFAULT_CANVAS = 480;
/** Keyboard nudge step for arrow-key resizing (px). */
const KEY_STEP = 16;

const clampCanvas = (w: number) => Math.max(MIN_CANVAS, Math.min(MAX_CANVAS, w));

export function RelaxedSplitHandle() {
  const width = useUIPreferencesStore((s) => s.relaxedSplitCanvasWidth);
  const setWidth = useUIPreferencesStore((s) => s.setRelaxedSplitCanvasWidth);
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      setIsDragging(true);
    },
    [width]
  );

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      // Canvas is docked right: dragging left (smaller clientX) widens it.
      const delta = startXRef.current - e.clientX;
      setWidth(clampCanvas(startWidthRef.current + delta));
    };
    const handleUp = () => setIsDragging(false);
    document.addEventListener('mousemove', handleMove);
    document.addEventListener('mouseup', handleUp);
    document.body.style.cursor = 'ew-resize';
    document.body.style.userSelect = 'none';
    return () => {
      document.removeEventListener('mousemove', handleMove);
      document.removeEventListener('mouseup', handleUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging, setWidth]);

  // Double-click resets the split to the default canvas width.
  const handleDoubleClick = useCallback(() => {
    setWidth(DEFAULT_CANVAS);
  }, [setWidth]);

  // Keyboard resize (a11y). Canvas is docked right, so ArrowLeft widens it
  // (and narrows the prose), matching the leftward drag.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let next: number | null = null;
      if (e.key === 'ArrowLeft') next = width + KEY_STEP;
      else if (e.key === 'ArrowRight') next = width - KEY_STEP;
      else if (e.key === 'Home') next = MIN_CANVAS;
      else if (e.key === 'End') next = MAX_CANVAS;
      if (next === null) return;
      e.preventDefault();
      setWidth(clampCanvas(next));
    },
    [width, setWidth]
  );

  return (
    <div
      className={`resize-handle resize-handle--edge-left ${isDragging ? 'dragging' : ''}`}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize prose editor"
      aria-valuenow={Math.round(width)}
      aria-valuemin={MIN_CANVAS}
      aria-valuemax={MAX_CANVAS}
      tabIndex={0}
    >
      <span className="resize-handle-grip" aria-hidden="true" />
    </div>
  );
}
