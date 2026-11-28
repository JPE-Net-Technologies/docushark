/**
 * InlinePageTabs — the diagram pages' tabs, in the canvas toolbar. The
 * scroll/overflow shell (hidden scrollbar, `⋯` overflow menu, active tab kept
 * in view, one tab stop) lives in the shared {@link PageTabStrip}; this
 * supplies the tabs, "+ Diagram", and each page's menu.
 *
 * A page's menu opens from the ⋯ on its tab, a right-click, press and hold on
 * touch, or Shift+F10 on a focused tab; F2 or a double-click renames; Delete
 * can be undone for ten seconds (DSK-260).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { MoreHorizontal, Shapes } from 'lucide-react';
import { Icon } from './icons';
import { PageTabStrip, type PageTabStripItem } from './components/PageTabStrip';
import { usePageStore } from '../store/pageStore';
import { sharedDocOffline } from '../collaboration/sharedDocOffline';
import { usePendingSyncPages } from '../store/pendingSyncPages';
import { usePersistenceStore } from '../store/persistenceStore';
import { useActiveDocReadOnly } from '../store/documentRegistry';
import { canDeletePage, requestPageDelete, usePendingDeleteIds } from '../store/pendingPageDeleteStore';
import { useBreakpoint } from './layout/useBreakpoint';
import { useMobileAdaptation } from './layout/useMobileAdaptation';
import { pageLabel } from './pages/pageLabel';
import { factsLine, pageFacts } from './pages/pageFacts';
import { PageMenu, pageMenuEntries, type PageMenuAnchor } from './pages/PageMenu';
import { usePageHoverCard } from './pages/PageHoverCard';
import { useLongPress } from './pages/useLongPress';
import { menuAnchorFor } from './pages/menuAnchor';

/** Kind glyph distinguishing a canvas (diagram) page from a prose page. */
const canvasKindIcon = <Icon icon={Shapes} size={13} className="page-tab-kind-icon" />;

export function InlinePageTabs() {
  const pages = usePageStore((state) => state.pages);
  const pageOrder = usePageStore((state) => state.pageOrder);
  const activePageId = usePageStore((state) => state.activePageId);
  const createPage = usePageStore((state) => state.createPage);
  const renamePage = usePageStore((state) => state.renamePage);
  const duplicatePage = usePageStore((state) => state.duplicatePage);
  const setActivePage = usePageStore((state) => state.setActivePage);
  const readOnly = useActiveDocReadOnly();
  const hidden = usePendingDeleteIds();
  const { isTouch } = useBreakpoint();
  const { mobileActive } = useMobileAdaptation();

  const [menu, setMenu] = useState<PageMenuAnchor | null>(null);
  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editValue, setEditValue] = useState('');
  const editInputRef = useRef<HTMLInputElement>(null);

  const labelOf = useCallback((pageId: string) => pageLabel('canvas', pages[pageId]?.name ?? ''), [pages]);

  const card = usePageHoverCard((pageId) =>
    pages[pageId] ? { title: labelOf(pageId), facts: pageFacts('canvas', pageId) } : null,
  );
  const openMenu = useCallback(
    (anchor: PageMenuAnchor) => {
      if (readOnly) return;
      card.hide();
      setMenu(anchor);
    },
    [readOnly, card],
  );
  const longPress = useLongPress((point, target) => {
    const pageId = target.dataset['pageId'];
    if (pageId) openMenu({ pageId, ...point });
  });

  // A page gone from under its open menu (deleted elsewhere) closes the menu.
  useEffect(() => {
    if (menu && !pages[menu.pageId]) setMenu(null);
  }, [menu, pages]);

  const handleTabClick = useCallback(
    (pageId: string) => {
      if (editingPageId) return;
      // pageStore keeps the history store's active page in step.
      setActivePage(pageId);
    },
    [setActivePage, editingPageId]
  );

  // Allowed offline (JP-335): a canvas page created while the shared doc is
  // offline is marked pending-sync — spared from the reconnect page-list prune
  // and handed to the relay (meta + shapes) by the reconnect handoff
  // (useCollaborationSync).
  const handleAddPage = useCallback(() => {
    const newPageId = createPage();
    if (sharedDocOffline()) {
      const docId = usePersistenceStore.getState().currentDocumentId;
      if (docId) usePendingSyncPages.getState().markPending(newPageId, docId);
    }
    setActivePage(newPageId);
  }, [createPage, setActivePage]);

  const startRename = useCallback(
    (pageId: string) => {
      if (readOnly || !pages[pageId]) return;
      setEditingPageId(pageId);
      setEditValue(labelOf(pageId));
    },
    [readOnly, pages, labelOf]
  );

  const commitRename = useCallback(() => {
    const value = editValue.trim();
    // Unchanged text leaves a default name as it is.
    if (editingPageId && value && value !== labelOf(editingPageId)) renamePage(editingPageId, value);
    setEditingPageId(null);
    setEditValue('');
  }, [editingPageId, editValue, labelOf, renamePage]);

  const handleEditKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') commitRename();
      else if (e.key === 'Escape') {
        setEditingPageId(null);
        setEditValue('');
      }
    },
    [commitRename]
  );

  // Focus input when editing
  useEffect(() => {
    if (editingPageId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    }
  }, [editingPageId]);

  const items: PageTabStripItem[] = pageOrder.flatMap((pageId) =>
    pages[pageId] && !hidden.has(pageId) ? [{ id: pageId, label: labelOf(pageId), icon: canvasKindIcon }] : [],
  );

  const menuPageId = menu && pages[menu.pageId] ? menu.pageId : null;
  const menuFacts = menuPageId ? factsLine(pageFacts('canvas', menuPageId)) : undefined;
  const menuEntries = menuPageId
    ? pageMenuEntries({
        heading: isTouch && !mobileActive ? menuFacts : undefined,
        onRename: () => startRename(menuPageId),
        onDuplicate: () => {
          const copyId = duplicatePage(menuPageId);
          if (copyId) setActivePage(copyId);
        },
        onDelete: () => requestPageDelete('canvas', menuPageId, labelOf(menuPageId)),
        canDelete: canDeletePage('canvas', menuPageId),
      })
    : [];

  return (
    <>
      <PageTabStrip
        className="inline-page-tabs"
        ariaLabel="Diagram pages"
        items={items}
        activeId={activePageId}
        onSelect={handleTabClick}
        renderTab={(item, _index, tab) => {
          const isEditing = item.id === editingPageId;
          const isActive = item.id === activePageId;
          const hover = card.bind(item.id);
          return (
            <button
              key={item.id}
              data-page-id={item.id}
              // The strip is a tablist; its tabs say so, and which is shown (DSK-194).
              role="tab"
              aria-selected={isActive}
              aria-haspopup="menu"
              tabIndex={tab.tabIndex}
              className={`inline-tab ${isActive ? 'active' : ''}`}
              onClick={() => handleTabClick(item.id)}
              onDoubleClick={() => startRename(item.id)}
              onContextMenu={(e) => {
                if (readOnly) return;
                e.preventDefault();
                openMenu(menuAnchorFor(e, item.id));
              }}
              onKeyDown={(e) => {
                if (e.key === 'F2' && e.target === e.currentTarget) {
                  e.preventDefault();
                  startRename(item.id);
                }
              }}
              onPointerEnter={hover.onPointerEnter}
              onPointerLeave={hover.onPointerLeave}
              onPointerDown={(e) => {
                hover.onPointerDown();
                longPress.onPointerDown(e);
              }}
              onPointerMove={longPress.onPointerMove}
              onPointerUp={longPress.onPointerUp}
              onPointerCancel={longPress.onPointerCancel}
              onClickCapture={longPress.onClickCapture}
            >
              {canvasKindIcon}
              {isEditing ? (
                <input
                  ref={editInputRef}
                  type="text"
                  className="inline-tab-input"
                  value={editValue}
                  aria-label="Page name"
                  onChange={(e) => setEditValue(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={handleEditKeyDown}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <span className="inline-tab-name">{item.label}</span>
              )}
              {!isEditing && !readOnly && (
                <span
                  role="button"
                  tabIndex={-1}
                  className="page-tab-menu-btn"
                  aria-label={`${item.label}: page menu`}
                  aria-expanded={menu?.pageId === item.id}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    openMenu({ pageId: item.id, x: r.left, y: r.bottom + 4 });
                  }}
                >
                  <Icon icon={MoreHorizontal} size={14} />
                </span>
              )}
            </button>
          );
        }}
        onAdd={handleAddPage}
        addLabel="Diagram"
        addTitle="Add a diagram page"
      />

      <PageMenu
        anchor={menuPageId ? menu : null}
        entries={menuEntries}
        title={menuPageId ? labelOf(menuPageId) : ''}
        subtitle={menuFacts}
        onClose={() => setMenu(null)}
      />
      {card.element}
    </>
  );
}
