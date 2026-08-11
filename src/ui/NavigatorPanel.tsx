/**
 * NavigatorPanel (JP-475) — the per-document hub: composition + sources.
 *
 * Two sections, matching how export actually works (prose and canvas are two
 * independent `pageOrder` sequences in the PDF pipeline):
 *  - Prose pages: top-level rows in physical order; a family root renders its
 *    LOGICAL descendants indented beneath it, and the whole block drags as one
 *    unit (a ReorderableList row = one top-level block). Mirror rows carry the
 *    provider glyph, staleness, and a kebab of mirror actions — including the
 *    per-SUBPAGE actions the tab bar cannot offer (its context menu binds to
 *    the root tab).
 *  - Canvas pages: flat list, reorder + jump.
 *
 * Provider-agnostic by construction: everything rendered comes from page
 * mirror state + integrationHubStore labels. Reordering touches ONLY the
 * physical order; "Match structure" normalizes it to the logical tree
 * (depth-first) — the repair for user-scattered families.
 *
 * ## Reading the hierarchy
 *
 * Depth is drawn, not padded: a row at depth d renders d guide columns, each a
 * hairline rail, so sibling sets line up on a shared spine and the row's own
 * background still spans the full panel width. The guides along the path to the
 * ACTIVE page render lit — in a 25-page family scrolled past its root, the lit
 * spine is what tells you which branch you are inside. That is the one loud
 * thing here; everything else stays quiet on purpose:
 *
 *  - No elbow connectors. Continuous rails read faster and cost less ink.
 *  - Descendants drop the provider glyph, which the root already established.
 *    A glyph on a descendant therefore means its provider DIFFERS from its
 *    root's — the only case where repeating it is news rather than noise.
 *
 * Branch collapse is deliberately ephemeral (local state, not
 * `uiPreferencesStore`): persisting it would cost a store version bump and a
 * migration for a preference that is one click to re-establish.
 */
import { useCallback, useMemo, useState } from 'react';
import {
  ArrowDownWideNarrow,
  ChevronRight,
  GripVertical,
  MoreHorizontal,
  PanelLeftClose,
  PanelRightClose,
  RefreshCw,
} from 'lucide-react';
import { Icon } from './icons';

import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { usePageStore } from '../store/pageStore';
import { providerLabel, useIntegrationHubStore } from '../store/integrationHubStore';
import { useNotificationStore } from '../store/notificationStore';
import {
  buildMirrorFamilyIndex,
  descendantEntries,
  familyBlock,
  isFamilyRoot,
} from '../services/mirrorFamily';
import { refreshMirrorPage, detachMirrorPage } from '../services/mirrorPageService';
import { IngestSubpagesDialog } from './integrations/IngestSubpagesDialog';
import { ProviderIcon } from './integrations/ProviderIcon';
import { ReorderableList } from './properties/ReorderableList';
import { DropdownMenu, menuAction, MENU_SEPARATOR, type DropdownMenuEntry } from './components/DropdownMenu';
import { confirmDialog, promptDialog } from './confirm/confirmStore';
import { useActivePanelState, useLayoutActions } from './layout/useLayout';
import { opener } from '../platform/opener';
import './NavigatorPanel.css';

/** Width of one guide column. Also the twisty's box, so a branch toggle costs
 *  no horizontal room beyond the indent it already occupies. */
const INDENT_PX = 14;

/** Compact staleness for a mirror row ("23m", "5d") — the row is 260px wide
 *  and the page name always wins; the title attr carries the sentence. */
function syncedShort(syncedAt: number, now = Date.now()): string {
  const mins = Math.max(0, Math.floor((now - syncedAt) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

/** Same pacing as batch ingest — provider rate limits, no retry infra. */
const REFRESH_DELAY_MS = 350;

/** Which list a right-clicked row belongs to — the two sections have different
 *  stores and therefore different action sets. */
type RowKind = 'prose' | 'canvas';

interface RowMenuTarget {
  kind: RowKind;
  pageId: string;
  x: number;
  y: number;
}

export function NavigatorPanel() {
  const { pages, pageOrder, activePageId, setActivePage, movePages, deletePage, renamePage } =
    useRichTextPagesStore();
  const canvasPages = usePageStore((s) => s.pages);
  const canvasOrder = usePageStore((s) => s.pageOrder);
  const canvasActiveId = usePageStore((s) => s.activePageId);
  const setCanvasActive = usePageStore((s) => s.setActivePage);
  const reorderCanvas = usePageStore((s) => s.reorderPages);
  const renameCanvasPage = usePageStore((s) => s.renamePage);
  const duplicateCanvasPage = usePageStore((s) => s.duplicatePage);
  const deleteCanvasPage = usePageStore((s) => s.deletePage);
  const hub = useIntegrationHubStore((s) => s.hub);

  const navigatorState = useActivePanelState('navigator');
  const { setPanelVisible } = useLayoutActions();

  const [ingestPageId, setIngestPageId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);
  const [collapsedIds, setCollapsedIds] = useState<ReadonlySet<string>>(() => new Set<string>());
  const [rowMenu, setRowMenu] = useState<RowMenuTarget | null>(null);

  const familyIndex = useMemo(() => buildMirrorFamilyIndex(pages, pageOrder), [pages, pageOrder]);
  const topLevel = useMemo(
    () => pageOrder.filter((id) => pages[id] !== undefined && isFamilyRoot(familyIndex, id)),
    [pageOrder, pages, familyIndex],
  );
  const blocks = useMemo(
    () => topLevel.map((id) => (familyIndex.childrenOf.has(id) ? familyBlock(familyIndex, pageOrder, id) : [id])),
    [topLevel, familyIndex, pageOrder],
  );

  /** Ancestors of a page, root-first — index `c` is the ancestor at depth `c`,
   *  which is exactly the guide column that represents it. */
  const ancestorsOf = useCallback(
    (pageId: string): string[] => {
      const chain: string[] = [];
      let cur = familyIndex.parentOf.get(pageId);
      // `parentOf` already drops cyclic edges; the seen-check is belt-and-braces
      // so a malformed index can never spin here.
      while (cur !== undefined && !chain.includes(cur)) {
        chain.unshift(cur);
        cur = familyIndex.parentOf.get(cur);
      }
      return chain;
    },
    [familyIndex],
  );

  /** The active page plus every ancestor of it — the ids whose guide columns
   *  render lit. */
  const litPath = useMemo(() => {
    const set = new Set<string>();
    if (activePageId === null) return set;
    set.add(activePageId);
    let cur = familyIndex.parentOf.get(activePageId);
    while (cur !== undefined && !set.has(cur)) {
      set.add(cur);
      cur = familyIndex.parentOf.get(cur);
    }
    return set;
  }, [activePageId, familyIndex]);

  /** Descendants of a root that survive the collapse state. Reordering is
   *  unaffected: drag still moves the whole `familyBlock`, hidden rows and all. */
  const visibleDescendants = useCallback(
    (rootId: string) =>
      descendantEntries(familyIndex, rootId).filter(
        ({ pageId }) => !ancestorsOf(pageId).some((a) => collapsedIds.has(a)),
      ),
    [familyIndex, ancestorsOf, collapsedIds],
  );

  const toggleCollapsed = useCallback((pageId: string) => {
    setCollapsedIds((prev) => {
      const next = new Set(prev);
      if (next.has(pageId)) next.delete(pageId);
      else next.add(pageId);
      return next;
    });
  }, []);

  /** Providers with at least one mirror page in this document. */
  const docProviders = useMemo(() => {
    const set = new Set<string>();
    for (const id of pageOrder) {
      const m = pages[id]?.mirror;
      if (m) set.add(m.provider);
    }
    return [...set];
  }, [pages, pageOrder]);

  const handleTopLevelReorder = (fromIndex: number, toIndex: number) => {
    const moved = blocks[fromIndex];
    if (!moved) return;
    const rest = blocks.filter((_, i) => i !== fromIndex);
    const itemTo = Math.max(0, Math.min(toIndex, rest.length));
    const pagesBefore = rest.slice(0, itemTo).reduce((n, b) => n + b.length, 0);
    movePages(moved, pagesBefore);
  };

  /** Normalize physical order to the logical tree: each root block (root plus
   *  ALL logical descendants — strays pulled home) moves to the end in current
   *  top-level order, so the result reads depth-first. */
  const handleOrderToStructure = () => {
    for (const rootId of topLevel) {
      const ids = [rootId, ...descendantEntries(familyIndex, rootId).map((e) => e.pageId)];
      movePages(ids, useRichTextPagesStore.getState().pageOrder.length);
    }
  };

  const handleRefreshAll = async (provider: string) => {
    if (refreshingAll) return;
    setRefreshingAll(true);
    const notifications = useNotificationStore.getState();
    const targets = useRichTextPagesStore
      .getState()
      .pageOrder.filter((id) => useRichTextPagesStore.getState().pages[id]?.mirror?.provider === provider);
    let ok = 0;
    let failed = 0;
    for (const id of targets) {
      try {
        if (ok + failed > 0) await new Promise((r) => setTimeout(r, REFRESH_DELAY_MS));
        await refreshMirrorPage(id);
        ok += 1;
      } catch {
        failed += 1;
      }
    }
    setRefreshingAll(false);
    if (failed > 0) notifications.error(`Refreshed ${ok} page(s); ${failed} failed.`);
    else notifications.success(`Refreshed ${ok} page(s) from ${providerLabel(hub, provider)}.`);
  };

  /** Rename via the shared prompt dialog — the row is 260px wide and an inline
   *  editor there fights the guides for space. */
  const promptRename = (currentName: string, apply: (name: string) => void) => {
    void promptDialog({
      title: 'Rename page',
      label: 'Page name',
      initialValue: currentName,
      confirmLabel: 'Rename',
    }).then((name) => {
      if (name !== null) apply(name);
    });
  };

  const promptDelete = (name: string, apply: () => void) => {
    void confirmDialog({
      title: `Delete "${name}"?`,
      message: 'The page and its content are removed from this document.',
      confirmLabel: 'Delete',
      danger: true,
    }).then((confirmed) => {
      if (confirmed) apply();
    });
  };

  /** Mirror-specific actions, appended to a mirror page's menu. */
  const mirrorMenuEntries = (pageId: string): DropdownMenuEntry[] => {
    const page = pages[pageId];
    const m = page?.mirror;
    if (!page || !m) return [];
    const label = providerLabel(hub, m.provider);
    return [
      menuAction({
        id: 'refresh',
        label: 'Refresh from source',
        onSelect: () => {
          void refreshMirrorPage(pageId).catch((e: unknown) => {
            useNotificationStore.getState().error(e instanceof Error ? e.message : 'Refresh failed.');
          });
        },
      }),
      menuAction({ id: 'ingest', label: 'Ingest subpages…', onSelect: () => setIngestPageId(pageId) }),
      ...(m.url
        ? [
            menuAction({
              id: 'open-external',
              label: `Open in ${label}`,
              onSelect: () => void opener.openExternalUrl(m.url!),
            }),
          ]
        : []),
      menuAction({
        id: 'detach',
        label: `Detach from ${label}`,
        onSelect: () => {
          void confirmDialog({
            title: `Detach from ${label}?`,
            message: 'The page becomes a normal, editable page with the content as last synced.',
            confirmLabel: 'Detach',
          }).then((confirmed) => {
            if (confirmed) detachMirrorPage(pageId);
          });
        },
      }),
    ];
  };

  /** One menu description per prose row, shared by the kebab and the
   *  right-click menu so the two can never drift. */
  const proseMenuEntries = (pageId: string): DropdownMenuEntry[] => {
    const page = pages[pageId];
    if (!page) return [];
    const hasChildren = (familyIndex.childrenOf.get(pageId) ?? []).length > 0;
    const entries: DropdownMenuEntry[] = [
      menuAction({ id: 'open', label: 'Open', onSelect: () => setActivePage(pageId) }),
      menuAction({
        id: 'rename',
        label: 'Rename…',
        onSelect: () => promptRename(page.name, (name) => renamePage(pageId, name)),
      }),
    ];
    if (hasChildren) {
      entries.push(
        menuAction({
          id: 'collapse',
          label: collapsedIds.has(pageId) ? 'Expand subpages' : 'Collapse subpages',
          onSelect: () => toggleCollapsed(pageId),
        }),
      );
    }
    const mirror = mirrorMenuEntries(pageId);
    if (mirror.length > 0) entries.push(MENU_SEPARATOR, ...mirror);
    entries.push(
      MENU_SEPARATOR,
      menuAction({
        id: 'delete',
        label: 'Delete page',
        danger: true,
        // The store silently refuses to delete the last page; say so instead.
        disabled: pageOrder.length <= 1,
        onSelect: () => promptDelete(page.name, () => deletePage(pageId)),
      }),
    );
    return entries;
  };

  const canvasMenuEntries = (pageId: string): DropdownMenuEntry[] => {
    const page = canvasPages[pageId];
    if (!page) return [];
    return [
      menuAction({ id: 'open', label: 'Open', onSelect: () => setCanvasActive(pageId) }),
      menuAction({
        id: 'rename',
        label: 'Rename…',
        onSelect: () => promptRename(page.name, (name) => renameCanvasPage(pageId, name)),
      }),
      menuAction({ id: 'duplicate', label: 'Duplicate', onSelect: () => void duplicateCanvasPage(pageId) }),
      MENU_SEPARATOR,
      menuAction({
        id: 'delete',
        label: 'Delete page',
        danger: true,
        disabled: canvasOrder.length <= 1,
        onSelect: () => promptDelete(page.name, () => deleteCanvasPage(pageId)),
      }),
    ];
  };

  const openRowMenu = (kind: RowKind, pageId: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setRowMenu({ kind, pageId, x: e.clientX, y: e.clientY });
  };

  /** The guide columns for a row, lit along the active page's ancestry. */
  const guides = (chain: string[]) =>
    chain.map((ancestorId, depth) => (
      <span
        key={`${ancestorId}-${depth}`}
        className={`navigator-guide ${litPath.has(ancestorId) ? 'lit' : ''}`}
        style={{ width: INDENT_PX }}
        aria-hidden="true"
      />
    ));

  const proseRow = (pageId: string, depth: number) => {
    const page = pages[pageId];
    if (!page) return null;
    const m = page.mirror;
    const chain = ancestorsOf(pageId);
    const rootId = chain[0];
    const rootProvider = rootId !== undefined ? pages[rootId]?.mirror?.provider : undefined;
    // Depth 0 establishes the family's provider; deeper rows only show a glyph
    // when theirs differs, which is the anomaly worth noticing.
    const showGlyph = m !== undefined && (depth === 0 || m.provider !== rootProvider);
    const childCount = (familyIndex.childrenOf.get(pageId) ?? []).length;
    const isCollapsed = collapsedIds.has(pageId);

    return (
      <div
        key={pageId}
        className={`navigator-row ${activePageId === pageId ? 'active' : ''}`}
        onContextMenu={(e) => openRowMenu('prose', pageId, e)}
      >
        {guides(chain)}
        {childCount > 0 ? (
          <button
            type="button"
            className={`navigator-twisty ${isCollapsed ? 'collapsed' : ''}`}
            style={{ width: INDENT_PX }}
            onClick={(e) => {
              e.stopPropagation();
              toggleCollapsed(pageId);
            }}
            aria-expanded={!isCollapsed}
            title={
              isCollapsed
                ? `Show ${childCount} subpage${childCount === 1 ? '' : 's'}`
                : `Hide ${childCount} subpage${childCount === 1 ? '' : 's'}`
            }
          >
            <Icon icon={ChevronRight} size={12} />
          </button>
        ) : (
          <span className="navigator-twisty-spacer" style={{ width: INDENT_PX }} aria-hidden="true" />
        )}
        <button
          type="button"
          className="navigator-row-main"
          onClick={() => setActivePage(pageId)}
          // Without this the name and the staleness badge run together into
          // "Concepts8d" for a screen reader.
          aria-label={m ? `${page.name}, synced ${syncedShort(m.syncedAt)} ago` : page.name}
        >
          {showGlyph && m && <ProviderIcon provider={m.provider} size={13} />}
          <span className="navigator-row-name">{page.name}</span>
          {m && (
            <span
              className="navigator-row-synced"
              title={`Last synced ${syncedShort(m.syncedAt)} ago`}
              aria-hidden="true"
            >
              {syncedShort(m.syncedAt)}
            </span>
          )}
        </button>
        <DropdownMenu
          trigger={<Icon icon={MoreHorizontal} size={14} />}
          triggerTitle={`Actions for ${page.name}`}
          triggerClassName="navigator-row-menu"
          entries={proseMenuEntries(pageId)}
        />
      </div>
    );
  };

  const dockedRight = navigatorState.dock === 'right';

  return (
    <div className="navigator-panel" aria-label="Navigator">
      <div className="navigator-section-head">
        <h3>Pages</h3>
        <div className="navigator-head-actions">
          {docProviders.map((p) => (
            <button
              key={p}
              type="button"
              className="navigator-head-btn"
              disabled={refreshingAll}
              title={`Refresh every ${providerLabel(hub, p)} page from its source`}
              onClick={() => void handleRefreshAll(p)}
            >
              <Icon icon={RefreshCw} size={13} />
              {providerLabel(hub, p)}
            </button>
          ))}
          {familyIndex.parentOf.size > 0 && (
            <button
              type="button"
              className="navigator-head-btn"
              title="Reorder pages to read depth-first, matching the subpage structure"
              onClick={handleOrderToStructure}
            >
              <Icon icon={ArrowDownWideNarrow} size={13} />
              Match structure
            </button>
          )}
          <button
            type="button"
            className="navigator-collapse-btn"
            onClick={() => setPanelVisible('navigator', false)}
            title="Hide the Navigator — reopen it from the layout menu in the toolbar"
            aria-label="Hide Navigator panel"
          >
            <Icon icon={dockedRight ? PanelRightClose : PanelLeftClose} size={14} />
          </button>
        </div>
      </div>

      <ReorderableList
        items={topLevel}
        getKey={(id) => id}
        onReorder={handleTopLevelReorder}
        listClassName="navigator-list"
        rowClassName="navigator-block"
        renderItem={(id, _index, handleProps) => (
          <div className="navigator-block-inner">
            <span className="navigator-drag-handle" {...handleProps}>
              <Icon icon={GripVertical} size={13} />
            </span>
            <div className="navigator-block-rows">
              {proseRow(id, 0)}
              {visibleDescendants(id).map(({ pageId, depth }) => proseRow(pageId, depth))}
            </div>
          </div>
        )}
      />

      <div className="navigator-section-head">
        <h3>Canvas pages</h3>
      </div>
      <ReorderableList
        items={canvasOrder}
        getKey={(id) => id}
        onReorder={(from, to) => {
          const next = [...canvasOrder];
          const [moved] = next.splice(from, 1);
          if (moved !== undefined) {
            next.splice(to, 0, moved);
            reorderCanvas(next);
          }
        }}
        listClassName="navigator-list"
        rowClassName="navigator-block"
        renderItem={(id, _index, handleProps) => (
          <div className="navigator-block-inner">
            <span className="navigator-drag-handle" {...handleProps}>
              <Icon icon={GripVertical} size={13} />
            </span>
            <div
              className={`navigator-row ${canvasActiveId === id ? 'active' : ''}`}
              onContextMenu={(e) => openRowMenu('canvas', id, e)}
            >
              <span className="navigator-twisty-spacer" style={{ width: INDENT_PX }} aria-hidden="true" />
              <button
                type="button"
                className="navigator-row-main"
                onClick={() => setCanvasActive(id)}
                aria-label={canvasPages[id]?.name ?? 'Untitled'}
              >
                <span className="navigator-row-name">{canvasPages[id]?.name ?? 'Untitled'}</span>
              </button>
              <DropdownMenu
                trigger={<Icon icon={MoreHorizontal} size={14} />}
                triggerTitle={`Actions for ${canvasPages[id]?.name ?? 'this page'}`}
                triggerClassName="navigator-row-menu"
                entries={canvasMenuEntries(id)}
              />
            </div>
          </div>
        )}
      />

      {/* One controlled, trigger-less menu serves every right-click in the
          panel — the entries come from the same builders the kebabs use. */}
      {rowMenu && (
        <DropdownMenu
          open
          onOpenChange={(next) => {
            if (!next) setRowMenu(null);
          }}
          anchorPoint={{ x: rowMenu.x, y: rowMenu.y }}
          entries={
            rowMenu.kind === 'prose' ? proseMenuEntries(rowMenu.pageId) : canvasMenuEntries(rowMenu.pageId)
          }
        />
      )}

      {ingestPageId && <IngestSubpagesDialog pageId={ingestPageId} onClose={() => setIngestPageId(null)} />}
    </div>
  );
}
