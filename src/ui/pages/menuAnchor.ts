/**
 * Where a page's menu opens (DSK-260): at the pointer for a right-click,
 * under the tab when it came from the keyboard.
 */

import type { PageMenuAnchor } from './PageMenu';

/** Under an element: where a menu opened from the keyboard appears. */
export function menuAnchorBelow(el: HTMLElement, pageId: string): PageMenuAnchor {
  const r = el.getBoundingClientRect();
  return { pageId, x: r.left, y: r.bottom + 4 };
}

/**
 * For a `contextmenu` event. One the browser raised for the Menu key or
 * Shift+F10 reports no position, so it opens under the tab.
 */
export function menuAnchorFor(e: React.MouseEvent<HTMLElement>, pageId: string): PageMenuAnchor {
  if (e.clientX === 0 && e.clientY === 0) return menuAnchorBelow(e.currentTarget, pageId);
  return { pageId, x: e.clientX, y: e.clientY };
}

/** Shift+F10 or the Menu key: what opens a focused tab's menu. */
export function isMenuKey(e: React.KeyboardEvent): boolean {
  return e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey);
}
