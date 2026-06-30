/**
 * Utility functions for context menu positioning.
 */

/**
 * Clamp context menu position to stay within viewport bounds.
 * @param x - Initial x position (clientX from mouse event)
 * @param y - Initial y position (clientY from mouse event)
 * @param menuWidth - Estimated or measured width of the menu
 * @param menuHeight - Estimated or measured height of the menu
 * @param padding - Padding from viewport edges (default: 8)
 * @returns Adjusted { x, y } position
 */
export function clampToViewport(
  x: number,
  y: number,
  menuWidth: number,
  menuHeight: number,
  padding: number = 8
): { x: number; y: number } {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;

  let newX = x;
  let newY = y;

  // Clamp to right edge
  if (x + menuWidth > viewportWidth - padding) {
    newX = Math.max(padding, viewportWidth - menuWidth - padding);
  }

  // Clamp to bottom edge
  if (y + menuHeight > viewportHeight - padding) {
    newY = Math.max(padding, viewportHeight - menuHeight - padding);
  }

  // Clamp to left edge
  if (newX < padding) {
    newX = padding;
  }

  // Clamp to top edge
  if (newY < padding) {
    newY = padding;
  }

  return { x: newX, y: newY };
}

/**
 * Estimate menu dimensions based on common context menu sizes.
 * Use actual measurement with useLayoutEffect for more accuracy.
 */
export const MENU_SIZE_ESTIMATES = {
  /** Small menu (2-3 items) */
  small: { width: 140, height: 100 },
  /** Medium menu (4-6 items) */
  medium: { width: 180, height: 180 },
  /** Large menu (7+ items) */
  large: { width: 200, height: 280 },
} as const;

/** Which side of the parent menu a submenu (flyout) opened on. */
export type FlyoutSide = 'right' | 'left';

export interface FlyoutPlacement {
  /** Viewport x (left) for the submenu panel. */
  x: number;
  /** Viewport y (top) for the submenu panel. */
  y: number;
  /** Height cap for the panel — enables scroll when content is taller. */
  maxHeight: number;
  /** Which side the submenu opened on. */
  side: FlyoutSide;
  /** Pixels the parent menu must slide LEFT to free room on the right (>=0). */
  parentShift: number;
}

export interface FlyoutOptions {
  /** Padding kept from viewport edges (default 8). */
  padding?: number;
  /** Gap between the parent menu and the submenu (default 4). */
  gap?: number;
  /** Override viewport width (defaults to window.innerWidth). */
  viewportWidth?: number;
  /** Override viewport height (defaults to window.innerHeight). */
  viewportHeight?: number;
}

interface AnchorRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

/**
 * Place a submenu (flyout) next to its parent menu without overflowing the
 * viewport. Pure + viewport-driven so it behaves correctly on narrow/mobile
 * widths with no separate code path.
 *
 * Horizontal strategy is "hybrid":
 *   1. Open to the right of the parent if it fits.
 *   2. Otherwise slide the parent left (parentShift) to free room on the right,
 *      as long as the parent stays on-screen.
 *   3. Otherwise flip the submenu to the left of the parent.
 *   4. Otherwise (neither side fits — very narrow) clamp into the viewport;
 *      the caller also caps width in CSS so it can't exceed the viewport.
 *
 * Vertical strategy aligns the panel to the anchor item, clamps it inside the
 * viewport, and caps its height (scroll) when it is taller than the viewport.
 *
 * @param anchor  Rect of the hovered parent item (viewport coords).
 * @param parent  Left/right edges of the parent menu (viewport coords).
 * @param submenu Measured width/height of the submenu panel.
 */
export function placeFlyout(
  anchor: AnchorRect,
  parent: { left: number; right: number },
  submenu: { width: number; height: number },
  opts: FlyoutOptions = {},
): FlyoutPlacement {
  const padding = opts.padding ?? 8;
  const gap = opts.gap ?? 4;
  const vw = opts.viewportWidth ?? window.innerWidth;
  const vh = opts.viewportHeight ?? window.innerHeight;

  const { width, height } = submenu;
  const rightLimit = vw - padding;

  // --- Horizontal (hybrid) ---
  let side: FlyoutSide;
  let x: number;
  let parentShift = 0;

  const rightX = parent.right + gap;
  if (rightX + width <= rightLimit) {
    // 1. Fits to the right as-is.
    side = 'right';
    x = rightX;
  } else {
    const overflow = rightX + width - rightLimit;
    const maxShift = parent.left - padding; // how far parent can slide left
    if (overflow <= maxShift) {
      // 2. Slide the parent left to free room on the right.
      side = 'right';
      parentShift = overflow;
      x = rightX - parentShift;
    } else {
      const leftX = parent.left - gap - width;
      if (leftX >= padding) {
        // 3. Flip to the left.
        side = 'left';
        x = leftX;
      } else {
        // 4. Neither side fits — pick the roomier side and clamp.
        const roomRight = vw - parent.right;
        const roomLeft = parent.left;
        side = roomRight >= roomLeft ? 'right' : 'left';
        const lowerBound = padding;
        const upperBound = Math.max(padding, rightLimit - width);
        const desired = side === 'right' ? rightX : leftX;
        x = Math.min(Math.max(desired, lowerBound), upperBound);
      }
    }
  }

  // --- Vertical (align + clamp + scroll) ---
  const cap = vh - 2 * padding;
  const maxHeight = Math.min(height, cap);
  const yUpper = Math.max(padding, vh - padding - maxHeight);
  const y = Math.min(Math.max(anchor.top, padding), yUpper);

  return { x, y, maxHeight, side, parentShift };
}
