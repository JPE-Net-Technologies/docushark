/**
 * JP-335 — the reconnect page-list prune must SPARE pending-sync pages.
 *
 * `applyRemoteProsePageList` / `applyRemoteCanvasPageList` drop local pages
 * absent from the adopted (relay) list — correct for remote deletes, but a page
 * created offline is absent because the relay hasn't LEARNED it yet. Pruning it
 * before the handoff uploads it would destroy the user's offline work.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { useRichTextPagesStore } from './richTextPagesStore';
import { usePageStore } from './pageStore';
import { usePendingSyncPages } from './pendingSyncPages';
import { createPage } from '../types/Document';

describe('applyRemoteProsePageList — pending-sync spare (JP-335)', () => {
  beforeEach(() => {
    usePendingSyncPages.setState({ pending: {} });
    useRichTextPagesStore.setState({
      pages: {
        synced: { id: 'synced', name: 'Synced', content: '<p>a</p>', order: 0, createdAt: 0, modifiedAt: 0 },
        stale: { id: 'stale', name: 'Stale', content: '<p>b</p>', order: 1, createdAt: 0, modifiedAt: 0 },
        offline: { id: 'offline', name: 'Offline', content: '<p>c</p>', order: 2, createdAt: 0, modifiedAt: 0 },
      },
      pageOrder: ['synced', 'stale', 'offline'],
      activePageId: 'offline',
    });
  });

  it('spares a pending page from the prune and keeps it in the order', () => {
    usePendingSyncPages.getState().markPending('offline', 'doc-1');

    // Relay's list knows only 'synced' — 'stale' is a genuine remote delete,
    // 'offline' is the pending page the relay hasn't learned yet.
    useRichTextPagesStore.getState().applyRemoteProsePageList({
      pages: { synced: { id: 'synced', name: 'Synced', order: 0, createdAt: 0, modifiedAt: 0 } },
      pageOrder: ['synced'],
    });

    const state = useRichTextPagesStore.getState();
    expect(state.pages['offline']).toBeDefined();
    expect(state.pages['offline']?.content).toBe('<p>c</p>');
    expect(state.pageOrder).toEqual(['synced', 'offline']);
    // The genuine remote delete still lands.
    expect(state.pages['stale']).toBeUndefined();
    // The active page (the spared one) is not repointed away.
    expect(state.activePageId).toBe('offline');
  });

  it('prunes the same page normally once its marker is cleared', () => {
    useRichTextPagesStore.getState().applyRemoteProsePageList({
      pages: { synced: { id: 'synced', name: 'Synced', order: 0, createdAt: 0, modifiedAt: 0 } },
      pageOrder: ['synced'],
    });
    const state = useRichTextPagesStore.getState();
    expect(state.pages['offline']).toBeUndefined();
    expect(state.pageOrder).toEqual(['synced']);
  });
});

describe('applyRemoteCanvasPageList — pending-sync spare (JP-335)', () => {
  beforeEach(() => {
    usePendingSyncPages.setState({ pending: {} });
    const synced = createPage('Synced', 'synced');
    const offline = createPage('Offline', 'offline');
    usePageStore.setState({
      pages: { synced, offline },
      pageOrder: ['synced', 'offline'],
      activePageId: 'synced',
    });
  });

  it('spares a pending canvas page (shapes intact) and keeps it in the order', () => {
    usePendingSyncPages.getState().markPending('offline', 'doc-1');

    usePageStore.getState().applyRemoteCanvasPageList({
      pages: { synced: { id: 'synced', name: 'Synced', createdAt: 0, modifiedAt: 0 } },
      pageOrder: ['synced'],
    });

    const state = usePageStore.getState();
    expect(state.pages['offline']).toBeDefined();
    expect(state.pageOrder).toEqual(['synced', 'offline']);
  });

  it('prunes normally without a marker', () => {
    usePageStore.getState().applyRemoteCanvasPageList({
      pages: { synced: { id: 'synced', name: 'Synced', createdAt: 0, modifiedAt: 0 } },
      pageOrder: ['synced'],
    });
    expect(usePageStore.getState().pages['offline']).toBeUndefined();
  });
});
