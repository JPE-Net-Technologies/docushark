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
 */
import { useMemo, useState } from 'react';
import { ArrowDownWideNarrow, GripVertical, MoreHorizontal, RefreshCw } from 'lucide-react';
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
import { confirmDialog } from './confirm/confirmStore';
import { opener } from '../platform/opener';
import './NavigatorPanel.css';

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

export function NavigatorPanel() {
  const { pages, pageOrder, activePageId, setActivePage, movePages, deletePage } = useRichTextPagesStore();
  const canvasPages = usePageStore((s) => s.pages);
  const canvasOrder = usePageStore((s) => s.pageOrder);
  const canvasActiveId = usePageStore((s) => s.activePageId);
  const setCanvasActive = usePageStore((s) => s.setActivePage);
  const reorderCanvas = usePageStore((s) => s.reorderPages);
  const hub = useIntegrationHubStore((s) => s.hub);

  const [ingestPageId, setIngestPageId] = useState<string | null>(null);
  const [refreshingAll, setRefreshingAll] = useState(false);

  const familyIndex = useMemo(() => buildMirrorFamilyIndex(pages, pageOrder), [pages, pageOrder]);
  const topLevel = useMemo(
    () => pageOrder.filter((id) => pages[id] !== undefined && isFamilyRoot(familyIndex, id)),
    [pageOrder, pages, familyIndex],
  );
  const blocks = useMemo(
    () => topLevel.map((id) => (familyIndex.childrenOf.has(id) ? familyBlock(familyIndex, pageOrder, id) : [id])),
    [topLevel, familyIndex, pageOrder],
  );

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
              id: 'open',
              label: `Open in ${label}`,
              onSelect: () => void opener.openExternalUrl(m.url!),
            }),
          ]
        : []),
      MENU_SEPARATOR,
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
      menuAction({
        id: 'delete',
        label: 'Delete page',
        danger: true,
        onSelect: () => deletePage(pageId),
      }),
    ];
  };

  const proseRow = (pageId: string, depth: number) => {
    const page = pages[pageId];
    if (!page) return null;
    const m = page.mirror;
    return (
      <div
        key={pageId}
        className={`navigator-row ${activePageId === pageId ? 'active' : ''}`}
        style={depth > 0 ? { paddingLeft: depth * 16 } : undefined}
      >
        <button type="button" className="navigator-row-main" onClick={() => setActivePage(pageId)}>
          {m ? <ProviderIcon provider={m.provider} size={13} /> : <span className="navigator-row-dot" />}
          <span className="navigator-row-name">{page.name}</span>
          {m && (
            <span className="navigator-row-synced" title={`Last synced ${syncedShort(m.syncedAt)} ago`}>
              {syncedShort(m.syncedAt)}
            </span>
          )}
        </button>
        {m && (
          <DropdownMenu
            trigger={<Icon icon={MoreHorizontal} size={14} />}
            triggerTitle={`Actions for ${page.name}`}
            triggerClassName="navigator-row-menu"
            entries={mirrorMenuEntries(pageId)}
          />
        )}
      </div>
    );
  };

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
              {descendantEntries(familyIndex, id).map(({ pageId, depth }) => proseRow(pageId, depth))}
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
            <div className={`navigator-row ${canvasActiveId === id ? 'active' : ''}`}>
              <button type="button" className="navigator-row-main" onClick={() => setCanvasActive(id)}>
                <span className="navigator-row-dot" />
                <span className="navigator-row-name">{canvasPages[id]?.name ?? 'Untitled'}</span>
              </button>
            </div>
          </div>
        )}
      />

      {ingestPageId && <IngestSubpagesDialog pageId={ingestPageId} onClose={() => setIngestPageId(null)} />}
    </div>
  );
}
