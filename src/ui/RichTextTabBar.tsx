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

import { useState, useCallback, useRef, useEffect, type ReactNode } from 'react';
import { FileText } from 'lucide-react';
import { Icon } from './icons';
import { createPortal } from 'react-dom';
import { PageTabStrip, type PageTabStripItem } from './components/PageTabStrip';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { sharedDocOffline } from '../collaboration/sharedDocOffline';
import { usePendingSyncPages } from '../store/pendingSyncPages';
import { usePersistenceStore } from '../store/persistenceStore';
import { useIntegrationHubStore, workspaceIntegrationState, providerLabel } from '../store/integrationHubStore';
import { activeWorkspaceId } from '../store/activeWorkspace';
import { refreshMirrorPage, detachMirrorPage } from '../services/mirrorPageService';
import { useNotificationStore } from '../store/notificationStore';
import { confirmDialog } from './confirm/confirmStore';
import { opener } from '../platform/opener';
import { loadConnection, DEFAULT_CLOUD_BASE_URL } from '../api/relayConnection';
import { MirrorResourcePicker } from './integrations/MirrorResourcePicker';
import { ProviderIcon } from './integrations/ProviderIcon';
import { clampToViewport } from './contextMenuUtils';
import type { IntegrationProvider } from '../api/webClient';
import './RichTextTabBar.css';

interface RichTextTabBarProps {
  /** Optional content rendered flush-right in the tab row (e.g. an overflow menu). */
  trailing?: ReactNode;
}

/** Kind glyph distinguishing a prose page from a canvas (diagram) page. */
const proseKindIcon = <Icon icon={FileText} size={13} className="page-tab-kind-icon" />;

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

export function RichTextTabBar({ trailing }: RichTextTabBarProps = {}) {
  const { pages, pageOrder, activePageId, setActivePage, createPage, deletePage, renamePage, setPageColor, reorderPages } = useRichTextPagesStore();
  
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({ isOpen: false, x: 0, y: 0, pageId: '' });
  const [showColorPicker, setShowColorPicker] = useState(false);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  // JP-415 integration affordances: the "+" add-menu (only shown when the
  // workspace has integration options) and the resource-browser modal.
  const [addMenu, setAddMenu] = useState<{ x: number; y: number } | null>(null);
  const [pickerProvider, setPickerProvider] = useState<IntegrationProvider | null>(null);
  const hub = useIntegrationHubStore((s) => s.hub);
  // Measured-then-clamped portal positions (the InlinePageTabs pattern) so
  // neither menu can render out of the viewport.
  const [adjustedCtxPos, setAdjustedCtxPos] = useState<{ x: number; y: number } | null>(null);
  const [adjustedAddPos, setAdjustedAddPos] = useState<{ x: number; y: number } | null>(null);

  const editInputRef = useRef<HTMLInputElement>(null);
  const contextMenuRef = useRef<HTMLDivElement>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const colorTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clamp the tab context menu inside the viewport once it has real bounds.
  useEffect(() => {
    if (!contextMenu.isOpen || !contextMenuRef.current) {
      setAdjustedCtxPos(null);
      return;
    }
    const rect = contextMenuRef.current.getBoundingClientRect();
    setAdjustedCtxPos(clampToViewport(contextMenu.x, contextMenu.y, rect.width, rect.height));
  }, [contextMenu.isOpen, contextMenu.x, contextMenu.y]);

  // Same for the "+" add-menu (its anchor — the add button — can sit at the
  // strip's right edge, which is exactly where an unclamped menu overflows).
  // Re-clamps on size change: the provider rows carry brand-icon images, so
  // the menu can grow a few px after the first measure (cold icon load).
  useEffect(() => {
    const el = addMenuRef.current;
    if (!addMenu || !el) {
      setAdjustedAddPos(null);
      return undefined;
    }
    const reclamp = () => {
      const rect = el.getBoundingClientRect();
      setAdjustedAddPos(clampToViewport(addMenu.x, addMenu.y, rect.width, rect.height));
    };
    reclamp();
    const ro = new ResizeObserver(reclamp);
    ro.observe(el);
    return () => ro.disconnect();
  }, [addMenu]);

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

  // Handle double-click to edit. Mirror pages don't rename locally — the name
  // follows the source title on refresh (JP-415).
  const handleDoubleClick = useCallback((pageId: string) => {
    const page = pages[pageId];
    if (page && !page.mirror) {
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

  // Handle add new page. Allowed offline (JP-335): a page created while the
  // shared doc is offline is marked pending-sync — editable immediately (its
  // fresh id means its fragment can't collide with anything), spared from the
  // reconnect page-list prune, and handed to the relay by the reconnect handoff
  // (useCollaborationSync).
  const handleAddPage = useCallback(() => {
    const newId = createPage();
    if (sharedDocOffline()) {
      const docId = usePersistenceStore.getState().currentDocumentId;
      if (docId) usePendingSyncPages.getState().markPending(newId, docId);
    }
    setActivePage(newId);
  }, [createPage, setActivePage]);

  // "+" click (JP-415): when the workspace has integration options (entitled,
  // with searchable providers), anchor an add-menu to the button; otherwise
  // keep the classic one-click page create — integrations never add friction
  // to the core action. The hub is cached; the first-ever click kicks the load
  // and creates directly (options appear from the next click on).
  const wsIntegrations = workspaceIntegrationState(hub, activeWorkspaceId());
  const addMenuProviders = wsIntegrations?.entitled
    ? wsIntegrations.providers.filter((p) => p.provider.searchable)
    : [];
  const handleAddClick = useCallback(
    (anchorRect?: DOMRect) => {
      void useIntegrationHubStore.getState().ensureLoaded();
      if (addMenuProviders.length > 0 && anchorRect && !sharedDocOffline()) {
        setAddMenu({ x: anchorRect.left, y: anchorRect.bottom + 4 });
        return;
      }
      handleAddPage();
    },
    [addMenuProviders.length, handleAddPage],
  );

  // Close the add-menu on outside click (same pattern as the context menu).
  useEffect(() => {
    if (!addMenu) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setAddMenu(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [addMenu]);

  const openAccountIntegrations = useCallback(() => {
    setAddMenu(null);
    void loadConnection().then((conn) => {
      const base = (conn?.cloudBaseUrl ?? DEFAULT_CLOUD_BASE_URL).replace(/\/+$/, '');
      void opener.openExternalUrl(`${base}/account/integrations`);
    });
  }, []);

  // Mirror page actions (context menu on a mirror tab).
  const handleOpenSource = useCallback((url: string) => {
    setContextMenu({ isOpen: false, x: 0, y: 0, pageId: '' });
    void opener.openExternalUrl(url);
  }, []);

  const handleRefreshMirror = useCallback((pageId: string) => {
    setContextMenu({ isOpen: false, x: 0, y: 0, pageId: '' });
    const notifications = useNotificationStore.getState();
    void refreshMirrorPage(pageId)
      .then(({ warnings }) => {
        const dropped = warnings.reduce((n, w) => n + (w.count ?? 1), 0);
        notifications.success(
          dropped > 0 ? `Page refreshed — ${dropped} element(s) could not be mirrored` : 'Page refreshed from source',
        );
      })
      .catch((e: unknown) => {
        notifications.error(e instanceof Error ? e.message : 'Refresh failed.');
      });
  }, []);

  const handleDetachMirror = useCallback((pageId: string, label: string) => {
    setContextMenu({ isOpen: false, x: 0, y: 0, pageId: '' });
    void confirmDialog({
      title: `Detach from ${label}?`,
      message: 'The page becomes a normal, editable page with the content as last synced.',
      details: 'This cannot be undone — re-adding the source later creates a new page.',
      confirmLabel: 'Detach',
    }).then((ok) => {
      if (ok) detachMirrorPage(pageId);
    });
  }, []);

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

  /** Tab glyph for a mirror page: the provider's brand mark (JP-415) — the
   *  "nice Notion icon" that says at a glance the page is mirrored. */
  const mirrorGlyph = (provider: string): ReactNode => (
    <ProviderIcon provider={provider} size={13} className="page-tab-kind-icon" />
  );

  const items: PageTabStripItem[] = pageOrder.flatMap((pageId) => {
    const page = pages[pageId];
    if (!page) return [];
    const item: PageTabStripItem = {
      id: pageId,
      label: page.name,
      icon: page.mirror ? mirrorGlyph(page.mirror.provider) : proseKindIcon,
    };
    if (page.color) item.color = page.color;
    return [item];
  });

  return (
    <>
      <PageTabStrip
        className="rich-text-tab-bar"
        ariaLabel="Prose pages"
        items={items}
        activeId={activePageId}
        onSelect={handleTabClick}
        trailing={trailing}
        renderTab={(item, index) => {
          const page = pages[item.id];
          if (!page) return null;
          const isActive = item.id === activePageId;
          const isEditing = item.id === editingPageId;
          const isDragging = index === draggedIndex;
          const isDragOver = index === dragOverIndex;

          return (
            <div
              key={item.id}
              data-page-id={item.id}
              className={`rich-text-tab ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
              style={{ '--tab-color': page.color || 'transparent' } as React.CSSProperties}
              onClick={() => handleTabClick(item.id)}
              onDoubleClick={() => handleDoubleClick(item.id)}
              onContextMenu={(e) => handleContextMenu(e, item.id)}
              draggable={!isEditing}
              onDragStart={(e) => handleDragStart(e, index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDragLeave={handleDragLeave}
              onDrop={(e) => handleDrop(e, index)}
              onDragEnd={handleDragEnd}
            >
              {page.mirror ? (
                <span
                  className="rich-text-tab-mirror-glyph"
                  title={`Mirrored from ${providerLabel(hub, page.mirror.provider)}`}
                >
                  {mirrorGlyph(page.mirror.provider)}
                </span>
              ) : page.color ? (
                <span className="rich-text-tab-color" />
              ) : (
                proseKindIcon
              )}
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
        }}
        onAdd={handleAddClick}
      />

      {/* Context menu — mirror pages swap Rename/Color for source actions
          (the name follows the source; color is reserved for normal pages). */}
      {contextMenu.isOpen && createPortal(
        (() => {
          const ctxPage = pages[contextMenu.pageId];
          const ctxMirror = ctxPage?.mirror;
          const ctxLabel = ctxMirror ? providerLabel(hub, ctxMirror.provider) : '';
          const ctxPos = adjustedCtxPos ?? { x: contextMenu.x, y: contextMenu.y };
          return (
            <div
              ref={contextMenuRef}
              className="rich-text-tab-context-menu"
              style={{ left: ctxPos.x, top: ctxPos.y }}
            >
              {ctxMirror ? (
                <>
                  {ctxMirror.url && (
                    <div className="rich-text-tab-context-item" onClick={() => handleOpenSource(ctxMirror.url!)}>
                      Open in {ctxLabel}
                    </div>
                  )}
                  <div className="rich-text-tab-context-item" onClick={() => handleRefreshMirror(contextMenu.pageId)}>
                    Refresh from source
                  </div>
                  <div
                    className="rich-text-tab-context-item"
                    onClick={() => handleDetachMirror(contextMenu.pageId, ctxLabel)}
                  >
                    Detach from {ctxLabel}
                  </div>
                </>
              ) : (
                <>
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
                </>
              )}
              <div className="rich-text-tab-context-divider" />
              <div
                className={`rich-text-tab-context-item danger ${pageOrder.length <= 1 ? 'disabled' : ''}`}
                onClick={pageOrder.length > 1 ? handleDeletePage : undefined}
              >
                Delete
              </div>
            </div>
          );
        })(),
        document.body
      )}

      {/* Add-menu (JP-415): "New page" + the workspace's integration sources. */}
      {addMenu && createPortal(
        <div
          ref={addMenuRef}
          className="rich-text-tab-context-menu"
          style={{ left: (adjustedAddPos ?? addMenu).x, top: (adjustedAddPos ?? addMenu).y }}
        >
          <div
            className="rich-text-tab-context-item"
            onClick={() => {
              setAddMenu(null);
              handleAddPage();
            }}
          >
            New page
          </div>
          {addMenuProviders.length > 0 && <div className="rich-text-tab-context-divider" />}
          {addMenuProviders.map(({ provider, connected }) => (
            <div
              key={provider.id}
              className="rich-text-tab-context-item rich-text-tab-context-item-provider"
              onClick={() => {
                if (connected) {
                  setAddMenu(null);
                  setPickerProvider(provider);
                } else {
                  openAccountIntegrations();
                }
              }}
            >
              <ProviderIcon provider={provider.id} size={14} />
              {connected ? `New page from ${provider.label}…` : `Connect ${provider.label}…`}
            </div>
          ))}
        </div>,
        document.body
      )}

      {/* Resource browser (JP-415). */}
      {pickerProvider && (
        <MirrorResourcePicker provider={pickerProvider} onClose={() => setPickerProvider(null)} />
      )}
    </>
  );
}
