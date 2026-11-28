/**
 * The Navigator's page lists (DSK-260): rows named as the tabs are, Delete
 * with Undo instead of a confirmation, and reordering that keeps a page still
 * waiting out its Undo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../store/integrationHubStore', () => {
  const state = { hub: null, ensureLoaded: async () => {} };
  return {
    useIntegrationHubStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
    providerLabel: (_hub: unknown, id: string) => id,
    workspaceIntegrationState: () => null,
  };
});

import { NavigatorPanel } from './NavigatorPanel';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { usePageStore } from '../store/pageStore';
import { useDocumentStore } from '../store/documentStore';
import { useNotificationStore } from '../store/notificationStore';
import { usePendingPageDeletes } from '../store/pendingPageDeleteStore';

let c1 = '';
let c2 = '';
let c3 = '';

beforeEach(() => {
  useNotificationStore.getState().dismissAll();
  usePendingPageDeletes.setState({ pending: {} });
  useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
  const prose = useRichTextPagesStore.getState();
  prose.createPage('Prose', undefined, 'p1');
  prose.createPage('Prose p.2', undefined, 'p2');
  prose.updatePageContent('p1', '<h1>Overview</h1>');
  prose.setActivePage('p1');

  usePageStore.getState().reset();
  useDocumentStore.getState().clear();
  c1 = usePageStore.getState().createPage('One');
  c2 = usePageStore.getState().createPage('Two');
  c3 = usePageStore.getState().createPage('Three');
});

afterEach(cleanup);

const rowNames = () => Array.from(document.querySelectorAll('.navigator-row-name')).map((el) => el.textContent);

describe('the Navigator', () => {
  it('names rows as the tabs do', () => {
    render(<NavigatorPanel />);
    expect(rowNames()).toEqual(['Overview', 'Page 2', 'One', 'Two', 'Three']);
  });

  it('deletes a page with Undo, not a confirmation', () => {
    render(<NavigatorPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Page 2' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete page' }));
    expect(rowNames()).toEqual(['Overview', 'One', 'Two', 'Three']);
    expect(useRichTextPagesStore.getState().pages['p2']).toBeDefined();
    const { notifications } = useNotificationStore.getState();
    expect(notifications[notifications.length - 1]).toMatchObject({ actionLabel: 'Undo' });
  });

  it('keeps a diagram waiting out its Undo when the others are reordered', () => {
    usePendingPageDeletes.setState({ pending: { [c2]: { kind: 'canvas', toastId: 't', wasActive: false } } });
    render(<NavigatorPanel />);
    const threeRow = screen.getByRole('button', { name: 'Three' }).closest('.navigator-block-inner')!;
    fireEvent.keyDown(threeRow.querySelector('.navigator-drag-handle')!, { key: 'ArrowUp' });
    expect(usePageStore.getState().pageOrder).toEqual([c3, c1, c2]);
  });
});
