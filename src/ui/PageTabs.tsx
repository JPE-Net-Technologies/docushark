/**
 * PageTabs component for switching between document pages.
 *
 * Features:
 * - Click to switch pages
 * - Double-click to rename
 * - Right-click context menu for rename/duplicate/delete
 * - Drag-drop reordering
 * - "+" button to add new pages
 */

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { usePageStore } from '../store/pageStore';
import { useHistoryStore } from '../store/historyStore';
import { clampToViewport } from './contextMenuUtils';
import { sharedDocOffline, useSharedDocOffline } from '../collaboration/offlinePageGuard';
import { useNotificationStore } from '../store/notificationStore';
import './PageTabs.css';

/**
 * Context menu state.
 */
interface ContextMenuState {
  visible: boolean;
  x: number;
  y: number;
  pageId: string;
}

export function PageTabs() {
  const pages = usePageStore((state) => state.pages);
  const pageOrder = usePageStore((state) => state.pageOrder);
  const activePageId = usePageStore((state) => state.activePageId);
  const createPage = usePageStore((state) => state.createPage);
  const deletePage = usePageStore((state) => state.deletePage);
  const renamePage = usePageStore((state) => state.renamePage);
  const duplicatePage = usePageStore((state) => state.duplicatePage);
  const setActivePage = usePageStore((state) => state.setActivePage);
  const reorderPages = usePageStore((state) => state.reorderPages);

  // Editing state
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    visible: false,
    x: 0,
    y: 0,
    pageId: '',
  });
  const [adjustedContextMenuPos, setAdjustedContextMenuPos] = useState<{ x: number; y: number } | null>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);

  // Drag state
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  // Handle tab click
  const handleTabClick = useCallback(
    (pageId: string) => {
      if (editingPageId) return; // Don't switch while editing
      setActivePage(pageId);
      // Set history active page
      useHistoryStore.getState().setActivePage(pageId);
    },
    [setActivePage, editingPageId]
  );

  // Handle double-click to edit
  const handleDoubleClick = useCallback((pageId: string, currentName: string) => {
    setEditingPageId(pageId);
    setEditValue(currentName);
  }, []);

  // Handle edit submit
  const handleEditSubmit = useCallback(() => {
    if (editingPageId && editValue.trim()) {
      renamePage(editingPageId, editValue.trim());
    }
    setEditingPageId(null);
    setEditValue('');
  }, [editingPageId, editValue, renamePage]);

  // Handle edit cancel
  const handleEditCancel = useCallback(() => {
    setEditingPageId(null);
    setEditValue('');
  }, []);

  // Handle edit key events
  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        handleEditSubmit();
      } else if (e.key === 'Escape') {
        handleEditCancel();
      }
    },
    [handleEditSubmit, handleEditCancel]
  );

  // Focus input when editing starts
  useEffect(() => {
    if (editingPageId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingPageId]);

  // Handle context menu
  const handleContextMenu = useCallback((e: React.MouseEvent, pageId: string) => {
    e.preventDefault();
    setContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      pageId,
    });
  }, []);

  // Close context menu
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

  // Context menu actions
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

  // Drag and drop handlers
  const handleDragStart = useCallback((e: React.DragEvent, pageId: string) => {
    setDraggedId(pageId);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', pageId);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, pageId: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverId(pageId);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverId(null);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent, targetId: string) => {
      e.preventDefault();
      setDragOverId(null);

      if (!draggedId || draggedId === targetId) {
        setDraggedId(null);
        return;
      }

      // Calculate new order
      const newOrder = [...pageOrder];
      const draggedIndex = newOrder.indexOf(draggedId);
      const targetIndex = newOrder.indexOf(targetId);

      if (draggedIndex === -1 || targetIndex === -1) {
        setDraggedId(null);
        return;
      }

      // Remove dragged item and insert at target position
      newOrder.splice(draggedIndex, 1);
      newOrder.splice(targetIndex, 0, draggedId);

      reorderPages(newOrder);
      setDraggedId(null);
    },
    [draggedId, pageOrder, reorderPages]
  );

  const handleDragEnd = useCallback(() => {
    setDraggedId(null);
    setDragOverId(null);
  }, []);

  const sharedOffline = useSharedDocOffline();

  // Handle add page. Blocked while a shared doc is offline (JP-334): the relay is
  // active-page-only, so a new offline page's shapes never reach its flatten and
  // are lost on reconnect. Enabling offline creation is JP-335.
  const handleAddPage = useCallback(() => {
    if (sharedDocOffline()) {
      useNotificationStore
        .getState()
        .warning('This shared document is offline — reconnect to add pages.');
      return;
    }
    const newPageId = createPage();
    setActivePage(newPageId);
    useHistoryStore.getState().setActivePage(newPageId);
  }, [createPage, setActivePage]);

  // Keyboard shortcuts
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ctrl+PageUp/PageDown for page navigation
      if (e.ctrlKey && (e.key === 'PageUp' || e.key === 'PageDown')) {
        e.preventDefault();
        const currentIndex = pageOrder.indexOf(activePageId ?? '');
        if (currentIndex === -1) return;

        let newIndex: number;
        if (e.key === 'PageUp') {
          newIndex = Math.max(0, currentIndex - 1);
        } else {
          newIndex = Math.min(pageOrder.length - 1, currentIndex + 1);
        }

        const newPageId = pageOrder[newIndex];
        if (newPageId && newPageId !== activePageId) {
          setActivePage(newPageId);
          useHistoryStore.getState().setActivePage(newPageId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [pageOrder, activePageId, setActivePage]);

  return (
    <div className="page-tabs">
      <div className="page-tabs-list">
        {pageOrder.map((pageId) => {
          const page = pages[pageId];
          if (!page) return null;

          const isActive = pageId === activePageId;
          const isEditing = pageId === editingPageId;
          const isDragging = pageId === draggedId;
          const isDragOver = pageId === dragOverId;

          return (
            <div
              key={pageId}
              className={`page-tab ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
              onClick={() => handleTabClick(pageId)}
              onDoubleClick={() => handleDoubleClick(pageId, page.name)}
              onContextMenu={(e) => handleContextMenu(e, pageId)}
              draggable={!isEditing}
              onDragStart={(e) => handleDragStart(e, pageId)}
              onDragOver={(e) => handleDragOver(e, pageId)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, pageId)}
              onDragEnd={handleDragEnd}
            >
              {isEditing ? (
                <input
                  ref={editInputRef}
                  type="text"
                  className="page-tab-input"
                  value={editValue}
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={handleEditSubmit}
                  onKeyDown={handleEditKeyDown}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="page-tab-name">{page.name}</span>
              )}
            </div>
          );
        })}
      </div>

      <button
        className="page-tab-add"
        onClick={handleAddPage}
        aria-disabled={sharedOffline}
        style={sharedOffline ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
        title={sharedOffline ? 'Reconnect to add pages to a shared document' : 'Add new page'}
      >
        +
      </button>

      {/* Context Menu */}
      {contextMenu.visible && (() => {
        const menuPos = adjustedContextMenuPos ?? { x: contextMenu.x, y: contextMenu.y };
        return (
        <div
          ref={contextMenuRef}
          className="page-tab-context-menu"
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
