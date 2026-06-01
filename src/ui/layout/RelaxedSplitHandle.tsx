/**
 * RelaxedSplitHandle — draggable divider between the prose editor and the
 * secondary canvas in the Relaxed `split` focus. Lives on the left edge of the
 * canvas pane; dragging resizes the prose editor (the canvas takes a fixed
 * width, the prose flexes to fill the rest). Width persists app-level in
 * `uiPreferencesStore.relaxedSplitCanvasWidth`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import './RelaxedSplitHandle.css';

const MIN_CANVAS = 280;
const MAX_CANVAS = 960;

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
      const next = Math.max(MIN_CANVAS, Math.min(MAX_CANVAS, startWidthRef.current + delta));
      setWidth(next);
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

  return (
    <div
      className={`relaxed-split-handle ${isDragging ? 'dragging' : ''}`}
      onMouseDown={handleMouseDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize prose editor"
    />
  );
}
