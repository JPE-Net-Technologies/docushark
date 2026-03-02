/**
 * UnifiedToolbar - Consolidated toolbar combining all top-level controls.
 *
 * Notion/Linear-style minimal top bar with:
 * - Tool buttons with tooltips
 * - Document name + save status
 * - Inline page tabs
 * - Settings button (opens Settings modal with Documents, theme, etc.)
 */

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { useSessionStore, ToolType } from '../store/sessionStore';
import { usePageStore } from '../store/pageStore';
import { useHistoryStore } from '../store/historyStore';
import { usePersistenceStore } from '../store/persistenceStore';
import { useAutoSave } from '../hooks/useAutoSave';
import { ShapePicker } from './ShapePicker';
import { CustomShapePicker } from './CustomShapePicker';
import { clampToViewport } from './contextMenuUtils';
import './UnifiedToolbar.css';

/**
 * Tool definition.
 */
interface ToolDef {
  type: ToolType;
  name: string;
  icon: string;
  shortcut: string;
}

/**
 * Available tools.
 */
const TOOLS: ToolDef[] = [
  { type: 'select', name: 'Select', icon: '\u2197', shortcut: 'V' },
  { type: 'pan', name: 'Pan', icon: '\u270B', shortcut: 'H' },
  { type: 'rectangle', name: 'Rectangle', icon: '\u25AD', shortcut: 'R' },
  { type: 'ellipse', name: 'Ellipse', icon: '\u25EF', shortcut: 'O' },
  { type: 'line', name: 'Line', icon: '\u2571', shortcut: 'L' },
  { type: 'connector', name: 'Connector', icon: '\u27F7', shortcut: 'C' },
  { type: 'text', name: 'Text', icon: 'T', shortcut: 'T' },
];

/**
 * Compact tool button with hover tooltip.
 */
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

/**
 * Inline document name with save status.
 */
function DocumentInfo() {
  const currentDocumentName = usePersistenceStore((state) => state.currentDocumentName);
  const renameDocument = usePersistenceStore((state) => state.renameDocument);
  const { isDirty, status, saveNow } = useAutoSave();

  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  const handleStartEdit = useCallback(() => {
    setEditValue(currentDocumentName);
    setIsEditing(true);
  }, [currentDocumentName]);

  const handleSubmit = useCallback(() => {
    const trimmed = editValue.trim();
    if (trimmed && trimmed !== currentDocumentName) {
      renameDocument(trimmed);
    }
    setIsEditing(false);
  }, [editValue, currentDocumentName, renameDocument]);

  const handleCancel = useCallback(() => {
    setIsEditing(false);
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleSubmit();
      else if (e.key === 'Escape') handleCancel();
    },
    [handleSubmit, handleCancel]
  );

  useEffect(() => {
    if (isEditing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [isEditing]);

  return (
    <div className="document-info">
      {isEditing ? (
        <input
          ref={inputRef}
          type="text"
          className="document-name-input"
          value={editValue}
          onChange={(e) => setEditValue(e.target.value)}
          onBlur={handleSubmit}
          onKeyDown={handleKeyDown}
        />
      ) : (
        <button className="document-name-button" onClick={handleStartEdit} title="Click to rename">
          {currentDocumentName}
        </button>
      )}
      <span
        className={`document-status ${status === 'saving' ? 'saving' : isDirty ? 'dirty' : 'saved'}`}
        onClick={isDirty ? saveNow : undefined}
        title={status === 'saving' ? 'Saving...' : isDirty ? 'Unsaved changes - click to save' : 'Saved'}
      >
        {status === 'saving' ? (
          <SavingIcon />
        ) : isDirty ? (
          <DirtyIcon />
        ) : (
          <SavedIcon />
        )}
      </span>
    </div>
  );
}

function SavingIcon() {
  return (
    <svg className="status-icon saving-spin" width="14" height="14" viewBox="0 0 14 14" fill="none">
      <circle cx="7" cy="7" r="5.5" stroke="currentColor" strokeWidth="1.5" strokeDasharray="20 8" />
    </svg>
  );
}

function DirtyIcon() {
  return (
    <svg className="status-icon" width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
      <circle cx="7" cy="7" r="4" />
    </svg>
  );
}

function SavedIcon() {
  return (
    <svg className="status-icon saved-check" width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path className="check-path" d="M3 7l3 3 5-6" />
    </svg>
  );
}

/**
 * Context menu state for page tabs.
 */
interface PageContextMenu {
  visible: boolean;
  x: number;
  y: number;
  pageId: string;
}

/**
 * Inline page tabs with horizontal scroll and context menu.
 */
function InlinePageTabs() {
  const pages = usePageStore((state) => state.pages);
  const pageOrder = usePageStore((state) => state.pageOrder);
  const activePageId = usePageStore((state) => state.activePageId);
  const createPage = usePageStore((state) => state.createPage);
  const deletePage = usePageStore((state) => state.deletePage);
  const renamePage = usePageStore((state) => state.renamePage);
  const duplicatePage = usePageStore((state) => state.duplicatePage);
  const setActivePage = usePageStore((state) => state.setActivePage);

  const tabsRef = useRef<HTMLDivElement>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<PageContextMenu>({
    visible: false,
    x: 0,
    y: 0,
    pageId: '',
  });
  const [adjustedContextMenuPos, setAdjustedContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Editing state
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  const handleTabClick = useCallback(
    (pageId: string) => {
      if (editingPageId) return;
      setActivePage(pageId);
      useHistoryStore.getState().setActivePage(pageId);
    },
    [setActivePage, editingPageId]
  );

  const handleAddPage = useCallback(() => {
    const newPageId = createPage();
    setActivePage(newPageId);
    useHistoryStore.getState().setActivePage(newPageId);
  }, [createPage, setActivePage]);

  // Context menu handlers
  const handleContextMenu = useCallback((e: React.MouseEvent, pageId: string) => {
    e.preventDefault();
    setContextMenu({ visible: true, x: e.clientX, y: e.clientY, pageId });
  }, []);

  const closeContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, visible: false }));
  }, []);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu.visible) {
      setAdjustedContextMenuPos(null);
      return;
    }
    const handleClick = () => closeContextMenu();
    document.addEventListener('click', handleClick);
    return () => document.removeEventListener('click', handleClick);
  }, [contextMenu.visible, closeContextMenu]);

  // Adjust context menu position to stay within viewport
  useLayoutEffect(() => {
    if (!contextMenu.visible || !contextMenuRef.current) return;

    const menu = contextMenuRef.current;
    const rect = menu.getBoundingClientRect();
    const adjusted = clampToViewport(contextMenu.x, contextMenu.y, rect.width, rect.height);
    setAdjustedContextMenuPos(adjusted);
  }, [contextMenu.visible, contextMenu.x, contextMenu.y]);

  const handleContextRename = useCallback(() => {
    const page = pages[contextMenu.pageId];
    if (page) {
      setEditingPageId(contextMenu.pageId);
      setEditValue(page.name);
    }
    closeContextMenu();
  }, [contextMenu.pageId, pages, closeContextMenu]);

  const handleContextDuplicate = useCallback(() => {
    duplicatePage(contextMenu.pageId);
    closeContextMenu();
  }, [contextMenu.pageId, duplicatePage, closeContextMenu]);

  const handleContextDelete = useCallback(() => {
    if (pageOrder.length > 1) {
      deletePage(contextMenu.pageId);
    }
    closeContextMenu();
  }, [contextMenu.pageId, pageOrder.length, deletePage, closeContextMenu]);

  // Edit handlers
  const handleEditSubmit = useCallback(() => {
    if (editingPageId && editValue.trim()) {
      renamePage(editingPageId, editValue.trim());
    }
    setEditingPageId(null);
    setEditValue('');
  }, [editingPageId, editValue, renamePage]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') handleEditSubmit();
      else if (e.key === 'Escape') {
        setEditingPageId(null);
        setEditValue('');
      }
    },
    [handleEditSubmit]
  );

  // Focus input when editing
  useEffect(() => {
    if (editingPageId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingPageId]);

  // Scroll active tab into view
  useEffect(() => {
    if (!activePageId || !tabsRef.current) return;
    const activeTab = tabsRef.current.querySelector('.inline-tab.active');
    if (activeTab) {
      activeTab.scrollIntoView({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
    }
  }, [activePageId]);

  return (
    <div className="inline-page-tabs">
      <div className="inline-tabs-scroll" ref={tabsRef}>
        {pageOrder.map((pageId) => {
          const page = pages[pageId];
          if (!page) return null;
          const isEditing = pageId === editingPageId;

          return (
            <button
              key={pageId}
              className={`inline-tab ${pageId === activePageId ? 'active' : ''}`}
              onClick={() => handleTabClick(pageId)}
              onContextMenu={(e) => handleContextMenu(e, pageId)}
              title={page.name}
            >
              {isEditing ? (
                <input
                  ref={editInputRef}
                  type="text"
                  className="inline-tab-input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={handleEditSubmit}
                  onKeyDown={handleEditKeyDown}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                page.name
              )}
            </button>
          );
        })}
      </div>
      <button className="inline-tab-add" onClick={handleAddPage} title="Add page">
        +
      </button>

      {/* Context Menu */}
      {contextMenu.visible && (() => {
        const menuPos = adjustedContextMenuPos ?? { x: contextMenu.x, y: contextMenu.y };
        return (
        <div
          ref={contextMenuRef}
          className="inline-tab-context-menu"
          style={{ left: menuPos.x, top: menuPos.y }}
        >
          <button onClick={handleContextRename}>Rename</button>
          <button onClick={handleContextDuplicate}>Duplicate</button>
          <button
            onClick={handleContextDelete}
            disabled={pageOrder.length <= 1}
            className={pageOrder.length <= 1 ? 'disabled' : ''}
          >
            Delete
          </button>
        </div>
        );
      })()}
    </div>
  );
}

/**
 * Props for UnifiedToolbar.
 */
interface UnifiedToolbarProps {
  onOpenSettings?: () => void;
  onRebuildConnectors?: () => void;
}

/** Documentation URL - points to GitHub Pages when deployed */
const DOCS_URL = 'https://QR-Madness.github.io/diagrammer/';

/**
 * Open documentation in system browser
 * Uses Tauri command for bundled docs when available
 */
async function openDocsHandler() {
  // Check if we're in Tauri environment
  const isTauri = typeof window !== 'undefined' && 
    '__TAURI_INTERNALS__' in window;
  
  if (isTauri) {
    try {
      // Use Tauri command for bundled/offline docs
      const { openDocs } = await import('@/tauri/commands');
      await openDocs();
    } catch (error) {
      console.error('Failed to open docs via Tauri:', error);
      // Fall back to online docs
      window.open(DOCS_URL, '_blank', 'noopener,noreferrer');
    }
  } else {
    // Browser environment - open online docs
    window.open(DOCS_URL, '_blank', 'noopener,noreferrer');
  }
}

/**
 * UnifiedToolbar component.
 */
export function UnifiedToolbar({ onOpenSettings, onRebuildConnectors }: UnifiedToolbarProps) {
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
    <div className="unified-toolbar">
      {/* Left Section: Tools */}
      <div className="unified-toolbar-left">
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
      </div>

      {/* Center Section: Document Info */}
      <div className="unified-toolbar-center">
        <DocumentInfo />
      </div>

      {/* Right Section: Page Tabs + Help + Settings */}
      <div className="unified-toolbar-right">
        <InlinePageTabs />
        <div className="toolbar-divider" />
        <button
          className="toolbar-help-btn"
          onClick={() => void openDocsHandler()}
          title="Open documentation (F1)"
        >
          <HelpIcon />
        </button>
        {onOpenSettings && (
          <button
            className="toolbar-settings-btn"
            onClick={onOpenSettings}
            title="Settings (Documents, Theme, Storage, Libraries)"
          >
            <SettingsIcon />
            <span>Settings</span>
          </button>
        )}
      </div>
    </div>
  );
}

export default UnifiedToolbar;

// Icon component for help button
function HelpIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="6.5" />
      <path d="M6 6a2 2 0 1 1 2.5 1.94V9" strokeLinecap="round" />
      <circle cx="8" cy="11.5" r="0.5" fill="currentColor" stroke="none" />
    </svg>
  );
}

// Icon component for settings button
function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5">
      <circle cx="8" cy="8" r="2.5" />
      <path d="M8 1v2M8 13v2M1 8h2M13 8h2M2.5 2.5l1.4 1.4M12.1 12.1l1.4 1.4M2.5 13.5l1.4-1.4M12.1 3.9l1.4-1.4" />
    </svg>
  );
}

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
