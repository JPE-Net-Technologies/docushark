/**
 * The writing tabs (DSK-260): names from headings, one page menu (with color,
 * and a mirrored page's source actions), and Delete with Undo.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';

vi.mock('../store/integrationHubStore', () => {
  const state = { hub: null, ensureLoaded: async () => {} };
  return {
    useIntegrationHubStore: Object.assign((selector: (s: typeof state) => unknown) => selector(state), {
      getState: () => state,
    }),
    providerLabel: (_hub: unknown, id: string) => (id === 'notion' ? 'Notion' : id),
    workspaceIntegrationState: () => null,
  };
});

import { RichTextTabBar } from './RichTextTabBar';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { useNotificationStore } from '../store/notificationStore';
import { usePendingPageDeletes } from '../store/pendingPageDeleteStore';

const prose = () => useRichTextPagesStore.getState();
const tabNames = () => screen.getAllByRole('tab').map((t) => t.querySelector('.rich-text-tab-name')?.textContent);
const openMenuOf = (label: string) => fireEvent.click(screen.getByLabelText(`${label}: page menu`));
const menuItems = () => screen.getAllByRole('menuitem').map((i) => i.textContent?.trim());

beforeEach(() => {
  useNotificationStore.getState().dismissAll();
  usePendingPageDeletes.setState({ pending: {} });
  useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
  prose().createPage('Prose', undefined, 'p1');
  prose().createPage('Requirements', undefined, 'p2');
  prose().createPage('Prose p.3', undefined, 'p3');
  prose().updatePageContent('p1', '<h1>Overview</h1><p>text</p>');
  prose().updatePageContent('p2', '<h2>Goals</h2>');
  prose().updatePageContent('p3', '<p>no heading here</p>');
  prose().setActivePage('p1');
});

afterEach(cleanup);

describe('the writing tabs', () => {
  it('name a default-named page from its first heading and keep a chosen name', () => {
    render(<RichTextTabBar />);
    expect(screen.getByRole('tablist').closest('[aria-label]')?.getAttribute('aria-label')).toBe('Writing pages');
    expect(tabNames()).toEqual(['Overview', 'Requirements', 'Page 3']);
  });

  it("offer rename, color and delete in a page's menu", () => {
    render(<RichTextTabBar />);
    openMenuOf('Overview');
    expect(menuItems()).toEqual(['Rename', expect.stringContaining('Color'), 'Delete page']);
  });

  it("give a mirrored page its source's actions instead of rename and color", () => {
    useRichTextPagesStore.setState((s) => ({
      pages: {
        ...s.pages,
        p2: {
          ...s.pages['p2']!,
          mirror: { provider: 'notion', externalId: 'x', url: 'https://notion.so/x', version: 'v', syncedAt: 1 },
        },
      },
    }));
    render(<RichTextTabBar />);
    openMenuOf('Requirements');
    expect(menuItems()).toEqual([
      'Refresh from source',
      'Add subpages…',
      'Open in Notion',
      'Detach from Notion',
      'Delete page',
    ]);
  });

  it('delete with Undo', () => {
    render(<RichTextTabBar />);
    openMenuOf('Requirements');
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete page' }));
    expect(tabNames()).toEqual(['Overview', 'Page 3']);
    expect(prose().pages['p2']).toBeDefined();

    const { notifications } = useNotificationStore.getState();
    act(() => notifications[notifications.length - 1]!.onAction!());
    expect(tabNames()).toEqual(['Overview', 'Requirements', 'Page 3']);
  });

  it('say what the add button adds', () => {
    render(<RichTextTabBar />);
    expect(screen.getByRole('button', { name: 'Add a writing page' }).textContent).toContain('Page');
  });
});
