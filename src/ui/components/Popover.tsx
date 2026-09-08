/**
 * Popover — an anchored panel of arbitrary content.
 *
 * ## Why this exists
 *
 * `DropdownMenu` covers anchored *lists*: it is a `role="menu"` with roving
 * tabindex, and its children must be menu items. Anything that is a panel
 * rather than a list — a tile grid, a form, a preview — cannot use it without
 * breaking that keyboard model, so every such surface hand-rolled the same
 * four things instead: a portal, a measured-then-clamped position, an
 * outside-click listener, and Escape. That pattern is currently repeated in
 * `RichTextTabBar`, `InlinePageTabs`, `StyleProfilePanel`, `Whiteboard`,
 * `FloatingCollabIndicator`, `DocumentEditorContextMenu` and `ContextMenu`,
 * each with its own subtly different version of the measure/clamp dance.
 *
 * This is that pattern, once. Migrating the existing seven is deliberately NOT
 * part of introducing it — they work, and rewriting them all at once would put
 * a large untested diff under features that are currently fine. New panels use
 * this; the others move one at a time when they are being touched anyway.
 *
 * ## Measured, then clamped
 *
 * Position is applied after the panel has real bounds, not guessed from the
 * anchor: a panel opened near the right or bottom edge would otherwise render
 * off-screen for one frame and then jump. It re-clamps on resize via a
 * `ResizeObserver`, because content that grows after first paint (brand icons
 * finishing their load is the case that bit the tab-bar menus) changes the
 * answer.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';
import { createPortal } from 'react-dom';

import { clampToViewport } from '../contextMenuUtils';
import './Popover.css';

export interface PopoverProps {
  /** Viewport rect of the element the panel hangs from. */
  anchor: DOMRect;
  /** Which anchor edge the panel lines up with (default 'left'). */
  align?: 'left' | 'right';
  /** Gap between anchor and panel, px. */
  offset?: number;
  /** Asked to close: outside click, Escape, or a child calling `close`. */
  onClose: () => void;
  /** Accessible name for the panel. */
  label: string;
  /**
   * The element that opened this panel, excluded from the outside-click check.
   *
   * Without it a trigger cannot toggle: pressing it while the panel is open
   * fires this component's `mousedown` listener (which closes) and then the
   * trigger's own `onClick` (which reopens), so the panel appears stuck open.
   * Excluding the trigger lets its click be the only thing that acts.
   */
  triggerRef?: RefObject<HTMLElement | null>;
  className?: string;
  children: ReactNode;
}

export function Popover({
  anchor,
  align = 'left',
  offset = 4,
  onClose,
  label,
  triggerRef,
  className = '',
  children,
}: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);

  const place = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const x = align === 'right' ? anchor.right - rect.width : anchor.left;
    setPos(clampToViewport(x, anchor.bottom + offset, rect.width, rect.height));
  }, [anchor.left, anchor.right, anchor.bottom, align, offset]);

  // Layout effect, not effect: position before paint so the panel never shows
  // at its unclamped position first.
  useLayoutEffect(() => {
    place();
    const el = ref.current;
    if (!el) return undefined;
    const ro = new ResizeObserver(place);
    ro.observe(el);
    return () => ro.disconnect();
  }, [place]);

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (ref.current?.contains(target)) return;
      if (triggerRef?.current?.contains(target)) return; // let the trigger toggle
      onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // Stop here: a panel over a dialog would otherwise close both on one
        // press, and the reader only asked to dismiss the thing on top.
        e.stopPropagation();
        onClose();
      }
    };
    // `mousedown`, not `click`: a click that starts inside the panel and ends
    // outside it (a drag on a slider) must not be read as dismissal.
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose, triggerRef]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label={label}
      className={`popover ${className}`.trim()}
      style={{
        left: pos?.x ?? anchor.left,
        top: pos?.y ?? anchor.bottom + offset,
        // Hidden until measured, so the pre-clamp position is never painted.
        // `visibility` rather than `display`: the panel must still have layout
        // for `getBoundingClientRect` to return real bounds.
        visibility: pos ? 'visible' : 'hidden',
      }}
    >
      {children}
    </div>,
    document.body,
  );
}

export default Popover;
