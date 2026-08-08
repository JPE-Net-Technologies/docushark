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
  /**
   * Trigger button content (icon and/or label). Omit for a menu with no
   * affordance of its own — a right-click menu, driven entirely by `open` +
   * `anchorPoint` from the parent.
   */
  trigger?: ReactNode | undefined;
  triggerClassName?: string | undefined;
  /** Tooltip + accessible label for the trigger. */
  triggerTitle?: string | undefined;
  entries: DropdownMenuEntry[];
  /** Which trigger edge the panel aligns to (default 'right'). */
  align?: 'left' | 'right' | undefined;
  /**
   * Controlled open state. Omit (the default) to let the trigger own it; pass
   * a boolean to drive the menu from the parent, in which case `onOpenChange`
   * is how the menu asks to close (outside click, Escape, item selected).
   */
  open?: boolean | undefined;
  /** Fires on open/close — lets a hover-revealed surface pin itself visible. */
  onOpenChange?: ((open: boolean) => void) | undefined;
  /**
   * Place the panel at this viewport point instead of under the trigger — the
   * context-menu case. Implies left-alignment (a cursor menu opens down-right)
   * regardless of `align`, which describes a trigger edge that isn't in play.
   */
  anchorPoint?: { x: number; y: number } | null | undefined;
  /**
   * Move focus to the first item on open (default true — the keyboard flow
   * starts inside the menu). Set false for a menu that opens on *hover*: there
   * the pointer, not the keyboard, is driving, and yanking focus out of
   * whatever the user was doing is a bug rather than a convenience.
   */
  autoFocusFirstItem?: boolean | undefined;
  /**
   * Also open on hover, with a grace period before closing. Handled here
   * rather than by the caller because the panel is portaled to `document.body`
   * — it is NOT a DOM descendant of the trigger, so a wrapper's `mouseleave`
   * fires the moment the pointer sets off toward the menu it is aiming for.
   * Only the component that owns both ends can bridge that gap.
   *
   * Hover-opening never moves focus, whatever `autoFocusFirstItem` says.
   * Uncontrolled use only — pass `open` or this, not both.
   */
  openOnHover?: boolean | undefined;
}

/** Grace period for travelling between the trigger and the portaled panel. */
const HOVER_CLOSE_DELAY_MS = 200;

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
  items[next]?.focus({ preventScroll: true });
}

export function DropdownMenu({
  trigger,
  triggerClassName,
  triggerTitle,
  entries,
  align = 'right',
  open: openProp,
  onOpenChange,
  anchorPoint,
  autoFocusFirstItem = true,
  openOnHover = false,
}: DropdownMenuProps) {
  const [uncontrolledOpen, setUncontrolledOpen] = useState(false);
  // Controlled only when the parent actually passes `open`; every existing
  // consumer omits it and keeps the original self-owned behaviour.
  const isControlled = openProp !== undefined;
  const open = isControlled ? openProp : uncontrolledOpen;
  const [position, setPosition] = useState<PanelPosition>({ top: 0, left: 0 });
  const [openSubId, setOpenSubId] = useState<string | null>(null);
  const [subPlacement, setSubPlacement] = useState<FlyoutPlacement | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const subPanelRef = useRef<HTMLDivElement>(null);
  const subAnchorRef = useRef<HTMLButtonElement | null>(null);

  const setOpenNotify = useCallback(
    (next: boolean) => {
      if (!isControlled) setUncontrolledOpen(next);
      if (!next) {
        setOpenSubId(null);
        setSubPlacement(null);
      }
      onOpenChange?.(next);
    },
    [isControlled, onOpenChange],
  );

  const closeAll = useCallback(
    (refocusTrigger: boolean) => {
      setOpenNotify(false);
      if (refocusTrigger) triggerRef.current?.focus();
    },
    [setOpenNotify],
  );

  // --- Hover open (opt-in via `openOnHover`) ---------------------------
  // `hoverOpenedRef` is a ref, not state: it gates the focus effect, and as
  // state it would re-run that effect a tick after opening and pull focus in
  // anyway — the exact thing hover-opening must not do.
  const hoverOpenedRef = useRef(false);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHoverClose = useCallback(() => {
    if (hoverTimer.current) {
      clearTimeout(hoverTimer.current);
      hoverTimer.current = null;
    }
  }, []);
  useEffect(() => () => cancelHoverClose(), [cancelHoverClose]);

  const handleHoverEnter = useCallback(() => {
    if (!openOnHover) return;
    cancelHoverClose();
    hoverOpenedRef.current = true;
    setOpenNotify(true);
  }, [openOnHover, cancelHoverClose, setOpenNotify]);

  const handleHoverLeave = useCallback(() => {
    if (!openOnHover) return;
    cancelHoverClose();
    hoverTimer.current = setTimeout(() => {
      hoverOpenedRef.current = false;
      setOpenNotify(false);
    }, HOVER_CLOSE_DELAY_MS);
  }, [openOnHover, cancelHoverClose, setOpenNotify]);

  // Position the panel under the trigger (or at the cursor point), clamped to
  // the viewport. A cursor point is a zero-size rect, so the same flip/clamp
  // maths covers both cases.
  const updatePosition = useCallback(() => {
    const rect = anchorPoint
      ? { top: anchorPoint.y, bottom: anchorPoint.y, left: anchorPoint.x, right: anchorPoint.x }
      : triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const panelWidth = panelRef.current?.offsetWidth ?? 220;
    // A cursor menu always opens down-right from the point; `align` describes a
    // trigger edge, which a point does not have.
    const alignRight = anchorPoint ? false : align === 'right';
    let left = alignRight ? rect.right - panelWidth : rect.left;
    const maxLeft = window.innerWidth - panelWidth - 8;
    left = Math.max(8, Math.min(left, maxLeft));
    // Flip above the anchor when there's no room below.
    const panelHeight = panelRef.current?.offsetHeight ?? 0;
    let top = rect.bottom + 4;
    if (panelHeight > 0 && top + panelHeight > window.innerHeight - 8) {
      top = Math.max(8, rect.top - 4 - panelHeight);
    }
    setPosition({ top, left });
  }, [align, anchorPoint]);

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

  // A controlled parent can close the menu without routing through
  // `setOpenNotify` (it just flips its own state), so a submenu left open at
  // that moment would reappear on the next open. Reset it on every close.
  useEffect(() => {
    if (open) return;
    setOpenSubId(null);
    setSubPlacement(null);
  }, [open]);

  // Focus the first item when the menu opens (keyboard flow starts inside).
  // Effects run post-commit, so the portaled panel is in the DOM already.
  // preventScroll: focusing must never scroll the page under a fixed panel —
  // that shifts the trigger and makes the menu chase its own position.
  useEffect(() => {
    if (!open || !autoFocusFirstItem || hoverOpenedRef.current) return;
    focusableItems(panelRef.current)[0]?.focus({ preventScroll: true });
  }, [open, autoFocusFirstItem]);

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
      // This menu never slides its parent panel (that made the whole menu jump
      // around). Tell placeFlyout so a tight right edge flips the submenu to
      // the left instead of leaving it to overlap the un-shifted parent.
      { allowParentShift: false },
    );
    setSubPlacement(placement);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openSubId]);

  useEffect(() => {
    if (!openSubId) return;
    focusableItems(subPanelRef.current)[0]?.focus({ preventScroll: true });
  }, [openSubId]);

  // Hover-close grace timer (JP-444): moving the pointer diagonally from the
  // submenu trigger toward the (portaled) sub panel clips the sibling items
  // below, whose hover used to close the submenu instantly — it vanished
  // before you could reach it. Sibling hover now *schedules* the close;
  // reaching the sub panel (or the trigger again) cancels it, while genuinely
  // resting on a sibling still closes after the grace period.
  const subCloseTimerRef = useRef<number | null>(null);
  const cancelScheduledSubClose = useCallback(() => {
    if (subCloseTimerRef.current !== null) {
      window.clearTimeout(subCloseTimerRef.current);
      subCloseTimerRef.current = null;
    }
  }, []);
  useEffect(() => cancelScheduledSubClose, [cancelScheduledSubClose]);

  const openSubmenu = useCallback(
    (id: string, anchor: HTMLButtonElement) => {
      cancelScheduledSubClose();
      // Re-entering the trigger of the already-open submenu must be a no-op:
      // resetting the placement here would hide the panel while the layout
      // effect (keyed on openSubId) never re-runs — the submenu got stuck
      // hidden and appeared to "fight" its position.
      if (id === openSubId) return;
      subAnchorRef.current = anchor;
      setSubPlacement(null); // measured + placed by the layout effect
      setOpenSubId(id);
    },
    [openSubId, cancelScheduledSubClose],
  );

  const closeSubmenu = useCallback(
    (refocusAnchor: boolean) => {
      cancelScheduledSubClose();
      setOpenSubId(null);
      setSubPlacement(null);
      if (refocusAnchor) subAnchorRef.current?.focus();
    },
    [cancelScheduledSubClose],
  );

  const scheduleSubmenuClose = useCallback(() => {
    if (openSubId === null || subCloseTimerRef.current !== null) return;
    subCloseTimerRef.current = window.setTimeout(() => {
      subCloseTimerRef.current = null;
      closeSubmenu(false);
    }, 220);
  }, [openSubId, closeSubmenu]);

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

  const renderAction = (action: DropdownMenuAction, panel: 'root' | 'sub') => (
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
      // Only ROOT-panel siblings schedule the submenu close — the submenu's
      // own items must never close the panel they live in (hovering them is
      // exactly how the user reaches "+ New collection…").
      onMouseEnter={panel === 'root' ? scheduleSubmenuClose : cancelScheduledSubClose}
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
        return renderAction(entry.action, panel);
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
      {trigger !== undefined && (
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
            // An explicit click is keyboard-equivalent intent: drop the
            // hover flag so the panel takes focus as it normally would.
            cancelHoverClose();
            hoverOpenedRef.current = false;
            setOpenNotify(!open);
          }}
          onMouseEnter={handleHoverEnter}
          onMouseLeave={handleHoverLeave}
        >
          {trigger}
        </button>
      )}

      {open &&
        createPortal(
          <div
            ref={panelRef}
            className="dropdown-menu__panel"
            role="menu"
            // Deliberately NOT applying subPlacement.parentShift: sliding the
            // parent panel mid-interaction made the whole menu jump around.
            // placeFlyout is called with allowParentShift:false so it flips the
            // submenu to the left when the right edge is tight, rather than
            // returning a shift we'd ignore (which left the submenu overlapping
            // the un-shifted parent).
            style={{ top: position.top, left: position.left }}
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => handlePanelKeyDown(e, 'root')}
            // The panel is portaled, so it must carry the hover handlers
            // itself — the trigger's `mouseleave` already fired on the way in.
            onMouseEnter={handleHoverEnter}
            onMouseLeave={handleHoverLeave}
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
            onMouseEnter={() => {
              cancelScheduledSubClose();
              handleHoverEnter();
            }}
            onMouseLeave={handleHoverLeave}
          >
            {renderEntries(openSubEntries.entries, 'sub')}
          </div>,
          document.body,
        )}
    </>
  );
}
