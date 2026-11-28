/**
 * Where a page's menu opens for a `contextmenu` event (DSK-260): at the
 * pointer for a right-click, under the tab when it came from the keyboard
 * (the Menu key or Shift+F10 report no position).
 */

import type { PageMenuAnchor } from './PageMenu';

export function menuAnchorFor(e: React.MouseEvent<HTMLElement>, pageId: string): PageMenuAnchor {
  if (e.clientX === 0 && e.clientY === 0) {
    const r = e.currentTarget.getBoundingClientRect();
    return { pageId, x: r.left, y: r.bottom + 4 };
  }
  return { pageId, x: e.clientX, y: e.clientY };
}
