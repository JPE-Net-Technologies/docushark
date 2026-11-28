/**
 * RichTextTabBar — the writing pages' tabs, above the text.
 *
 * - A tab shows the page's chosen name, else its first heading, else "Page N"
 *   (DSK-260); the hover card gives the full name, size and place in the PDF.
 * - Click opens a page; double-click or F2 renames it inline.
 * - Each page's menu opens from the ⋯ on its tab, a right-click, press and
 *   hold on touch, or Shift+F10: rename, color, delete (with Undo), and a
 *   mirrored page's source actions.
 * - Drag to reorder; a family root drags its subpages with it (JP-475).
 * - "+ Page" adds a page.
 */

import { useState, useCallback, useMemo, useRef, useEffect, type ReactNode } from 'react';
import { ChevronDown, FileText, MoreHorizontal } from 'lucide-react';
import { Icon } from './icons';
import { createPortal } from 'react-dom';
import { PageTabStrip, type PageTabStripItem } from './components/PageTabStrip';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { sharedDocOffline } from '../collaboration/sharedDocOffline';
import { usePendingSyncPages } from '../store/pendingSyncPages';
import { usePersistenceStore } from '../store/persistenceStore';
import { useActiveDocReadOnly } from '../store/documentRegistry';
import { canDeletePage, requestPageDelete, usePendingDeleteIds } from '../store/pendingPageDeleteStore';
import { useIntegrationHubStore, providerLabel } from '../store/integrationHubStore';
import { OPEN_MIRROR_PICKER, type OpenMirrorPickerDetail } from '../services/integrationActions';
import { MirrorResourcePicker } from './integrations/MirrorResourcePicker';
import { IngestSubpagesDialog } from './integrations/IngestSubpagesDialog';
import { ProviderIcon } from './integrations/ProviderIcon';
import {
  buildMirrorFamilyIndex,
  descendantEntries,
  familyBlock,
  isFamilyRoot,
} from '../services/mirrorFamily';
import { clampToViewport } from './contextMenuUtils';
import type { IntegrationProvider } from '../api/webClient';
import { useBreakpoint } from './layout/useBreakpoint';
import { useMobileAdaptation } from './layout/useMobileAdaptation';
import { pageLabel } from './pages/pageLabel';
import { factsLine, pageFacts } from './pages/pageFacts';
import { mirrorPageMenuEntries, PageMenu, pageMenuEntries, type PageMenuAnchor } from './pages/PageMenu';
import { usePageHoverCard } from './pages/PageHoverCard';
import { useLongPress } from './pages/useLongPress';
import { useProsePageHeadings } from './pages/useProsePageHeadings';
import { isMenuKey, menuAnchorBelow, menuAnchorFor } from './pages/menuAnchor';
import './RichTextTabBar.css';

interface RichTextTabBarProps {
  /** Optional content rendered flush-right in the tab row (e.g. an overflow menu). */
  trailing?: ReactNode;
}

/** Kind glyph distinguishing a prose page from a canvas (diagram) page. */
const proseKindIcon = <Icon icon={FileText} size={13} className="page-tab-kind-icon" />;

export function RichTextTabBar({ trailing }: RichTextTabBarProps = {}) {
  const { pages, pageOrder, activePageId, setActivePage, createPage, renamePage, setPageColor, movePages } = useRichTextPagesStore();
  const readOnly = useActiveDocReadOnly();
  const hidden = usePendingDeleteIds();
  const headings = useProsePageHeadings();
  const { isTouch } = useBreakpoint();
  const { mobileActive } = useMobileAdaptation();

  const [editingPageId, setEditingPageId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [menu, setMenu] = useState<PageMenuAnchor | null>(null);
  const [draggedIndex, setDraggedIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  // JP-415: the resource browser for "New page from …", opened by event.
  const [pickerProvider, setPickerProvider] = useState<IntegrationProvider | null>(null);
  // JP-475 mirror families: descendants collapse under their root's tab. The
  // flyout navigates a family; the ingest dialog mirrors new subpages.
  const [familyFlyout, setFamilyFlyout] = useState<{ rootId: string; x: number; y: number } | null>(null);
  const [ingestPageId, setIngestPageId] = useState<string | null>(null);
  const hub = useIntegrationHubStore((s) => s.hub);

  // The pages on show. One waiting out a delete's Undo is gone from here, and
  // its subpages stand on their own, as they will once it's deleted.
  const visibleOrder = useMemo(() => pageOrder.filter((id) => !hidden.has(id)), [pageOrder, hidden]);
  const familyIndex = useMemo(() => buildMirrorFamilyIndex(pages, visibleOrder), [pages, visibleOrder]);
  const labelOf = useCallback(
    (pageId: string) => pageLabel('prose', pages[pageId]?.name ?? '', headings[pageId]),
    [pages, headings],
  );

  const editInputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const familyFlyoutRef = useRef<HTMLDivElement>(null);
  const [adjustedFlyoutPos, setAdjustedFlyoutPos] = useState<{ x: number; y: number } | null>(null);

  const card = usePageHoverCard((pageId) =>
    pages[pageId] ? { title: labelOf(pageId), facts: pageFacts('prose', pageId) } : null,
  );
  const openMenu = useCallback(
    (anchor: PageMenuAnchor) => {
      if (readOnly) return;
      card.hide();
      setFamilyFlyout(null);
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

  // Family flyout: measured-then-clamped portal + outside-click close.
  useEffect(() => {
    if (!familyFlyout || !familyFlyoutRef.current) {
      setAdjustedFlyoutPos(null);
      return;
    }
    const rect = familyFlyoutRef.current.getBoundingClientRect();
    setAdjustedFlyoutPos(clampToViewport(familyFlyout.x, familyFlyout.y, rect.width, rect.height));
  }, [familyFlyout]);

  useEffect(() => {
    if (!familyFlyout) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (familyFlyoutRef.current && !familyFlyoutRef.current.contains(e.target as Node)) setFamilyFlyout(null);
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [familyFlyout]);

  // Focus the field when renaming starts, and the tab again when it ends by key.
  useEffect(() => {
    if (editingPageId && editInputRef.current) {
      editInputRef.current.focus();
      editInputRef.current.select();
    } else if (!editingPageId && returnFocusRef.current) {
      returnFocusRef.current.focus();
      returnFocusRef.current = null;
    }
  }, [editingPageId]);

  const handleTabClick = useCallback((pageId: string) => {
    if (editingPageId) return; // Don't switch while editing
    setActivePage(pageId);
  }, [setActivePage, editingPageId]);

  // Mirror pages don't rename locally: the name follows the source title on
  // refresh (JP-415).
  const startRename = useCallback((pageId: string) => {
    const page = pages[pageId];
    if (readOnly || !page || page.mirror) return;
    setEditingPageId(pageId);
    setEditingName(labelOf(pageId));
  }, [pages, readOnly, labelOf]);

  const commitRename = useCallback(() => {
    const value = editingName.trim();
    // Unchanged text leaves a default name as it is, so the page keeps
    // following its heading.
    if (editingPageId && value && value !== labelOf(editingPageId)) renamePage(editingPageId, value);
    setEditingPageId(null);
    setEditingName('');
  }, [editingPageId, editingName, labelOf, renamePage]);

  const handleEditKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== 'Escape') return;
    // Back to the tab once the field has gone, so the keys carry on from there.
    returnFocusRef.current = e.currentTarget.closest<HTMLElement>('[role="tab"]');
    if (e.key === 'Enter') {
      commitRename();
    } else {
      setEditingPageId(null);
      setEditingName('');
    }
  }, [commitRename]);

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

  // Warm the integration hub as soon as the tab bar exists, so integration
  // entry points are ready for the first click rather than the second
  // (prefetch, not await: a network round-trip must never sit in front of
  // adding a page; the store coalesces calls and caches with a TTL).
  useEffect(() => {
    void useIntegrationHubStore.getState().ensureLoaded();
  }, []);

  // A command can be run from the palette, where this component is not in
  // scope, so integration actions ask for the picker by event rather than
  // calling into it — the same bridge the PDF and version-history commands use.
  useEffect(() => {
    const open = (e: Event) => {
      const providerId = (e as CustomEvent<OpenMirrorPickerDetail>).detail?.provider;
      const match = hub?.providers.find((p) => p.id === providerId);
      if (match) setPickerProvider(match);
    };
    window.addEventListener(OPEN_MIRROR_PICKER, open);
    return () => window.removeEventListener(OPEN_MIRROR_PICKER, open);
  }, [hub]);

  // One strip item per family ROOT (or plain page); descendants collapse under
  // their root. Item index ≠ pageOrder index from here on — every reorder
  // translates through `itemBlocks` (a root drags its contiguous block).
  const rootIds = useMemo(
    () => visibleOrder.filter((id) => pages[id] !== undefined && isFamilyRoot(familyIndex, id)),
    [visibleOrder, pages, familyIndex],
  );
  const itemBlocks = useMemo(
    () => rootIds.map((id) => (familyIndex.childrenOf.has(id) ? familyBlock(familyIndex, visibleOrder, id) : [id])),
    [rootIds, familyIndex, visibleOrder],
  );

  // Drag handlers
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setMenu(null);
    card.hide();
    setDraggedIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
  }, [card]);

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
      const moved = itemBlocks[draggedIndex];
      if (moved && moved.length > 0) {
        // Translate the ITEM-level drop into a page index: the block lands
        // before the first page of the item now at the target position, counted
        // in the whole order with the moved pages taken out (movePages'
        // convention). The whole order, because pages waiting out a delete's
        // Undo are hidden here but still in it.
        const rest = itemBlocks.filter((_, i) => i !== draggedIndex);
        const itemTo = Math.max(0, Math.min(toIndex, rest.length));
        const remaining = pageOrder.filter((id) => !moved.includes(id));
        const before = rest[itemTo]?.[0];
        movePages(moved, before === undefined ? remaining.length : remaining.indexOf(before));
      }
    }
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, [draggedIndex, itemBlocks, pageOrder, movePages]);

  const handleDragEnd = useCallback(() => {
    setDraggedIndex(null);
    setDragOverIndex(null);
  }, []);

  /** Tab glyph for a mirror page: the provider's brand mark (JP-415) — the
   *  "nice Notion icon" that says at a glance the page is mirrored. */
  const mirrorGlyph = (provider: string): ReactNode => (
    <ProviderIcon provider={provider} size={13} className="page-tab-kind-icon" />
  );

  // Items are a TREE: one entry per root, descendants nested under `children`
  // (the strip's overflow menu renders them indented; the flyout navigates).
  const toStripItem = (pageId: string): PageTabStripItem | null => {
    const page = pages[pageId];
    if (!page) return null;
    const item: PageTabStripItem = {
      id: pageId,
      label: labelOf(pageId),
      icon: page.mirror ? mirrorGlyph(page.mirror.provider) : proseKindIcon,
    };
    if (page.color) item.color = page.color;
    const children = (familyIndex.childrenOf.get(pageId) ?? [])
      .map(toStripItem)
      .filter((c): c is PageTabStripItem => c !== null);
    if (children.length > 0) item.children = children;
    return item;
  };
  const items: PageTabStripItem[] = rootIds
    .map(toStripItem)
    .filter((c): c is PageTabStripItem => c !== null);

  const menuPage = menu ? pages[menu.pageId] : undefined;
  const menuPageId = menuPage && menu ? menu.pageId : null;
  const menuFacts = menuPageId ? factsLine(pageFacts('prose', menuPageId)) : undefined;
  const menuEntries =
    menuPage && menuPageId
      ? pageMenuEntries({
          heading: isTouch && !mobileActive ? menuFacts : undefined,
          onRename: menuPage.mirror ? undefined : () => startRename(menuPageId),
          color: menuPage.mirror ? undefined : { current: menuPage.color, onPick: (color) => setPageColor(menuPageId, color) },
          mirror: menuPage.mirror
            ? mirrorPageMenuEntries(menuPageId, menuPage.mirror, () => setIngestPageId(menuPageId))
            : undefined,
          onDelete: () => requestPageDelete('prose', menuPageId, labelOf(menuPageId)),
          canDelete: canDeletePage('prose', menuPageId),
        })
      : [];

  return (
    <>
      <PageTabStrip
        className="rich-text-tab-bar"
        ariaLabel="Writing pages"
        items={items}
        activeId={activePageId}
        onSelect={handleTabClick}
        trailing={trailing}
        renderTab={(item, index, tab) => {
          const page = pages[item.id];
          if (!page) return null;
          const descendants = item.children ? descendantEntries(familyIndex, item.id) : [];
          const activeChild =
            activePageId !== null && descendants.some((d) => d.pageId === activePageId) ? activePageId : null;
          const isActive = item.id === activePageId || activeChild !== null;
          const isEditing = item.id === editingPageId;
          const isDragging = index === draggedIndex;
          const isDragOver = index === dragOverIndex;
          const hover = card.bind(item.id);

          return (
            <div
              key={item.id}
              data-page-id={item.id}
              // The strip is a tablist; its tabs say so, and which is shown
              // (DSK-194). A family's tab counts as selected while one of its
              // subpages is the page shown.
              role="tab"
              // The tab's name is what it shows, not the buttons inside it too.
              aria-label={activeChild ? `${item.label} › ${labelOf(activeChild)}` : item.label}
              aria-selected={isActive}
              aria-haspopup="menu"
              tabIndex={tab.tabIndex}
              className={`rich-text-tab ${isActive ? 'active' : ''} ${isDragging ? 'dragging' : ''} ${isDragOver ? 'drag-over' : ''}`}
              style={{ '--tab-color': page.color || 'transparent' } as React.CSSProperties}
              onClick={() => handleTabClick(item.id)}
              onDoubleClick={() => startRename(item.id)}
              onContextMenu={(e) => {
                if (readOnly) return;
                e.preventDefault();
                openMenu(menuAnchorFor(e, item.id));
              }}
              onKeyDown={(e) => {
                if (e.target !== e.currentTarget) return;
                if (e.key === 'F2') {
                  e.preventDefault();
                  startRename(item.id);
                } else if (isMenuKey(e) && !readOnly) {
                  // Opened here rather than left to the browser, which raises
                  // no contextmenu for these keys on a Mac; preventDefault
                  // stops a second one where it would.
                  e.preventDefault();
                  openMenu(menuAnchorBelow(e.currentTarget, item.id));
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
              draggable={!isEditing && !readOnly}
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
                  aria-label="Page name"
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={commitRename}
                  onKeyDown={handleEditKeyDown}
                  onClick={(e) => e.stopPropagation()}
                />
              ) : activeChild ? (
                // Two spans so the ROOT truncates first — the child name is the
                // informative half of the breadcrumb and must stay visible.
                <span className="rich-text-tab-name rich-text-tab-breadcrumb">
                  <span className="rich-text-tab-breadcrumb-root">{item.label}</span>
                  <span className="rich-text-tab-breadcrumb-child">› {labelOf(activeChild)}</span>
                </span>
              ) : (
                <span className="rich-text-tab-name">{item.label}</span>
              )}
              {item.children && (
                <button
                  type="button"
                  className="rich-text-tab-family-btn"
                  title={`${descendants.length} subpage${descendants.length === 1 ? '' : 's'}`}
                  aria-haspopup="menu"
                  aria-expanded={familyFlyout?.rootId === item.id}
                  tabIndex={-1}
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    setFamilyFlyout((f) =>
                      f?.rootId === item.id ? null : { rootId: item.id, x: r.left, y: r.bottom + 4 },
                    );
                  }}
                >
                  <span className="rich-text-tab-family-count">{descendants.length}</span>
                  <Icon icon={ChevronDown} size={11} />
                </button>
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
            </div>
          );
        }}
        onAdd={handleAddPage}
        addLabel="Page"
        addTitle="Add a writing page"
      />

      <PageMenu
        anchor={menuPageId ? menu : null}
        entries={menuEntries}
        title={menuPageId ? labelOf(menuPageId) : ''}
        subtitle={menuFacts}
        onClose={() => setMenu(null)}
      />
      {card.element}

      {/* Family flyout (JP-475): the logical descendants of one root, indented;
          complete regardless of physical scatter in pageOrder. */}
      {familyFlyout && createPortal(
        (() => {
          const root = pages[familyFlyout.rootId];
          if (!root) return null;
          const pos = adjustedFlyoutPos ?? { x: familyFlyout.x, y: familyFlyout.y };
          const pick = (pageId: string) => {
            setActivePage(pageId);
            setFamilyFlyout(null);
          };
          return (
            <div
              ref={familyFlyoutRef}
              className="rich-text-tab-context-menu rich-text-tab-family-flyout"
              role="menu"
              style={{ left: pos.x, top: pos.y }}
            >
              <div
                className={`rich-text-tab-context-item rich-text-tab-family-row ${
                  activePageId === familyFlyout.rootId ? 'active' : ''
                }`}
                onClick={() => pick(familyFlyout.rootId)}
              >
                {root.mirror ? mirrorGlyph(root.mirror.provider) : proseKindIcon}
                <span className="rich-text-tab-family-row-name">{labelOf(familyFlyout.rootId)}</span>
              </div>
              {descendantEntries(familyIndex, familyFlyout.rootId).map(({ pageId, depth }) => {
                const p = pages[pageId];
                if (!p) return null;
                return (
                  <div
                    key={pageId}
                    className={`rich-text-tab-context-item rich-text-tab-family-row ${
                      activePageId === pageId ? 'active' : ''
                    }`}
                    style={{ paddingLeft: 10 + depth * 14 }}
                    onClick={() => pick(pageId)}
                  >
                    {p.mirror ? mirrorGlyph(p.mirror.provider) : proseKindIcon}
                    <span className="rich-text-tab-family-row-name">{labelOf(pageId)}</span>
                  </div>
                );
              })}
            </div>
          );
        })(),
        document.body
      )}

      {/* Resource browser (JP-415). */}
      {pickerProvider && (
        <MirrorResourcePicker provider={pickerProvider} onClose={() => setPickerProvider(null)} />
      )}

      {/* Subpage ingestion (JP-475). */}
      {ingestPageId && (
        <IngestSubpagesDialog pageId={ingestPageId} onClose={() => setIngestPageId(null)} />
      )}
    </>
  );
}
