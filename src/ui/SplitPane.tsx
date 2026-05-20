/**
 * SplitPane - Resizable split container with draggable divider.
 *
 * Features:
 * - Horizontal split with left (document editor) and right (canvas) panes
 * - Draggable divider with visual feedback
 * - Min/max width constraints
 * - Collapse/expand button to toggle left panel visibility
 * - Persists width preference in localStorage
 */

import { useState, useRef, useCallback, useEffect, ReactNode } from 'react';
import './SplitPane.css';

const STORAGE_KEY = 'docushark-split-pane-width';
const MIN_WIDTH = 200;
const MAX_WIDTH = 600;
const DEFAULT_WIDTH = 320;

export interface SplitPaneProps {
  /** Left panel content (document editor) */
  leftPanel: ReactNode;
  /** Right panel content (canvas) */
  rightPanel: ReactNode;
  /** Controlled collapsed state (overrides internal state if provided) */
  collapsed?: boolean;
  /** Whether the left panel is initially collapsed (used when uncontrolled) */
  defaultCollapsed?: boolean;
  /** Callback when collapse state changes */
  onCollapseChange?: (collapsed: boolean) => void;
}

export function SplitPane({
  leftPanel,
  rightPanel,
  collapsed: controlledCollapsed,
  defaultCollapsed = false,
  onCollapseChange,
}: SplitPaneProps) {
  // Load saved width from localStorage
  const getSavedWidth = () => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      if (saved) {
        const width = parseInt(saved, 10);
        if (width >= MIN_WIDTH && width <= MAX_WIDTH) {
          return width;
        }
      }
    } catch {
      // Ignore localStorage errors
    }
    return DEFAULT_WIDTH;
  };

  const [leftWidth, setLeftWidth] = useState(getSavedWidth);
  const [internalCollapsed, setInternalCollapsed] = useState(defaultCollapsed);
  const [isDragging, setIsDragging] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Use controlled state if provided, otherwise use internal state
  const isCollapsed = controlledCollapsed ?? internalCollapsed;
  const setIsCollapsed = (value: boolean) => {
    if (controlledCollapsed === undefined) {
      setInternalCollapsed(value);
    }
    // Always notify parent of change
    onCollapseChange?.(value);
  };

  // Save width to localStorage when changed
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(leftWidth));
    } catch {
      // Ignore localStorage errors
    }
  }, [leftWidth]);

  // Handle collapse toggle
  const handleToggleCollapse = useCallback(() => {
    setIsCollapsed(!isCollapsed);
  }, [isCollapsed]);

  // Handle drag start
  const handleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
  }, []);

  // Handle drag
  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMove = (e: MouseEvent) => {
      if (!containerRef.current) return;

      const containerRect = containerRef.current.getBoundingClientRect();
      const newWidth = e.clientX - containerRect.left;

      // Clamp to min/max
      const clampedWidth = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, newWidth));
      setLeftWidth(clampedWidth);
    };

    const handleMouseUp = () => {
      setIsDragging(false);
    };

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  // Add cursor style while dragging
  useEffect(() => {
    if (isDragging) {
      document.body.style.cursor = 'ew-resize';
      document.body.style.userSelect = 'none';
    } else {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }

    return () => {
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isDragging]);

  return (
    <div
      ref={containerRef}
      className={`split-pane ${isCollapsed ? 'collapsed' : ''}`}
    >
      {/* Left panel */}
      {!isCollapsed && (
        <div className="split-pane-left" style={{ width: leftWidth }}>
          {leftPanel}
        </div>
      )}

      {/* Divider */}
      {!isCollapsed && (
        <div
          className={`split-pane-divider ${isDragging ? 'dragging' : ''}`}
          onMouseDown={handleMouseDown}
        />
      )}

      {/* Expand button when collapsed */}
      {isCollapsed && (
        <button
          className="split-pane-expand"
          onClick={handleToggleCollapse}
          title="Show document editor"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="currentColor">
            <path d="M4.646 1.646a.5.5 0 0 1 .708 0l6 6a.5.5 0 0 1 0 .708l-6 6a.5.5 0 0 1-.708-.708L10.293 8 4.646 2.354a.5.5 0 0 1 0-.708z" />
          </svg>
        </button>
      )}

      {/* Right panel */}
      <div className="split-pane-right">{rightPanel}</div>
    </div>
  );
}

/**
 * Export collapse handler type for use in parent components.
 */
export type SplitPaneCollapseHandler = () => void;
