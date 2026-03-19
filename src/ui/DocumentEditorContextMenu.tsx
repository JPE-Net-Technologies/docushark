/**
 * DocumentEditorContextMenu - Context menu for the rich text editor.
 *
 * Provides options for:
 * - Text formatting (bold, italic, underline, strikethrough, code)
 * - Lists (bullet, numbered, task)
 * - Headings (H1-H6, paragraph)
 * - Block elements (blockquote, horizontal rule)
 * - Table operations (when in table)
 * - Inserting embedded groups from the canvas
 */

import { useEffect, useCallback, useState, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import type { Editor } from '@tiptap/core';
import { useDocumentStore } from '../store/documentStore';
import { isGroup, type GroupShape } from '../shapes/Shape';
import * as cmd from './editorCommands';
import './DocumentEditorContextMenu.css';

export interface DocumentEditorContextMenuProps {
  /** X position in viewport */
  x: number;
  /** Y position in viewport */
  y: number;
  /** Close callback */
  onClose: () => void;
  /** Tiptap editor instance */
  editor: Editor | null;
}

/**
 * Get all groups from the document store.
 */
function getAvailableGroups(
  shapes: Record<string, unknown>,
  shapeOrder: string[]
): GroupShape[] {
  const groups: GroupShape[] = [];

  for (const id of shapeOrder) {
    const shape = shapes[id];
    if (shape && isGroup(shape as GroupShape)) {
      groups.push(shape as GroupShape);
    }
  }

  return groups;
}

export function DocumentEditorContextMenu({
  x,
  y,
  onClose,
  editor,
}: DocumentEditorContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const submenuRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const hoverTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [activeSubmenu, setActiveSubmenu] = useState<'format' | 'heading' | 'list' | 'table' | 'group' | null>(null);
  const [submenuPosition, setSubmenuPosition] = useState({ x: 0, y: 0 });
  const [searchQuery, setSearchQuery] = useState('');

  // Get groups from document store
  const shapes = useDocumentStore((state) => state.shapes);
  const shapeOrder = useDocumentStore((state) => state.shapeOrder);
  const groups = getAvailableGroups(shapes, shapeOrder);
  
  // Check if cursor is in a table
  const isInTable = editor?.isActive('table') ?? false;

  // Get group display name
  const getGroupName = useCallback((group: GroupShape): string => {
    if (group.name) return group.name;
    if (group.label) return group.label;
    return `Group (${group.childIds.length} items)`;
  }, []);

  // Filter groups based on search query
  const filteredGroups = useMemo(() => {
    if (!searchQuery.trim()) return groups;
    const query = searchQuery.toLowerCase();
    return groups.filter((group) => {
      const name = getGroupName(group).toLowerCase();
      return name.includes(query);
    });
  }, [groups, searchQuery, getGroupName]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      const isInMenu = menuRef.current?.contains(target);
      const isInSubmenu = submenuRef.current?.contains(target);

      if (!isInMenu && !isInSubmenu) {
        onClose();
      }
    };

    const handleEscape = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (activeSubmenu) {
          setActiveSubmenu(null);
          setSearchQuery('');
        } else {
          onClose();
        }
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [onClose, activeSubmenu]);

  // Cleanup timeout on unmount
  useEffect(() => {
    return () => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
      }
    };
  }, []);

  // Focus search input when group submenu opens
  useEffect(() => {
    if (activeSubmenu === 'group' && searchInputRef.current) {
      requestAnimationFrame(() => {
        searchInputRef.current?.focus();
      });
    }
  }, [activeSubmenu]);

  // Adjust position to stay within viewport
  const adjustedPosition = {
    x: Math.min(x, window.innerWidth - 220),
    y: Math.min(y, window.innerHeight - 400),
  };

  // Handle inserting an embedded group
  const handleInsertGroup = useCallback(
    (groupId: string, groupName: string | undefined) => {
      if (!editor) return;

      // Only pass groupName if it's defined
      const attrs: { groupId: string; groupName?: string } = { groupId };
      if (groupName !== undefined) {
        attrs.groupName = groupName;
      }
      editor.chain().focus().insertEmbeddedGroup(attrs).run();
      onClose();
    },
    [editor, onClose]
  );

  // Generic submenu hover handler
  const handleSubmenuEnter = useCallback(
    (submenu: typeof activeSubmenu, e: React.MouseEvent<HTMLDivElement>) => {
      if (hoverTimeoutRef.current) {
        clearTimeout(hoverTimeoutRef.current);
        hoverTimeoutRef.current = null;
      }

      const rect = e.currentTarget.getBoundingClientRect();
      setSubmenuPosition({
        x: rect.right + 4,
        y: rect.top - 8,
      });
      setActiveSubmenu(submenu);
    },
    []
  );

  const handleMenuItemLeave = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => {
      setActiveSubmenu(null);
      setSearchQuery('');
    }, 150);
  }, []);

  const handleSubmenuHover = useCallback(() => {
    if (hoverTimeoutRef.current) {
      clearTimeout(hoverTimeoutRef.current);
      hoverTimeoutRef.current = null;
    }
  }, []);

  const handleSubmenuLeave = useCallback(() => {
    hoverTimeoutRef.current = setTimeout(() => {
      setActiveSubmenu(null);
      setSearchQuery('');
    }, 150);
  }, []);

  return createPortal(
    <>
      <div
        ref={menuRef}
        className="doc-editor-context-menu"
        style={{
          left: adjustedPosition.x,
          top: adjustedPosition.y,
        }}
      >
        {/* Format submenu */}
        <div
          className="doc-editor-context-menu-item has-submenu"
          onMouseEnter={(e) => handleSubmenuEnter('format', e)}
          onMouseLeave={handleMenuItemLeave}
        >
          <span className="doc-editor-context-menu-icon">A</span>
          <span className="doc-editor-context-menu-label">Format</span>
          <span className="doc-editor-context-menu-arrow">›</span>
        </div>

        {/* Heading submenu */}
        <div
          className="doc-editor-context-menu-item has-submenu"
          onMouseEnter={(e) => handleSubmenuEnter('heading', e)}
          onMouseLeave={handleMenuItemLeave}
        >
          <span className="doc-editor-context-menu-icon">H</span>
          <span className="doc-editor-context-menu-label">Heading</span>
          <span className="doc-editor-context-menu-arrow">›</span>
        </div>

        {/* List submenu */}
        <div
          className="doc-editor-context-menu-item has-submenu"
          onMouseEnter={(e) => handleSubmenuEnter('list', e)}
          onMouseLeave={handleMenuItemLeave}
        >
          <span className="doc-editor-context-menu-icon">≡</span>
          <span className="doc-editor-context-menu-label">List</span>
          <span className="doc-editor-context-menu-arrow">›</span>
        </div>

        <div className="doc-editor-context-menu-divider" />

        {/* Block quote */}
        <div
          className={`doc-editor-context-menu-item ${editor?.isActive('blockquote') ? 'active' : ''}`}
          onClick={() => {
            if (editor) cmd.toggleBlockquote(editor);
            onClose();
          }}
        >
          <span className="doc-editor-context-menu-icon">❝</span>
          <span className="doc-editor-context-menu-label">Block Quote</span>
        </div>

        {/* Horizontal rule */}
        <div
          className="doc-editor-context-menu-item"
          onClick={() => {
            if (editor) cmd.insertHorizontalRule(editor);
            onClose();
          }}
        >
          <span className="doc-editor-context-menu-icon">—</span>
          <span className="doc-editor-context-menu-label">Horizontal Rule</span>
        </div>

        {/* Table submenu - only when in table */}
        {isInTable && (
          <>
            <div className="doc-editor-context-menu-divider" />
            <div
              className="doc-editor-context-menu-item has-submenu"
              onMouseEnter={(e) => handleSubmenuEnter('table', e)}
              onMouseLeave={handleMenuItemLeave}
            >
              <span className="doc-editor-context-menu-icon">⊞</span>
              <span className="doc-editor-context-menu-label">Table</span>
              <span className="doc-editor-context-menu-arrow">›</span>
            </div>
          </>
        )}

        <div className="doc-editor-context-menu-divider" />

        {/* Insert Group option with submenu */}
        <div
          className={`doc-editor-context-menu-item ${groups.length === 0 ? 'disabled' : 'has-submenu'}`}
          onMouseEnter={(e) => groups.length > 0 && handleSubmenuEnter('group', e)}
          onMouseLeave={handleMenuItemLeave}
        >
          <span className="doc-editor-context-menu-icon">📊</span>
          <span className="doc-editor-context-menu-label">Insert Group</span>
          {groups.length > 0 && <span className="doc-editor-context-menu-arrow">›</span>}
          {groups.length === 0 && (
            <span className="doc-editor-context-menu-hint">No groups</span>
          )}
        </div>
      </div>

      {/* Format submenu */}
      {activeSubmenu === 'format' && (
        <div
          ref={submenuRef}
          className="doc-editor-context-submenu"
          style={{ left: submenuPosition.x, top: submenuPosition.y }}
          onMouseEnter={handleSubmenuHover}
          onMouseLeave={handleSubmenuLeave}
        >
          <div
            className={`doc-editor-context-menu-item ${editor?.isActive('bold') ? 'active' : ''}`}
            onClick={() => { if (editor) cmd.toggleBold(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon" style={{ fontWeight: 'bold' }}>B</span>
            <span className="doc-editor-context-menu-label">Bold</span>
            <span className="doc-editor-context-menu-shortcut">Ctrl+B</span>
          </div>
          <div
            className={`doc-editor-context-menu-item ${editor?.isActive('italic') ? 'active' : ''}`}
            onClick={() => { if (editor) cmd.toggleItalic(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon" style={{ fontStyle: 'italic' }}>I</span>
            <span className="doc-editor-context-menu-label">Italic</span>
            <span className="doc-editor-context-menu-shortcut">Ctrl+I</span>
          </div>
          <div
            className={`doc-editor-context-menu-item ${editor?.isActive('underline') ? 'active' : ''}`}
            onClick={() => { if (editor) cmd.toggleUnderline(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon" style={{ textDecoration: 'underline' }}>U</span>
            <span className="doc-editor-context-menu-label">Underline</span>
            <span className="doc-editor-context-menu-shortcut">Ctrl+U</span>
          </div>
          <div
            className={`doc-editor-context-menu-item ${editor?.isActive('strike') ? 'active' : ''}`}
            onClick={() => { if (editor) cmd.toggleStrike(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon" style={{ textDecoration: 'line-through' }}>S</span>
            <span className="doc-editor-context-menu-label">Strikethrough</span>
          </div>
          <div className="doc-editor-context-menu-divider" />
          <div
            className={`doc-editor-context-menu-item ${editor?.isActive('code') ? 'active' : ''}`}
            onClick={() => { if (editor) cmd.toggleCode(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">&lt;/&gt;</span>
            <span className="doc-editor-context-menu-label">Code</span>
          </div>
          <div
            className={`doc-editor-context-menu-item ${editor?.isActive('subscript') ? 'active' : ''}`}
            onClick={() => { if (editor) cmd.toggleSubscript(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">X<sub>2</sub></span>
            <span className="doc-editor-context-menu-label">Subscript</span>
          </div>
          <div
            className={`doc-editor-context-menu-item ${editor?.isActive('superscript') ? 'active' : ''}`}
            onClick={() => { if (editor) cmd.toggleSuperscript(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">X<sup>2</sup></span>
            <span className="doc-editor-context-menu-label">Superscript</span>
          </div>
          <div className="doc-editor-context-menu-divider" />
          <div
            className="doc-editor-context-menu-item"
            onClick={() => { if (editor) cmd.clearFormatting(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">⌫</span>
            <span className="doc-editor-context-menu-label">Clear Formatting</span>
          </div>
        </div>
      )}

      {/* Heading submenu */}
      {activeSubmenu === 'heading' && (
        <div
          ref={submenuRef}
          className="doc-editor-context-submenu"
          style={{ left: submenuPosition.x, top: submenuPosition.y }}
          onMouseEnter={handleSubmenuHover}
          onMouseLeave={handleSubmenuLeave}
        >
          <div
            className={`doc-editor-context-menu-item ${editor?.isActive('paragraph') ? 'active' : ''}`}
            onClick={() => { if (editor) cmd.setParagraph(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">¶</span>
            <span className="doc-editor-context-menu-label">Paragraph</span>
          </div>
          <div className="doc-editor-context-menu-divider" />
          {([1, 2, 3, 4, 5, 6] as const).map((level) => (
            <div
              key={level}
              className={`doc-editor-context-menu-item ${editor?.isActive('heading', { level }) ? 'active' : ''}`}
              onClick={() => { if (editor) cmd.setHeading(editor, level); onClose(); }}
            >
              <span className="doc-editor-context-menu-icon" style={{ fontSize: `${1.2 - level * 0.1}rem`, fontWeight: 'bold' }}>H{level}</span>
              <span className="doc-editor-context-menu-label">Heading {level}</span>
            </div>
          ))}
        </div>
      )}

      {/* List submenu */}
      {activeSubmenu === 'list' && (
        <div
          ref={submenuRef}
          className="doc-editor-context-submenu"
          style={{ left: submenuPosition.x, top: submenuPosition.y }}
          onMouseEnter={handleSubmenuHover}
          onMouseLeave={handleSubmenuLeave}
        >
          <div
            className={`doc-editor-context-menu-item ${editor?.isActive('bulletList') ? 'active' : ''}`}
            onClick={() => { if (editor) cmd.toggleBulletList(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">•</span>
            <span className="doc-editor-context-menu-label">Bullet List</span>
          </div>
          <div
            className={`doc-editor-context-menu-item ${editor?.isActive('orderedList') ? 'active' : ''}`}
            onClick={() => { if (editor) cmd.toggleOrderedList(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">1.</span>
            <span className="doc-editor-context-menu-label">Numbered List</span>
          </div>
          <div
            className={`doc-editor-context-menu-item ${editor?.isActive('taskList') ? 'active' : ''}`}
            onClick={() => { if (editor) cmd.toggleTaskList(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">☑</span>
            <span className="doc-editor-context-menu-label">Task List</span>
          </div>
        </div>
      )}

      {/* Table submenu */}
      {activeSubmenu === 'table' && isInTable && (
        <div
          ref={submenuRef}
          className="doc-editor-context-submenu"
          style={{ left: submenuPosition.x, top: submenuPosition.y }}
          onMouseEnter={handleSubmenuHover}
          onMouseLeave={handleSubmenuLeave}
        >
          <div
            className="doc-editor-context-menu-item"
            onClick={() => { if (editor) cmd.addRowBefore(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">↑+</span>
            <span className="doc-editor-context-menu-label">Insert Row Above</span>
          </div>
          <div
            className="doc-editor-context-menu-item"
            onClick={() => { if (editor) cmd.addRowAfter(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">↓+</span>
            <span className="doc-editor-context-menu-label">Insert Row Below</span>
          </div>
          <div
            className="doc-editor-context-menu-item"
            onClick={() => { if (editor) cmd.addColumnBefore(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">←+</span>
            <span className="doc-editor-context-menu-label">Insert Column Left</span>
          </div>
          <div
            className="doc-editor-context-menu-item"
            onClick={() => { if (editor) cmd.addColumnAfter(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">→+</span>
            <span className="doc-editor-context-menu-label">Insert Column Right</span>
          </div>
          <div className="doc-editor-context-menu-divider" />
          <div
            className="doc-editor-context-menu-item"
            onClick={() => { if (editor) cmd.deleteRow(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">↕✕</span>
            <span className="doc-editor-context-menu-label">Delete Row</span>
          </div>
          <div
            className="doc-editor-context-menu-item"
            onClick={() => { if (editor) cmd.deleteColumn(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">↔✕</span>
            <span className="doc-editor-context-menu-label">Delete Column</span>
          </div>
          <div className="doc-editor-context-menu-divider" />
          <div
            className="doc-editor-context-menu-item"
            onClick={() => { if (editor) cmd.toggleHeaderRow(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">▤</span>
            <span className="doc-editor-context-menu-label">Toggle Header Row</span>
          </div>
          <div
            className="doc-editor-context-menu-item"
            onClick={() => { if (editor) cmd.toggleHeaderColumn(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">▥</span>
            <span className="doc-editor-context-menu-label">Toggle Header Column</span>
          </div>
          <div className="doc-editor-context-menu-divider" />
          <div
            className="doc-editor-context-menu-item"
            onClick={() => { if (editor) cmd.mergeCells(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">⊞</span>
            <span className="doc-editor-context-menu-label">Merge Cells</span>
          </div>
          <div
            className="doc-editor-context-menu-item"
            onClick={() => { if (editor) cmd.splitCell(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">⊟</span>
            <span className="doc-editor-context-menu-label">Split Cell</span>
          </div>
          <div className="doc-editor-context-menu-divider" />
          <div
            className="doc-editor-context-menu-item danger"
            onClick={() => { if (editor) cmd.deleteTable(editor); onClose(); }}
          >
            <span className="doc-editor-context-menu-icon">🗑</span>
            <span className="doc-editor-context-menu-label">Delete Table</span>
          </div>
        </div>
      )}

      {/* Group submenu */}
      {activeSubmenu === 'group' && groups.length > 0 && (
        <div
          ref={submenuRef}
          className="doc-editor-context-submenu"
          style={{ left: submenuPosition.x, top: submenuPosition.y }}
          onMouseEnter={handleSubmenuHover}
          onMouseLeave={handleSubmenuLeave}
        >
          <div className="doc-editor-submenu-search">
            <input
              ref={searchInputRef}
              type="text"
              className="doc-editor-submenu-search-input"
              placeholder="Search groups..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onClick={(e) => e.stopPropagation()}
            />
          </div>
          <div className="doc-editor-submenu-list">
            {filteredGroups.length === 0 ? (
              <div className="doc-editor-context-menu-item disabled">
                <span className="doc-editor-context-menu-label">No matching groups</span>
              </div>
            ) : (
              filteredGroups.map((group) => (
                <div
                  key={group.id}
                  className="doc-editor-context-menu-item"
                  onClick={() => handleInsertGroup(group.id, group.name || group.label)}
                >
                  {group.layerColor && (
                    <span
                      className="doc-editor-context-menu-color"
                      style={{ backgroundColor: group.layerColor }}
                    />
                  )}
                  <span className="doc-editor-context-menu-label">
                    {getGroupName(group)}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </>,
    document.body
  );
}
