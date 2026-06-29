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
import {
  MousePointer2,
  Hand,
  Square,
  Circle,
  Slash,
  Spline,
  Type,
  RefreshCw,
  Undo2,
  Redo2,
  Sticker,
  type LucideIcon,
} from 'lucide-react';
import { useSessionStore, type ToolType } from '../store/sessionStore';
import { useHistoryStore } from '../store/historyStore';
import { useActiveDocReadOnly } from '../store/documentRegistry';
import { useCollaborationStore } from '../collaboration/collaborationStore';
import { createIconShapeAtCenter } from '../engine/CommandRegistry';
import { ShapePicker } from './ShapePicker';
import { IconPicker } from './IconPicker';
import { FileImportButton } from './FileImportButton';
import { InlinePageTabs } from './InlinePageTabs';
import { ConnectorStyleMenu } from './ConnectorStyleMenu';
import type { ImportContext } from '../services/FileImportService';
import { ICON } from './icons';
import { ToolbarGroup } from './ToolbarGroup';
import './CanvasToolbar.css';

/** Tool definition. */
interface ToolDef {
  type: ToolType;
  name: string;
  Icon: LucideIcon;
  shortcut: string;
}

/** Available drawing tools. */
const TOOLS: ToolDef[] = [
  { type: 'select', name: 'Select', Icon: MousePointer2, shortcut: 'V' },
  { type: 'pan', name: 'Pan', Icon: Hand, shortcut: 'H' },
  { type: 'rectangle', name: 'Rectangle', Icon: Square, shortcut: 'R' },
  { type: 'ellipse', name: 'Ellipse', Icon: Circle, shortcut: 'O' },
  { type: 'line', name: 'Line', Icon: Slash, shortcut: 'L' },
  { type: 'connector', name: 'Connector', Icon: Spline, shortcut: 'C' },
  { type: 'text', name: 'Text', Icon: Type, shortcut: 'T' },
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
        <tool.Icon size={ICON.size} strokeWidth={ICON.strokeWidth} />
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
  // JP-370: on a view-only doc the canvas is pan-only — hide the editing tools
  // (drawing, shapes, insert, history) entirely and show a "View only" marker.
  // The relay drops a viewer's writes regardless; this removes the dead UI.
  const isReadOnly = useActiveDocReadOnly();

  // Subscribe to history state for undo/redo button updates
  const pageHistory = useHistoryStore((state) => state.pageHistory);
  const activeHistoryPage = useHistoryStore((state) => state.activePageId);
  const canUndo = useHistoryStore((state) => state.canUndo);
  const canRedo = useHistoryStore((state) => state.canRedo);
  const undo = useHistoryStore((state) => state.undo);
  const redo = useHistoryStore((state) => state.redo);
  const getUndoDescription = useHistoryStore((state) => state.getUndoDescription);
  const getRedoDescription = useHistoryStore((state) => state.getRedoDescription);

  // JP-402: undo/redo now work in a collab session too — backed by a per-user
  // CRDT UndoManager (not snapshot history, which would diverge, JP-178). In collab
  // availability comes from the reactive `canUndoCanvas`/`canRedoCanvas` mirror;
  // subscribe so the buttons react to edits, undo/redo, and page switches.
  const collabActive = useCollaborationStore((state) => state.isActive);
  const canUndoCanvas = useCollaborationStore((state) => state.canUndoCanvas);
  const canRedoCanvas = useCollaborationStore((state) => state.canRedoCanvas);

  // Derive descriptions reactively (pageHistory triggers re-render)
  const _ph = pageHistory; const _ap = activeHistoryPage; // ensure subscription
  void _ph; void _ap;
  const undoDesc = getUndoDescription();
  const redoDesc = getRedoDescription();
  // In collab, undo/redo act on this user's own changes; descriptions come from the
  // snapshot history, which is inactive there, so use a plain label.
  const undoEnabled = collabActive ? canUndoCanvas : canUndo();
  const redoEnabled = collabActive ? canRedoCanvas : canRedo();
  const undoTitle = collabActive
    ? 'Undo your last change (Ctrl+Z)'
    : undoDesc
      ? `Undo: ${undoDesc} (Ctrl+Z)`
      : 'Undo (Ctrl+Z)';
  const redoTitle = collabActive
    ? 'Redo your last change (Ctrl+Y)'
    : redoDesc
      ? `Redo: ${redoDesc} (Ctrl+Y)`
      : 'Redo (Ctrl+Y)';

  if (isReadOnly) {
    return (
      <div className="canvas-toolbar">
        <ToolbarGroup label="Access">
          <span className="canvas-toolbar-viewonly" title="You have view-only access to this document">
            View only
          </span>
        </ToolbarGroup>
        <ToolbarGroup label="Pages" className="canvas-toolbar-pages">
          <InlinePageTabs />
        </ToolbarGroup>
      </div>
    );
  }

  return (
    <div className="canvas-toolbar">
      <ToolbarGroup label="Drawing tools" className="tool-buttons">
        {TOOLS.map((tool) =>
          tool.type === 'connector' ? (
            // The connector tool carries a sidecar dropdown to pick its draw
            // style (routing / type / ERD preset), remembered as last-used.
            <div key={tool.type} className="tool-with-sidecar">
              <ToolButton
                tool={tool}
                isActive={activeTool === tool.type}
                onClick={() => setActiveTool(tool.type)}
              />
              <ConnectorStyleMenu />
            </div>
          ) : (
            <ToolButton
              key={tool.type}
              tool={tool}
              isActive={activeTool === tool.type}
              onClick={() => setActiveTool(tool.type)}
            />
          )
        )}
      </ToolbarGroup>

      <ToolbarGroup label="Shapes">
        <ShapePicker />
        <IconPicker
          variant="button"
          value={undefined}
          buttonTitle="Insert icon shape"
          buttonContent={<Sticker size={ICON.size} strokeWidth={ICON.strokeWidth} />}
          onChange={(iconId) => {
            if (iconId) createIconShapeAtCenter(iconId);
          }}
        />
      </ToolbarGroup>

      {(getImportContext || onRebuildConnectors) && (
        <ToolbarGroup label="Insert">
          {getImportContext && <FileImportButton getImportContext={getImportContext} />}
          {onRebuildConnectors && (
            <button
              className="toolbar-rebuild-btn"
              onClick={onRebuildConnectors}
              title="Rebuild all connector routes"
              aria-label="Rebuild all connector routes"
            >
              <RefreshCw size={ICON.size} strokeWidth={ICON.strokeWidth} />
            </button>
          )}
        </ToolbarGroup>
      )}

      <ToolbarGroup label="History">
        <button
          className="toolbar-action-btn"
          onClick={undo}
          disabled={!undoEnabled}
          title={undoTitle}
          aria-label={undoTitle}
        >
          <Undo2 size={ICON.size} strokeWidth={ICON.strokeWidth} />
        </button>
        <button
          className="toolbar-action-btn"
          onClick={redo}
          disabled={!redoEnabled}
          title={redoTitle}
          aria-label={redoTitle}
        >
          <Redo2 size={ICON.size} strokeWidth={ICON.strokeWidth} />
        </button>
      </ToolbarGroup>

      <ToolbarGroup label="Pages" className="canvas-toolbar-pages">
        <InlinePageTabs />
      </ToolbarGroup>
    </div>
  );
}

export default CanvasToolbar;
