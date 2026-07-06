/**
 * DropdownMenu — shared portal-based action menu primitive.
 *
 * A trigger button plus a viewport-positioned menu panel (portal to
 * document.body, `position: fixed`), with entries described as data:
 * actions, separators, and one level of submenus. Built for the document
 * browser's per-card overflow ("kebab") menu and the selection bar's
 * assign-to-collection menu, but generic — nothing in here knows about
 * documents.
 *
 * Interaction contract:
 * - Click / Enter / Space on the trigger toggles the menu.
 * - Arrow Up/Down move focus between enabled items (wrapping); Home/End jump.
 * - ArrowRight (or hover/click) opens a submenu; ArrowLeft closes it back to
 *   its parent item; Escape closes everything and returns focus to the trigger.
 * - Selecting an action fires `onSelect` and closes the menu.
 * - Clicks inside the menu never bubble to the surface underneath (cards open
 *   on click — a menu click must not open the card).
 *
 * Positioning reuses the ToolbarDropdown strategy (below the trigger, clamped
 * to the viewport, repositioned on scroll/resize) and `placeFlyout` for
 * submenu placement (viewport-aware side flip; already unit-tested).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronRight } from 'lucide-react';
import { placeFlyout, type FlyoutPlacement } from '../contextMenuUtils';
import './DropdownMenu.css';

export interface DropdownMenuAction {
  id: string;
  label: string;
  /** Leading 16px icon (lucide). */
  icon?: ReactNode | undefined;
  /** Destructive treatment (red), matching the confirm dialog's danger button. */
  danger?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Trailing check for single-select semantics (e.g. current collection). */
  checked?: boolean | undefined;
  /** Leading color dot (collections). `null` renders the neutral dot. */
  swatchColor?: string | null | undefined;
  onSelect: () => void;
}

export type DropdownMenuEntry =
  | { kind: 'action'; action: DropdownMenuAction }
  | { kind: 'separator' }
  | {
      kind: 'submenu';
      id: string;
      label: string;
      icon?: ReactNode | undefined;
      entries: DropdownMenuEntry[];
    };

/** Terse builders so call sites read as a menu description, not object soup. */
export function menuAction(action: DropdownMenuAction): DropdownMenuEntry {
  return { kind: 'action', action };
}
export const MENU_SEPARATOR: DropdownMenuEntry = { kind: 'separator' };

export interface DropdownMenuProps {
  /** Trigger button content (icon and/or label). */
  trigger: ReactNode;
  triggerClassName?: string | undefined;
  /** Tooltip + accessible label for the trigger. */
  triggerTitle?: string | undefined;
  entries: DropdownMenuEntry[];
  /** Which trigger edge the panel aligns to (default 'right'). */
  align?: 'left' | 'right' | undefined;
  /** Fires on open/close — lets a hover-revealed surface pin itself visible. */
  onOpenChange?: ((open: boolean) => void) | undefined;
}

interface PanelPosition {
  top: number;
  left: number;
}

function focusableItems(panel: HTMLElement | null): HTMLButtonElement[] {
  if (!panel) return [];
  return Array.from(
    panel.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'),
  );
}

function moveFocus(panel: HTMLElement | null, delta: 1 | -1): void {
  const items = focusableItems(panel);
  if (items.length === 0) return;
  const current = items.indexOf(document.activeElement as HTMLButtonElement);
  const next =
    current === -1
      ? delta === 1
        ? 0
        : items.length - 1
      : (current + delta + items.length) % items.length;
  items[next]?.focus();
}

export function DropdownMenu({
  trigger,
  triggerClassName,
  triggerTitle,
  entries,
  align = 'right',
  onOpenChange,
}: DropdownMenuProps) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<PanelPosition>({ top: 0, left: 0 });
  const [openSubId, setOpenSubId] = useState<string | null>(null);
  const [subPlacement, setSubPlacement] = useState<FlyoutPlacement | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const subPanelRef = useRef<HTMLDivElement>(null);
  const subAnchorRef = useRef<HTMLButtonElement | null>(null);

  const setOpenNotify = useCallback(
    (next: boolean) => {
      setOpen(next);
      if (!next) {
        setOpenSubId(null);
        setSubPlacement(null);
      }
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const closeAll = useCallback(
    (refocusTrigger: boolean) => {
      setOpenNotify(false);
      if (refocusTrigger) triggerRef.current?.focus();
    },
    [setOpenNotify],
  );

  // Position the panel under the trigger, clamped to the viewport.
  const updatePosition = useCallback(() => {
    if (!triggerRef.current) return;
    const rect = triggerRef.current.getBoundingClientRect();
    const panelWidth = panelRef.current?.offsetWidth ?? 220;
    let left = align === 'right' ? rect.right - panelWidth : rect.left;
    const maxLeft = window.innerWidth - panelWidth - 8;
    left = Math.max(8, Math.min(left, maxLeft));
    // Flip above the trigger when there's no room below.
    const panelHeight = panelRef.current?.offsetHeight ?? 0;
    let top = rect.bottom + 4;
    if (panelHeight > 0 && top + panelHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - 4 - panelHeight);
    }
    setPosition({ top, left });
  }, [align]);

  useLayoutEffect(() => {
    if (open) updatePosition();
  }, [open, updatePosition]);

  // Reposition on scroll/resize while open.
  useEffect(() => {
    if (!open) return;
    const handleUpdate = () => updatePosition();
    window.addEventListener('scroll', handleUpdate, true);
    window.addEventListener('resize', handleUpdate);
    return () => {
      window.removeEventListener('scroll', handleUpdate, true);
      window.removeEventListener('resize', handleUpdate);
    };
  }, [open, updatePosition]);

  // Click outside (trigger + both panels count as inside) closes.
  useEffect(() => {
    if (!open) return;
    const handleOutside = (e: MouseEvent) => {
      const target = e.target as Node;
      if (
        triggerRef.current?.contains(target) ||
        panelRef.current?.contains(target) ||
        subPanelRef.current?.contains(target)
      ) {
        return;
      }
      closeAll(false);
    };
    const timeoutId = setTimeout(() => {
      document.addEventListener('mousedown', handleOutside);
    }, 0);
    return () => {
      clearTimeout(timeoutId);
      document.removeEventListener('mousedown', handleOutside);
    };
  }, [open, closeAll]);

  // Focus the first item when the menu opens (keyboard flow starts inside).
  // Effects run post-commit, so the portaled panel is in the DOM already.
  useEffect(() => {
    if (!open) return;
    focusableItems(panelRef.current)[0]?.focus();
  }, [open]);

  // Place the submenu next to its anchor item once both are rendered.
  useLayoutEffect(() => {
    if (!openSubId || !subAnchorRef.current || !subPanelRef.current || !panelRef.current) {
      return;
    }
    const anchorRect = subAnchorRef.current.getBoundingClientRect();
    const parentRect = panelRef.current.getBoundingClientRect();
    const placement = placeFlyout(
      {
        top: anchorRect.top,
        bottom: anchorRect.bottom,
        left: anchorRect.left,
        right: anchorRect.right,
      },
      { left: parentRect.left, right: parentRect.right },
      {
        width: subPanelRef.current.offsetWidth,
        height: subPanelRef.current.offsetHeight,
      },
    );
    setSubPlacement(placement);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSubId]);

  useEffect(() => {
    if (!openSubId) return;
    focusableItems(subPanelRef.current)[0]?.focus();
  }, [openSubId]);

  const openSubmenu = useCallback((id: string, anchor: HTMLButtonElement) => {
    subAnchorRef.current = anchor;
    setSubPlacement(null); // measured + placed by the layout effect
    setOpenSubId(id);
  }, []);

  const closeSubmenu = useCallback((refocusAnchor: boolean) => {
    setOpenSubId(null);
    setSubPlacement(null);
    if (refocusAnchor) subAnchorRef.current?.focus();
  }, []);

  const handleSelect = useCallback(
    (action: DropdownMenuAction) => {
      closeAll(false);
      action.onSelect();
    },
    [closeAll],
  );

  const handlePanelKeyDown = useCallback(
    (e: React.KeyboardEvent, panel: 'root' | 'sub') => {
      const el = panel === 'root' ? panelRef.current : subPanelRef.current;
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          moveFocus(el, 1);
          break;
        case 'ArrowUp':
          e.preventDefault();
          moveFocus(el, -1);
          break;
        case 'Home':
          e.preventDefault();
          focusableItems(el)[0]?.focus();
          break;
        case 'End': {
          e.preventDefault();
          const items = focusableItems(el);
          items[items.length - 1]?.focus();
          break;
        }
        case 'Escape':
          e.preventDefault();
          e.stopPropagation();
          if (panel === 'sub') closeSubmenu(true);
          else closeAll(true);
          break;
        case 'ArrowLeft':
          if (panel === 'sub') {
            e.preventDefault();
            closeSubmenu(true);
          }
          break;
        default:
          break;
      }
    },
    [closeAll, closeSubmenu],
  );

  const renderAction = (action: DropdownMenuAction) => (
    <button
      key={action.id}
      type="button"
      role="menuitem"
      className={`dropdown-menu__item ${action.danger ? 'dropdown-menu__item--danger' : ''}`}
      disabled={action.disabled}
      onClick={(e) => {
        e.stopPropagation();
        handleSelect(action);
      }}
      onMouseEnter={() => closeSubmenu(false)}
    >
      {action.swatchColor !== undefined && (
        <span
          className="dropdown-menu__swatch"
          style={action.swatchColor ? { background: action.swatchColor } : undefined}
        />
      )}
      {action.icon && <span className="dropdown-menu__icon">{action.icon}</span>}
      <span className="dropdown-menu__label">{action.label}</span>
      {action.checked && <Check className="dropdown-menu__check" size={14} aria-hidden="true" />}
    </button>
  );

  const renderEntries = (list: DropdownMenuEntry[], panel: 'root' | 'sub'): ReactNode[] =>
    list.map((entry, i): ReactNode => {
      if (entry.kind === 'separator') {
        return <div key={`sep-${i}`} className="dropdown-menu__separator" role="separator" />;
      }
      if (entry.kind === 'action') {
        return renderAction(entry.action);
      }
      // Submenus only nest one level: a submenu entry inside a submenu renders
      // its actions inline (flattened) rather than opening a third panel.
      if (panel === 'sub') {
        return renderEntries(entry.entries, 'sub');
      }
      const isOpen = openSubId === entry.id;
      return (
        <button
          key={entry.id}
          type="button"
          role="menuitem"
          aria-haspopup="menu"
          aria-expanded={isOpen}
          className={`dropdown-menu__item dropdown-menu__item--submenu ${isOpen ? 'dropdown-menu__item--submenu-open' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (isOpen) closeSubmenu(false);
            else openSubmenu(entry.id, e.currentTarget);
          }}
          onMouseEnter={(e) => openSubmenu(entry.id, e.currentTarget)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowRight') {
              e.preventDefault();
              openSubmenu(entry.id, e.currentTarget);
            }
          }}
        >
          {entry.icon && <span className="dropdown-menu__icon">{entry.icon}</span>}
          <span className="dropdown-menu__label">{entry.label}</span>
          <ChevronRight className="dropdown-menu__chevron" size={14} aria-hidden="true" />
        </button>
      );
    });

  const openSubEntries =
    openSubId !== null
      ? entries.find((e) => e.kind === 'submenu' && e.id === openSubId)
      : undefined;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={triggerClassName}
        title={triggerTitle}
        aria-label={triggerTitle}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={(e) => {
          e.stopPropagation();
          setOpenNotify(!open);
        }}
      >
        {trigger}
      </button>

      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="dropdown-menu__panel"
            role="menu"
            style={{
              top: position.top,
              left: position.left - (subPlacement?.parentShift ?? 0),
            }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => handlePanelKeyDown(e, 'root')}
          >
            {renderEntries(entries, 'root')}
          </div>,
          document.body,
        )}

      {open &&
        openSubEntries?.kind === 'submenu' &&
        createPortal(
          <div
            ref={subPanelRef}
            className="dropdown-menu__panel dropdown-menu__panel--sub"
            role="menu"
            style={
              subPlacement
                ? {
                    top: subPlacement.y,
                    left: subPlacement.x,
                    maxHeight: subPlacement.maxHeight,
                  }
                : // First paint is measured (visibility:hidden via the class
                  // below) before placeFlyout runs in the layout effect.
                  { top: 0, left: 0, visibility: 'hidden' }
            }
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => handlePanelKeyDown(e, 'sub')}
          >
            {renderEntries(openSubEntries.entries, 'sub')}
          </div>,
          document.body,
        )}
    </>
  );
}
