/**
 * RichTextTabBar - Tab bar for multi-page rich text editor.
 *
 * Features:
 * - Display page tabs with names and colors
 * - Click to switch pages
 * - Double-click to rename inline
 * - Right-click context menu for rename/delete/color
 * - Drag to reorder tabs
 * - Add new page button
 */

import { useState, useCallback, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import './RichTextTabBar.css';

/** Colors available for tab customization */
const TAB_COLORS = [
  '#ef4444', // red
  '#f97316', // orange
  '#eab308', // yellow
  '#22c55e', // green
  '#06b6d4', // cyan
  '#3b82f6', // blue
  '#8b5cf6', // violet
  '#ec4899', // pink
  '#6b7280', // gray
];

interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  pageId: string;
}

export function RichTextTabBar() {
  const { pages, pageOrder, activePageId, setActivePage, createPage, deletePage, renamePage, setPageColor, reorderPages } = useRichTextPagesStore();
  
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ isOpen: false, x: 0, y: 0, pageId: '' });
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  
  const editInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const colorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Helpers for color picker submenu hover with timeout
  const openColorPicker = useCallback(() => {
    if (colorTimeoutRef.current) {
      clearTimeout(colorTimeoutRef.current);
      colorTimeoutRef.current = null;
    }
    setShowColorPicker(true);
  }, []);

  const closeColorPickerDelayed = useCallback(() => {
    colorTimeoutRef.current = setTimeout(() => {
      setShowColorPicker(false);
      colorTimeoutRef.current = null;
    }, 200);
  }, []);

  // Focus input when editing starts
  useEffect(() => {
    if (editingPageId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingPageId]);

  // Close context menu on click outside
  useEffect(() => {
    if (!contextMenu.isOpen) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (contextMenuRef.current && !contextMenuRef.current.contains(e.target as Node)) {
        setContextMenu({ isOpen: false, x: 0, y: 0, pageId: '' });
        setShowColorPicker(false);
        if (colorTimeoutRef.current) {
          clearTimeout(colorTimeoutRef.current);
          colorTimeoutRef.current = null;
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [contextMenu.isOpen]);

  // Handle tab click
  const handleTabClick = useCallback((pageId: string) => {
    if (editingPageId) return; // Don't switch while editing
    setActivePage(pageId);
  }, [setActivePage, editingPageId]);

  // Handle double-click to edit
  const handleDoubleClick = useCallback((pageId: string) => {
    const page = pages[pageId];
    if (page) {
      setEditingPageId(pageId);
      setEditingName(page.name);
    }
  }, [pages]);

  // Handle edit finish
  const handleEditFinish = useCallback(() => {
    if (editingPageId && editingName.trim()) {
      renamePage(editingPageId, editingName.trim());
    }
    setEditingPageId(null);
    setEditingName('');
  }, [editingPageId, editingName, renamePage]);

  // Handle edit key down
  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      handleEditFinish();
    } else if (e.key === 'Escape') {
      setEditingPageId(null);
      setEditingName('');
    }
  }, [handleEditFinish]);

  // Handle context menu
  const handleContextMenu = useCallback((e: React.MouseEvent, pageId: string) => {
    e.preventDefault();
    setContextMenu({
      isOpen: true,
      x: e.clientX,
      y: e.clientY,
      pageId,
    });
  }, []);

  // Handle add new page
  const handleAddPage = useCallback(() => {
    const newId = createPage();
    setActivePage(newId);
  }, [createPage, setActivePage]);

  // Handle delete from context menu
  const handleDeletePage = useCallback(() => {
    if (contextMenu.pageId && pageOrder.length > 1) {
      deletePage(contextMenu.pageId);
    }
    setContextMenu({ isOpen: false, x: 0, y: 0, pageId: '' });
  }, [contextMenu.pageId, pageOrder.length, deletePage]);

  // Handle rename from context menu
  const handleRenameFromMenu = useCallback(() => {
    const page = pages[contextMenu.pageId];
    if (page) {
      setEditingPageId(contextMenu.pageId);
      setEditingName(page.name);
    }
    setContextMenu({ isOpen: false, x: 0, y: 0, pageId: '' });
  }, [contextMenu.pageId, pages]);

  // Handle color selection
  const handleColorSelect = useCallback((color: string | undefined) => {
    setPageColor(contextMenu.pageId, color);
    setShowColorPicker(false);
    setContextMenu({ isOpen: false, x: 0, y: 0, pageId: '' });
  }, [contextMenu.pageId, setPageColor]);

  // Drag handlers
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (draggedIndex !== null && draggedIndex !== toIndex) {
      reorderPages(draggedIndex, toIndex);
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, [draggedIndex, reorderPages]);

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, []);

  return (
    <div className="rich-text-tab-bar">
      <div className="rich-text-tabs-container">
        {pageOrder.map((pageId, index) => {
          const page = pages[pageId];
          if (!page) return null;

          const isActive = pageId === activePageId;
          const isEditing = pageId === editingPageId;
          const isDragging = index === draggedIndex;
          const isDragOver = index === dragOverIndex;

          return (
            <div
              key={pageId}
              className={`rich-text-tab ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
              style={{ '--tab-color': page.color || 'transparent' } as React.CSSProperties}
              onClick={() => handleTabClick(pageId)}
              onDoubleClick={() => handleDoubleClick(pageId)}
              onContextMenu={(e) => handleContextMenu(e, pageId)}
              draggable={!isEditing}
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
            >
              {page.color && <span className="rich-text-tab-color" />}
              {isEditing ? (
                <input
                  ref={editInputRef}
                  type="text"
                  className="rich-text-tab-edit-input"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={handleEditFinish}
                  onKeyDown={handleEditKeyDown}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="rich-text-tab-name">{page.name}</span>
              )}
            </div>
          );
        })}
      </div>

      <button
        className="rich-text-add-tab"
        onClick={handleAddPage}
        title="Add new page"
      >
        +
      </button>

      {/* Context menu */}
      {contextMenu.isOpen && createPortal(
        <div
          ref={contextMenuRef}
          className="rich-text-tab-context-menu"
          style={{ left: contextMenu.x, top: contextMenu.y }}
        >
          <div className="rich-text-tab-context-item" onClick={handleRenameFromMenu}>
            Rename
          </div>
          <div
            className="rich-text-tab-context-item has-submenu"
            onMouseEnter={openColorPicker}
            onMouseLeave={closeColorPickerDelayed}
          >
            Color
            <span className="rich-text-tab-context-arrow">›</span>
            
            {showColorPicker && (
              <div
                className="rich-text-tab-color-picker"
                onMouseEnter={openColorPicker}
                onMouseLeave={closeColorPickerDelayed}
              >
                <div className="rich-text-tab-color-grid">
                  {TAB_COLORS.map((color) => (
                    <button
                      key={color}
                      className="rich-text-tab-color-swatch"
                      style={{ backgroundColor: color }}
                      onClick={(e) => { e.stopPropagation(); handleColorSelect(color); }}
                    />
                  ))}
                </div>
                <button
                  className="rich-text-tab-color-clear"
                  onClick={(e) => { e.stopPropagation(); handleColorSelect(undefined); }}
                >
                  Remove color
                </button>
              </div>
            )}
          </div>
          <div className="rich-text-tab-context-divider" />
          <div
            className={`rich-text-tab-context-item danger ${pageOrder.length <= 1 ? 'disabled' : ''}`}
            onClick={pageOrder.length > 1 ? handleDeletePage : undefined}
          >
            Delete
          </div>
        </div>,
        document.body
      )}
    </div>
  );
}
