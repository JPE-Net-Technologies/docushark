/**
 * InlinePageTabs — inline canvas page tabs with inline rename and a right-click
 * context menu. The scroll/overflow shell (hidden scrollbar + `⋯` overflow
 * menu + active-into-view) lives in the shared {@link PageTabStrip}; this
 * component supplies the canvas-specific tab markup, add button, and menu.
 */

import { useState, useRef, useCallback, useEffect, useLayoutEffect } from 'react';
import { Shapes } from 'lucide-react';
import { Icon } from './icons';
import { PageTabStrip, type PageTabStripItem } from './components/PageTabStrip';
import { usePageStore } from '../store/pageStore';
import { useHistoryStore } from '../store/historyStore';
import { clampToViewport } from './contextMenuUtils';
import { sharedDocOffline, useSharedDocOffline } from '../collaboration/offlinePageGuard';
import { useNotificationStore } from '../store/notificationStore';

/**
 * Context menu state for page tabs.
 */
interface PageContextMenu {
  visible: boolean;
  x: number;
  y: number;
  pageId: string;
}

/** Kind glyph distinguishing a canvas (diagram) page from a prose page. */
const canvasKindIcon = <Icon icon={Shapes} size={13} className="page-tab-kind-icon" />;

export function InlinePageTabs() {
  const pages = usePageStore((state) => state.pages);
  const pageOrder = usePageStore((state) => state.pageOrder);
  const activePageId = usePageStore((state) => state.activePageId);
  const createPage = usePageStore((state) => state.createPage);
  const deletePage = usePageStore((state) => state.deletePage);
  const renamePage = usePageStore((state) => state.renamePage);
  const duplicatePage = usePageStore((state) => state.duplicatePage);
  const setActivePage = usePageStore((state) => state.setActivePage);

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

  const sharedOffline = useSharedDocOffline();

  // Blocked while a shared doc is offline (JP-334): the relay is active-page-only,
  // so a new offline page's shapes never reach its flatten and are lost on
  // reconnect. Enabling offline creation is JP-335.
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

  const items: PageTabStripItem[] = pageOrder.flatMap((pageId) => {
    const page = pages[pageId];
    return page ? [{ id: pageId, label: page.name, icon: canvasKindIcon }] : [];
  });

  return (
    <>
      <PageTabStrip
        className="inline-page-tabs"
        ariaLabel="Canvas pages"
        items={items}
        activeId={activePageId}
        onSelect={handleTabClick}
        renderTab={(item) => {
          const isEditing = item.id === editingPageId;
          return (
            <button
              key={item.id}
              data-page-id={item.id}
              className={`inline-tab ${item.id === activePageId ? 'active' : ''}`}
              onClick={() => handleTabClick(item.id)}
              onContextMenu={(e) => handleContextMenu(e, item.id)}
              title={item.label}
            >
              {canvasKindIcon}
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
                <span className="inline-tab-name">{item.label}</span>
              )}
            </button>
          );
        }}
        onAdd={handleAddPage}
        addDisabled={sharedOffline}
        addTitle={sharedOffline ? 'Reconnect to add pages to a shared document' : 'Add page'}
      />

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
    </>
  );
}
