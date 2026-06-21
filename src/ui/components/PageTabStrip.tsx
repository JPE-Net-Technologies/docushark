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
import { MoreHorizontal } from 'lucide-react';
import { Icon } from '../icons';
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
}

interface PageTabStripProps {
  items: PageTabStripItem[];
  activeId: string | null;
  /** Jump to a page chosen from the overflow menu. */
  onSelect: (id: string) => void;
  /**
   * Render one tab. The returned element MUST carry `data-page-id={item.id}` so
   * the strip can scroll the active tab into view.
   */
  renderTab: (item: PageTabStripItem, index: number) => ReactNode;
  /** The add (+) button — consumer-owned so it keeps its offline guard etc. */
  addButton?: ReactNode;
  /** Extra content pinned flush-right (e.g. the editor's ⋮ actions menu). */
  trailing?: ReactNode;
  /** Outer class (the consumer's bg/border/padding lives here). */
  className?: string;
  ariaLabel?: string;
}

const CLOSE_DELAY_MS = 200;

export function PageTabStrip({
  items,
  activeId,
  onSelect,
  renderTab,
  addButton,
  trailing,
  className,
  ariaLabel,
}: PageTabStripProps) {
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

  return (
    <div ref={rootRef} className={`page-tab-strip ${className ?? ''}`.trim()} aria-label={ariaLabel}>
      <div className="page-tab-strip-scroll" ref={scrollRef} role="tablist">
        {items.map((item, index) => renderTab(item, index))}
      </div>

      {addButton}

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
              {items.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={item.id === activeId}
                  className={`page-tab-strip-menu-item ${item.id === activeId ? 'active' : ''}`}
                  onClick={() => handlePick(item.id)}
                >
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
