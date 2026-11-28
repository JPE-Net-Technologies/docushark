import { describe, it, expect, beforeEach, vi } from 'vitest';
import { navigateActivePage } from './pageNavigation';
import { usePageStore } from '../store/pageStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { useHistoryStore } from '../store/historyStore';
import { usePendingPageDeletes } from '../store/pendingPageDeleteStore';

const canvasFocus = () => false;
const proseFocus = () => true;

describe('navigateActivePage', () => {
  const canvasSet = vi.fn();
  const proseSet = vi.fn();
  const historySet = vi.fn();

  beforeEach(() => {
    canvasSet.mockReset();
    proseSet.mockReset();
    historySet.mockReset();
    // Override the action fields with spies so we assert routing/clamping without
    // exercising the stores' real mutation internals.
    usePageStore.setState({ pageOrder: ['c1', 'c2', 'c3'], activePageId: 'c2', setActivePage: canvasSet } as never);
    useRichTextPagesStore.setState({ pageOrder: ['p1', 'p2', 'p3'], activePageId: 'p2', setActivePage: proseSet } as never);
    useHistoryStore.setState({ setActivePage: historySet } as never);
    usePendingPageDeletes.setState({ pending: {} });
  });

  it('steps over a page waiting out a delete\'s Undo (DSK-260)', () => {
    usePendingPageDeletes.setState({ pending: { c3: { kind: 'canvas', toastId: 't', wasActive: false } } });
    navigateActivePage('next', canvasFocus);
    expect(canvasSet).not.toHaveBeenCalled();
    usePendingPageDeletes.setState({ pending: { p1: { kind: 'prose', toastId: 't', wasActive: false } } });
    navigateActivePage('prev', proseFocus);
    expect(proseSet).not.toHaveBeenCalled();
  });

  it('moves to the next canvas page and mirrors history', () => {
    navigateActivePage('next', canvasFocus);
    expect(canvasSet).toHaveBeenCalledWith('c3');
    expect(historySet).toHaveBeenCalledWith('c3');
    expect(proseSet).not.toHaveBeenCalled();
  });

  it('moves to the previous canvas page', () => {
    navigateActivePage('prev', canvasFocus);
    expect(canvasSet).toHaveBeenCalledWith('c1');
  });

  it('routes to the prose store when the editor is focused (no history mirror)', () => {
    navigateActivePage('next', proseFocus);
    expect(proseSet).toHaveBeenCalledWith('p3');
    expect(canvasSet).not.toHaveBeenCalled();
    expect(historySet).not.toHaveBeenCalled();
  });

  it('clamps at the last page', () => {
    usePageStore.setState({ activePageId: 'c3' } as never);
    navigateActivePage('next', canvasFocus);
    expect(canvasSet).not.toHaveBeenCalled();
  });

  it('clamps at the first page', () => {
    usePageStore.setState({ activePageId: 'c1' } as never);
    navigateActivePage('prev', canvasFocus);
    expect(canvasSet).not.toHaveBeenCalled();
  });

  it('is a no-op with a single page', () => {
    usePageStore.setState({ pageOrder: ['c1'], activePageId: 'c1' } as never);
    navigateActivePage('next', canvasFocus);
    expect(canvasSet).not.toHaveBeenCalled();
  });
});
