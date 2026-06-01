/**
 * CanvasToolbar — the canvas-editing toolbar, rendered inside the canvas region
 * (not the app-wide top bar). Holds the drawing tools, shape/custom pickers,
 * file import, rebuild-connectors, undo/redo, and the canvas page tabs.
 *
 * Living inside the canvas region means it hides with the canvas in Relaxed
 * `write` focus (no app-wide leak) and `flex-wrap`s downward in the narrow
 * Relaxed `split` pane instead of overflowing horizontally.
 */

import { useState } from 'react';
import { useSessionStore, type ToolType } from '../store/sessionStore';
import { useHistoryStore } from '../store/historyStore';
import { ShapePicker } from './ShapePicker';
import { CustomShapePicker } from './CustomShapePicker';
import { FileImportButton } from './FileImportButton';
import { InlinePageTabs } from './InlinePageTabs';
import type { ImportContext } from '../services/FileImportService';
import './CanvasToolbar.css';

/** Tool definition. */
interface ToolDef {
  type: ToolType;
  name: string;
  icon: string;
  shortcut: string;
}

/** Available drawing tools. */
const TOOLS: ToolDef[] = [
  { type: 'select', name: 'Select', icon: '↗', shortcut: 'V' },
  { type: 'pan', name: 'Pan', icon: '✋', shortcut: 'H' },
  { type: 'rectangle', name: 'Rectangle', icon: '▭', shortcut: 'R' },
  { type: 'ellipse', name: 'Ellipse', icon: '◯', shortcut: 'O' },
  { type: 'line', name: 'Line', icon: '╱', shortcut: 'L' },
  { type: 'connector', name: 'Connector', icon: '⟷', shortcut: 'C' },
  { type: 'text', name: 'Text', icon: 'T', shortcut: 'T' },
];

/** Compact tool button with hover tooltip. */
function ToolButton({
  tool,
  isActive,
  onClick,
}: {
  tool: ToolDef;
  isActive: boolean;
  onClick: () => void;
}) {
  const [showTooltip, setShowTooltip] = useState(false);

  return (
    <div className="tool-button-wrapper">
      <button
        className={`tool-button ${isActive ? 'active' : ''}`}
        onClick={onClick}
        onMouseEnter={() => setShowTooltip(true)}
        onMouseLeave={() => setShowTooltip(false)}
        aria-label={`${tool.name} (${tool.shortcut})`}
      >
        <span className="tool-button-icon">{tool.icon}</span>
      </button>
      {showTooltip && (
        <div className="tool-button-tooltip">
          {tool.name}
          <span className="tool-button-tooltip-shortcut">{tool.shortcut}</span>
        </div>
      )}
    </div>
  );
}

interface CanvasToolbarProps {
  onRebuildConnectors?: () => void;
  getImportContext?: () => ImportContext | null;
}

export function CanvasToolbar({ onRebuildConnectors, getImportContext }: CanvasToolbarProps) {
  const activeTool = useSessionStore((state) => state.activeTool);
  const setActiveTool = useSessionStore((state) => state.setActiveTool);

  // Subscribe to history state for undo/redo button updates
  const pageHistory = useHistoryStore((state) => state.pageHistory);
  const activeHistoryPage = useHistoryStore((state) => state.activePageId);
  const canUndo = useHistoryStore((state) => state.canUndo);
  const canRedo = useHistoryStore((state) => state.canRedo);
  const undo = useHistoryStore((state) => state.undo);
  const redo = useHistoryStore((state) => state.redo);
  const getUndoDescription = useHistoryStore((state) => state.getUndoDescription);
  const getRedoDescription = useHistoryStore((state) => state.getRedoDescription);

  // Derive descriptions reactively (pageHistory triggers re-render)
  const _ph = pageHistory; const _ap = activeHistoryPage; // ensure subscription
  void _ph; void _ap;
  const undoDesc = getUndoDescription();
  const redoDesc = getRedoDescription();
  const undoTitle = undoDesc ? `Undo: ${undoDesc} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
  const redoTitle = redoDesc ? `Redo: ${redoDesc} (Ctrl+Y)` : 'Redo (Ctrl+Y)';

  return (
    <div className="canvas-toolbar">
      <div className="tool-buttons">
        {TOOLS.map((tool) => (
          <ToolButton
            key={tool.type}
            tool={tool}
            isActive={activeTool === tool.type}
            onClick={() => setActiveTool(tool.type)}
          />
        ))}
        <ShapePicker />
        <CustomShapePicker />
        {getImportContext && <FileImportButton getImportContext={getImportContext} />}
      </div>

      {onRebuildConnectors && (
        <>
          <div className="toolbar-divider" />
          <button
            className="toolbar-rebuild-btn"
            onClick={onRebuildConnectors}
            title="Rebuild all connector routes"
          >
            ⟳
          </button>
        </>
      )}

      <div className="toolbar-divider" />
      <button
        className="toolbar-action-btn"
        onClick={undo}
        disabled={!canUndo()}
        title={undoTitle}
        aria-label={undoTitle}
      >
        <UndoIcon />
      </button>
      <button
        className="toolbar-action-btn"
        onClick={redo}
        disabled={!canRedo()}
        title={redoTitle}
        aria-label={redoTitle}
      >
        <RedoIcon />
      </button>

      <div className="toolbar-divider" />
      <InlinePageTabs />
    </div>
  );
}

export default CanvasToolbar;

// Icon components for undo/redo buttons
function UndoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 6h7a4 4 0 0 1 0 8H8" />
      <path d="M6 3L3 6l3 3" />
    </svg>
  );
}

function RedoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 6H6a4 4 0 0 0 0 8h2" />
      <path d="M10 3l3 3-3 3" />
    </svg>
  );
}
