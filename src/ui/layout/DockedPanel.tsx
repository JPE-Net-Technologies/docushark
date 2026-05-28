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

const DEFAULT_MIN = 200;
const DEFAULT_MAX = 600;

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
        className={`docked-panel-handle docked-panel-handle-${side} ${isDragging ? 'dragging' : ''}`}
        onMouseDown={handleMouseDown}
        role="separator"
        aria-orientation="vertical"
      />
    </div>
  );
}
