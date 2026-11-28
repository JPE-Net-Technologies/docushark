/**
 * Delete with Undo for pages (DSK-260): nothing is deleted until the Undo
 * window ends, Undo cancels, and the last page of a kind can't go.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runBeforeDocumentSwitch } from './autoSaveGuard';
import { useNotificationStore } from './notificationStore';
import { usePageStore } from './pageStore';
import {
  PAGE_UNDO_WINDOW_MS,
  canDeletePage,
  flushPendingPageDeletes,
  requestPageDelete,
  usePendingPageDeletes,
  visiblePageIds,
} from './pendingPageDeleteStore';
import { useRichTextPagesStore } from './richTextPagesStore';

const prose = () => useRichTextPagesStore.getState();
const toast = () => {
  const { notifications } = useNotificationStore.getState();
  return notifications[notifications.length - 1]!;
};

beforeEach(() => {
  vi.useFakeTimers();
  useNotificationStore.getState().dismissAll();
  usePendingPageDeletes.setState({ pending: {} });
  useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
  prose().createPage('One', undefined, 'p1');
  prose().createPage('Two', undefined, 'p2');
  prose().createPage('Three', undefined, 'p3');
  prose().setActivePage('p1');
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deleting a page', () => {
  it('hides it at once and deletes it only when the Undo window ends', () => {
    expect(requestPageDelete('prose', 'p2', 'Two')).toBe(true);
    expect(visiblePageIds('prose')).toEqual(['p1', 'p3']);
    expect(prose().pages['p2']).toBeDefined();
    expect(toast()).toMatchObject({ message: '“Two” deleted', actionLabel: 'Undo' });

    vi.advanceTimersByTime(PAGE_UNDO_WINDOW_MS - 1);
    expect(prose().pages['p2']).toBeDefined();

    vi.advanceTimersByTime(1);
    expect(prose().pages['p2']).toBeUndefined();
    expect(usePendingPageDeletes.getState().pending).toEqual({});
  });

  it('is cancelled by Undo, which shows the page again if it was shown', () => {
    requestPageDelete('prose', 'p1', 'One');
    expect(prose().activePageId).toBe('p2');

    const { onAction, id } = toast();
    onAction!();
    useNotificationStore.getState().dismiss(id);
    vi.advanceTimersByTime(PAGE_UNDO_WINDOW_MS);

    expect(prose().pages['p1']).toBeDefined();
    expect(visiblePageIds('prose')).toEqual(['p1', 'p2', 'p3']);
    expect(prose().activePageId).toBe('p1');
  });

  it('commits when the toast is closed early', () => {
    requestPageDelete('prose', 'p3', 'Three');
    useNotificationStore.getState().dismiss(toast().id);
    expect(prose().pages['p3']).toBeUndefined();
  });

  it('shows the previous page when the last one in order goes', () => {
    prose().setActivePage('p3');
    requestPageDelete('prose', 'p3', 'Three');
    expect(prose().activePageId).toBe('p2');
  });

  it('refuses the last page of a kind on show', () => {
    requestPageDelete('prose', 'p1', 'One');
    requestPageDelete('prose', 'p2', 'Two');
    expect(canDeletePage('prose', 'p3')).toBe(false);
    expect(requestPageDelete('prose', 'p3', 'Three')).toBe(false);
    expect(visiblePageIds('prose')).toEqual(['p3']);
  });

  it('happens at once, toasts closed, before an export or a document switch', () => {
    requestPageDelete('prose', 'p2', 'Two');
    flushPendingPageDeletes();
    expect(prose().pages['p2']).toBeUndefined();
    expect(useNotificationStore.getState().notifications).toHaveLength(0);

    requestPageDelete('prose', 'p3', 'Three');
    runBeforeDocumentSwitch();
    expect(prose().pages['p3']).toBeUndefined();
  });

  it('works the same for diagrams', () => {
    usePageStore.getState().reset();
    const a = usePageStore.getState().createPage('A');
    const b = usePageStore.getState().createPage('B');
    expect(requestPageDelete('canvas', b, 'B')).toBe(true);
    expect(visiblePageIds('canvas')).toEqual([a]);
    vi.advanceTimersByTime(PAGE_UNDO_WINDOW_MS);
    expect(usePageStore.getState().pages[b]).toBeUndefined();
  });
});
