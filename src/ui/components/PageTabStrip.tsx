/**
 * PageTabStrip — the shared scroll/overflow shell for a row of page tabs,
 * consumed by both the prose tab bar (`RichTextTabBar`) and the canvas tab bar
 * (`InlinePageTabs`). It owns the behaviour that used to be duplicated (and
 * broken) in each:
 *
 * - The native horizontal scrollbar is **hidden** (it previously cut across the
 *   active prose tab; canvas hid it but then gave no overflow affordance).
 * - When the tabs overflow, a trailing **`⋯` button** appears and — on hover or
 *   click — opens a dropdown of every page so nothing is stranded off-screen.
 * - The active tab is kept scrolled into view.
 *
 * Each consumer still renders its own tab markup (drag, colour, inline rename,
 * context menu) via `renderTab`; the rendered tab root must carry
 * `data-page-id` so the strip can find the active tab. The add (+) button and
 * any flush-right `trailing` content are passed in as slots.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { MoreHorizontal, Plus } from 'lucide-react';
import { Icon } from '../icons';
import { useActiveDocReadOnly } from '../../store/documentRegistry';
import { useBreakpoint } from '../layout/useBreakpoint';
import './PageTabStrip.css';

export interface PageTabStripItem {
  /** Stable page id. */
  id: string;
  /** Display name, used for the overflow-menu row. */
  label: string;
  /** Optional colour dot (prose pages). */
  color?: string;
  /** Optional kind icon (canvas vs prose), shown in the overflow-menu row. */
  icon?: ReactNode;
  /** Pages grouped UNDER this tab (JP-475 mirror families). They render no
   *  tab of their own; the overflow menu lists them indented so every page
   *  stays reachable, and the consumer provides its own expanded navigation
   *  (e.g. a flyout on the tab). */
  children?: PageTabStripItem[];
}

/** Overflow-menu rows: the item tree flattened depth-first with indent depth. */
function menuRows(items: PageTabStripItem[], depth = 0): { item: PageTabStripItem; depth: number }[] {
  return items.flatMap((item) => [{ item, depth }, ...menuRows(item.children ?? [], depth + 1)]);
}

interface PageTabStripProps {
  items: PageTabStripItem[];
  activeId: string | null;
  /** Jump to a page chosen from the overflow menu. */
  onSelect: (id: string) => void;
  /**
   * Render one tab. The returned element MUST carry `data-page-id={item.id}` so
   * the strip can scroll the active tab into view and move focus between tabs,
   * and must take `tab.tabIndex`: the row is one tab stop (DSK-260).
   */
  renderTab: (item: PageTabStripItem, index: number, tab: PageTabProps) => ReactNode;
  /** Add-page handler — renders the shared "+" button when provided. The
   *  button's rect is passed so a consumer can anchor an add-menu to it
   *  (JP-415); consumers that add directly simply ignore it. */
  onAdd?: (anchorRect?: DOMRect) => void;
  /** Mute the add button (e.g. a shared doc is offline). Still clickable so the
   *  handler can surface a reason. */
  addDisabled?: boolean;
  /** Tooltip / aria-label for the add button. */
  addTitle?: string;
  /** Text beside the add button's "+" ("Page", "Diagram"), saying what it adds (DSK-260). */
  addLabel?: string;
  /** Extra content pinned flush-right (e.g. the editor's ⋮ actions menu). */
  trailing?: ReactNode;
  /** Outer class (the consumer's bg/border/padding lives here). */
  className?: string;
  ariaLabel?: string;
}

/** What the strip asks of each tab it renders. */
export interface PageTabProps {
  /** 0 for the one tab the row's tab stop lands on, -1 for the rest. */
  tabIndex: 0 | -1;
}

const CLOSE_DELAY_MS = 200;

/** The top-level item showing `activeId`: itself, or the family it belongs to. */
function itemShowing(items: PageTabStripItem[], activeId: string | null): string | null {
  if (activeId === null) return null;
  const holds = (item: PageTabStripItem): boolean =>
    item.id === activeId || (item.children ?? []).some(holds);
  return items.find(holds)?.id ?? null;
}

export function PageTabStrip({
  items,
  activeId,
  onSelect,
  renderTab,
  onAdd,
  addDisabled,
  addTitle,
  addLabel,
  trailing,
  className,
  ariaLabel,
}: PageTabStripProps) {
  const { isTouch } = useBreakpoint();
  // One tab stop for the row (DSK-260): the tab showing the open page, else the first.
  const stopId = itemShowing(items, activeId) ?? items[0]?.id ?? null;
  /**
   * Adding a page is a WRITE. Gated here rather than at each consumer
   * (`InlinePageTabs`, `RichTextTabBar`) because both are document page
   * strips and a per-consumer guard is the exact pattern that let this ship:
   * the rule lived in one predicate while the decision to consult it lived at
   * every call site (the JP-457 lesson). Found live on a published document,
   * but it applied to any view-only doc — a workspace viewer could add pages
   * the relay would then refuse.
   */
  const docReadOnly = useActiveDocReadOnly();
  const scrollRef = useRef<HTMLDivElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [overflowing, setOverflowing] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  // Recompute overflow whenever the row resizes or its contents change.
  const recompute = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    setOverflowing(el.scrollWidth - el.clientWidth > 1);
  }, []);

  useLayoutEffect(() => {
    recompute();
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(recompute);
    ro.observe(el);
    return () => ro.disconnect();
  }, [recompute, items]);

  // Keep the active tab visible.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeId) return;
    const escaped = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(activeId) : activeId;
    const tab = el.querySelector<HTMLElement>(`[data-page-id="${escaped}"]`);
    tab?.scrollIntoView?.({ behavior: 'smooth', inline: 'nearest', block: 'nearest' });
  }, [activeId, items]);

  // A page that scrolls off can no longer overflow → drop the menu.
  useEffect(() => {
    if (!overflowing && menuOpen) setMenuOpen(false);
  }, [overflowing, menuOpen]);

  const cancelClose = useCallback(() => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  }, []);

  const openMenu = useCallback(() => {
    cancelClose();
    setMenuOpen(true);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimer.current = setTimeout(() => setMenuOpen(false), CLOSE_DELAY_MS);
  }, [cancelClose]);

  useEffect(() => () => cancelClose(), [cancelClose]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [menuOpen]);

  const handlePick = useCallback(
    (id: string) => {
      onSelect(id);
      setMenuOpen(false);
    },
    [onSelect]
  );

  // Arrow keys, Home and End move between tabs; Enter or Space opens the one
  // focused (DSK-260). The menu key and Shift+F10 fire the tab's own
  // `contextmenu`, which opens its page menu.
  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const target = e.target as HTMLElement;
      if (target.closest('input, textarea')) return; // renaming
      const tab = target.closest<HTMLElement>('[data-page-id]');
      const row = scrollRef.current;
      if (!tab || !row || target !== tab) return;
      const tabs = Array.from(row.querySelectorAll<HTMLElement>('[data-page-id]'));
      const at = tabs.indexOf(tab);
      let next: HTMLElement | undefined;
      if (e.key === 'ArrowRight') next = tabs[at + 1];
      else if (e.key === 'ArrowLeft') next = tabs[at - 1];
      else if (e.key === 'Home') next = tabs[0];
      else if (e.key === 'End') next = tabs[tabs.length - 1];
      else if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        const id = tab.dataset['pageId'];
        if (id) onSelect(id);
        return;
      } else return;
      e.preventDefault();
      next?.focus();
      next?.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    },
    [onSelect]
  );

  const addText = addTitle ?? 'Add page';

  return (
    <div
      ref={rootRef}
      className={`page-tab-strip ${isTouch ? 'page-tab-strip--touch' : ''} ${className ?? ''}`.replace(/\s+/g, ' ').trim()}
      aria-label={ariaLabel}
    >
      <div className="page-tab-strip-scroll" ref={scrollRef} role="tablist" onKeyDown={handleKeyDown}>
        {items.map((item, index) => renderTab(item, index, { tabIndex: item.id === stopId ? 0 : -1 }))}
      </div>

      {onAdd && !docReadOnly && (
        <button
          type="button"
          className={`page-tab-strip-add ${addLabel ? 'page-tab-strip-add--labelled' : ''}`.trim()}
          onClick={(e) => onAdd(e.currentTarget.getBoundingClientRect())}
          aria-disabled={addDisabled}
          data-disabled={addDisabled || undefined}
          title={addText}
          aria-label={addText}
        >
          <Icon icon={Plus} size={16} />
          {addLabel && <span className="page-tab-strip-add-label">{addLabel}</span>}
        </button>
      )}

      {overflowing && (
        <div
          className="page-tab-strip-overflow"
          onMouseEnter={openMenu}
          onMouseLeave={scheduleClose}
        >
          <button
            type="button"
            className="page-tab-strip-overflow-btn"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            aria-label="All pages"
            title="All pages"
            onClick={() => (menuOpen ? setMenuOpen(false) : openMenu())}
          >
            <Icon icon={MoreHorizontal} size={16} />
          </button>

          {menuOpen && (
            <div className="page-tab-strip-menu" role="menu">
              {menuRows(items).map(({ item, depth }) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.id === activeId}
                  className={`page-tab-strip-menu-item ${item.id === activeId ? 'active' : ''}`}
                  onClick={() => handlePick(item.id)}
                >
                  {depth > 0 && <span className="page-tab-strip-menu-indent" style={{ width: depth * 14 }} />}
                  {item.color ? (
                    <span
                      className="page-tab-strip-menu-dot"
                      style={{ background: item.color }}
                    />
                  ) : item.icon ? (
                    <span className="page-tab-strip-menu-icon">{item.icon}</span>
                  ) : (
                    <span className="page-tab-strip-menu-icon" />
                  )}
                  <span className="page-tab-strip-menu-label">{item.label}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {trailing && <div className="page-tab-strip-trailing">{trailing}</div>}
    </div>
  );
}
