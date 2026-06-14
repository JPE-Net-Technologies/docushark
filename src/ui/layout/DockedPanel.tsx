/**
 * DockedPanel — generic resizable wrapper used for the Document panel in
 * Phase A (Properties stays inside FlyoutPanel for fly-out layouts and
 * docks via PropertyPanel's own width logic for Power).
 *
 * Reads the active panel's width from the store, clamps to min/max, and
 * writes drag-induced width changes back via the layout actions hook.
 */

import { ReactNode, useCallback, useEffect, useRef, useState } from 'react';
import { useActivePanelState, useActiveLayoutMode } from './useLayout';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';
import type { PanelId } from './types';
import './DockedPanel.css';
import './resizeHandle.css';

const DEFAULT_MIN = 200;
const DEFAULT_MAX = 600;
/** Keyboard nudge step for arrow-key resizing (px). */
const KEY_STEP = 16;

interface DockedPanelProps {
  panelId: PanelId;
  side: 'left' | 'right';
  defaultWidth?: number;
  minWidth?: number;
  maxWidth?: number;
  children: ReactNode;
}

export function DockedPanel({
  panelId,
  side,
  defaultWidth = 320,
  minWidth = DEFAULT_MIN,
  maxWidth = DEFAULT_MAX,
  children,
}: DockedPanelProps) {
  const state = useActivePanelState(panelId);
  const mode = useActiveLayoutMode();
  const setPanelWidthFor = useUIPreferencesStore((s) => s.setPanelWidthFor);

  const width = state.width ?? defaultWidth;
  const [isDragging, setIsDragging] = useState(false);
  const startXRef = useRef(0);
  const startWidthRef = useRef(width);
  const containerRef = useRef<HTMLDivElement>(null);

  const clampWidth = useCallback(
    (w: number) => Math.max(minWidth, Math.min(maxWidth, w)),
    [minWidth, maxWidth]
  );

  const handleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      startXRef.current = e.clientX;
      startWidthRef.current = width;
      setIsDragging(true);
    },
    [width]
  );

  // Double-click the divider resets the panel to its default width.
  const handleDoubleClick = useCallback(() => {
    setPanelWidthFor(mode, panelId, clampWidth(defaultWidth));
  }, [setPanelWidthFor, mode, panelId, clampWidth, defaultWidth]);

  // Keyboard resize for the separator (a11y). Arrow direction follows the
  // visual edge: on a left-docked panel ArrowRight grows it; on a right-docked
  // panel ArrowRight shrinks it.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const grow = side === 'left' ? 1 : -1;
      let next: number | null = null;
      if (e.key === 'ArrowRight') next = width + grow * KEY_STEP;
      else if (e.key === 'ArrowLeft') next = width - grow * KEY_STEP;
      else if (e.key === 'Home') next = minWidth;
      else if (e.key === 'End') next = maxWidth;
      if (next === null) return;
      e.preventDefault();
      setPanelWidthFor(mode, panelId, clampWidth(next));
    },
    [side, width, minWidth, maxWidth, setPanelWidthFor, mode, panelId, clampWidth]
  );

  useEffect(() => {
    if (!isDragging) return;
    const handleMove = (e: MouseEvent) => {
      const delta = side === 'right' ? startXRef.current - e.clientX : e.clientX - startXRef.current;
      const next = Math.max(minWidth, Math.min(maxWidth, startWidthRef.current + delta));
      setPanelWidthFor(mode, panelId, next);
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
  }, [isDragging, mode, panelId, side, minWidth, maxWidth, setPanelWidthFor]);

  return (
    <div
      ref={containerRef}
      className={`docked-panel docked-panel-${side}`}
      style={{ width, flex: `0 0 ${width}px` }}
    >
      {children}
      <div
        className={`resize-handle resize-handle--edge-${side === 'left' ? 'right' : 'left'} ${
          isDragging ? 'dragging' : ''
        }`}
        onMouseDown={handleMouseDown}
        onDoubleClick={handleDoubleClick}
        onKeyDown={handleKeyDown}
        role="separator"
        aria-orientation="vertical"
        aria-label="Resize panel"
        aria-valuenow={Math.round(width)}
        aria-valuemin={minWidth}
        aria-valuemax={maxWidth}
        tabIndex={0}
      >
        <span className="resize-handle-grip" aria-hidden="true" />
      </div>
    </div>
  );
}
