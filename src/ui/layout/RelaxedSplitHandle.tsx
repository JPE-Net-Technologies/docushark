/**
 * RelaxedSplitHandle — draggable divider between the prose editor and the
 * secondary canvas in the Relaxed `split` focus. Lives on the left edge of the
 * canvas pane; dragging resizes the prose editor (the canvas takes a fixed
 * width, the prose flexes to fill the rest). Width persists app-level in
 * `uiPreferencesStore.relaxedSplitCanvasWidth`.
 *
 * That width is `null` by default — a responsive ~50/50 CSS clamp owns the
 * split until the user drags (or arrow-keys) the divider, which captures a
 * concrete px width. Double-click resets back to the responsive default.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import './resizeHandle.css';

const MIN_CANVAS = 280;
const MAX_CANVAS = 960;
/** aria/fallback width used before the pane has been measured. */
const FALLBACK_CANVAS = 480;
/** Keyboard nudge step for arrow-key resizing (px). */
const KEY_STEP = 16;

const clampCanvas = (w: number) => Math.max(MIN_CANVAS, Math.min(MAX_CANVAS, w));

export function RelaxedSplitHandle() {
  const width = useUIPreferencesStore((s) => s.relaxedSplitCanvasWidth);
  const setWidth = useUIPreferencesStore((s) => s.setRelaxedSplitCanvasWidth);
  const [isDragging, setIsDragging] = useState(false);
  // Live width of the secondary canvas pane (the handle's parent). Tracked so a
  // drag/nudge starting from the responsive (`null`) default seeds from the
  // actual rendered width, and so aria-valuenow stays accurate while responsive.
  const [measuredWidth, setMeasuredWidth] = useState(FALLBACK_CANVAS);
  const handleRef = useRef<HTMLDivElement>(null);
  const startXRef = useRef(0);
  const startWidthRef = useRef(FALLBACK_CANVAS);

  // Keep `measuredWidth` in sync with the pane's rendered width.
  useLayoutEffect(() => {
    const el = handleRef.current?.parentElement;
    if (!el) return;
    const update = () => setMeasuredWidth(el.offsetWidth || FALLBACK_CANVAS);
    update();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Effective width as a number, whether explicit (dragged) or responsive.
  const effectiveWidth = width ?? measuredWidth;

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = effectiveWidth;
      setIsDragging(true);
    },
    [effectiveWidth]
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

  // Double-click resets the split to the responsive ~50/50 default.
  const handleDoubleClick = useCallback(() => {
    setWidth(null);
  }, [setWidth]);

  // Keyboard resize (a11y). Canvas is docked right, so ArrowLeft widens it
  // (and narrows the prose), matching the leftward drag. Nudges from the
  // current effective width, so the first keypress off the responsive default
  // captures a sensible px value.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      let next: number | null = null;
      if (e.key === 'ArrowLeft') next = effectiveWidth + KEY_STEP;
      else if (e.key === 'ArrowRight') next = effectiveWidth - KEY_STEP;
      else if (e.key === 'Home') next = MIN_CANVAS;
      else if (e.key === 'End') next = MAX_CANVAS;
      if (next === null) return;
      e.preventDefault();
      setWidth(clampCanvas(next));
    },
    [effectiveWidth, setWidth]
  );

  return (
    <div
      ref={handleRef}
      className={`resize-handle resize-handle--edge-left ${isDragging ? 'dragging' : ''}`}
      onMouseDown={handleMouseDown}
      onDoubleClick={handleDoubleClick}
      onKeyDown={handleKeyDown}
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize prose editor"
      aria-valuenow={Math.round(effectiveWidth)}
      aria-valuemin={MIN_CANVAS}
      aria-valuemax={MAX_CANVAS}
      tabIndex={0}
    >
      <span className="resize-handle-grip" aria-hidden="true" />
    </div>
  );
}
