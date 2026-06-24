/**
 * Keyboard page navigation (JP-357).
 *
 * Steps the active page of whichever surface currently has focus: the prose
 * editor's pages when the Tiptap editable owns focus, otherwise the canvas
 * pages. Bound to Ctrl+PageUp/PageDown and Ctrl+Tab/Ctrl+Shift+Tab in the
 * command registry, and surfaced as "Next/Previous page" palette commands — the
 * web-reliable path, since those keys are browser-reserved in the PWA and only
 * reach us in the Tauri desktop webview.
 */

import { usePageStore } from '../store/pageStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { useHistoryStore } from '../store/historyStore';

/** True when the Tiptap prose editor (its `.ProseMirror` editable) owns focus. */
function defaultIsProseFocused(): boolean {
  const el = typeof document !== 'undefined' ? document.activeElement : null;
  return !!el && !!(el as Element).closest?.('.ProseMirror');
}

/** The page id one step away, or null when there's nothing to move to. */
function neighbor(order: readonly string[], activeId: string | null, step: number): string | null {
  if (order.length < 2 || !activeId) return null;
  const idx = order.indexOf(activeId);
  if (idx === -1) return null;
  const next = idx + step;
  if (next < 0 || next >= order.length) return null;
  return order[next] ?? null;
}

/**
 * Move the focused surface's active page by one step. Clamps at both ends (no
 * wrap) and no-ops when there are fewer than two pages. `isProseFocused` is
 * injectable for testing.
 */
export function navigateActivePage(
  dir: 'next' | 'prev',
  isProseFocused: () => boolean = defaultIsProseFocused,
): void {
  const step = dir === 'next' ? 1 : -1;

  if (isProseFocused()) {
    const { pageOrder, activePageId, setActivePage } = useRichTextPagesStore.getState();
    const target = neighbor(pageOrder, activePageId, step);
    if (target) setActivePage(target);
    return;
  }

  const { pageOrder, activePageId, setActivePage } = usePageStore.getState();
  const target = neighbor(pageOrder, activePageId, step);
  if (target) {
    setActivePage(target);
    // Mirror the tab-click path (InlinePageTabs) so history tracks the switch.
    useHistoryStore.getState().setActivePage(target);
  }
}
