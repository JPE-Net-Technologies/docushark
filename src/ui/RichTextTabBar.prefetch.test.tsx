/**
 * The "+" add-menu must be usable on the FIRST click.
 *
 * It used to kick the integration-hub load from the click handler and then read
 * the hub state synchronously one line later, so the first click always missed:
 * it quietly created a plain page, and "New page from Notion" only appeared
 * from the second click on. That reads as a broken button and hides the whole
 * integration entry point from anyone who clicks once.
 *
 * The fix is a mount-time prefetch, so this asserts the load starts when the
 * tab bar mounts — before any click — rather than asserting on rendered menu
 * markup, which would pin the menu's DOM shape rather than the behaviour.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from '@testing-library/react';

const ensureLoaded = vi.fn(async () => {});

vi.mock('../store/integrationHubStore', () => ({
  useIntegrationHubStore: Object.assign(
    // The component subscribes with a selector for `hub`.
    (selector: (s: unknown) => unknown) => selector({ hub: null }),
    { getState: () => ({ ensureLoaded }) },
  ),
  workspaceIntegrationState: () => null,
  providerLabel: (_hub: unknown, id: string) => id,
}));

// Stores and side-effecting modules the tab bar pulls in. Each is stubbed to
// the smallest shape the render path touches — this test is about one effect.
vi.mock('../store/richTextPagesStore', () => ({
  useRichTextPagesStore: () => ({
    pages: { p1: { id: 'p1', name: 'Page 1' } },
    pageOrder: ['p1'],
    activePageId: 'p1',
    setActivePage: vi.fn(),
    createPage: vi.fn(() => 'p2'),
    deletePage: vi.fn(),
    renamePage: vi.fn(),
    setPageColor: vi.fn(),
    movePages: vi.fn(),
  }),
}));
vi.mock('../collaboration/sharedDocOffline', () => ({ sharedDocOffline: () => false }));
vi.mock('../store/pendingSyncPages', () => ({
  usePendingSyncPages: Object.assign(() => ({}), { getState: () => ({ markPending: vi.fn() }) }),
}));
vi.mock('../store/persistenceStore', () => ({
  usePersistenceStore: Object.assign(() => ({}), { getState: () => ({ currentDocumentId: 'doc-1' }) }),
}));
vi.mock('../store/activeWorkspace', () => ({ activeWorkspaceId: () => 'ws-1' }));
vi.mock('../services/mirrorPageService', () => ({ refreshMirrorPage: vi.fn(), detachMirrorPage: vi.fn() }));
vi.mock('../store/notificationStore', () => ({
  useNotificationStore: Object.assign(() => ({}), {
    getState: () => ({ success: vi.fn(), error: vi.fn() }),
  }),
}));
vi.mock('./confirm/confirmStore', () => ({ confirmDialog: vi.fn() }));
vi.mock('../platform/opener', () => ({ opener: { openExternalUrl: vi.fn() } }));
vi.mock('../api/relayConnection', () => ({
  loadConnection: vi.fn(async () => null),
  DEFAULT_CLOUD_BASE_URL: 'https://cloud.test',
}));
vi.mock('./integrations/MirrorResourcePicker', () => ({ MirrorResourcePicker: () => null }));
vi.mock('./integrations/IngestSubpagesDialog', () => ({ IngestSubpagesDialog: () => null }));
vi.mock('./integrations/ProviderIcon', () => ({ ProviderIcon: () => null }));

import { RichTextTabBar } from './RichTextTabBar';

describe('RichTextTabBar integration-hub prefetch', () => {
  beforeEach(() => ensureLoaded.mockClear());

  it('starts loading the hub on mount, before any click', () => {
    render(<RichTextTabBar />);

    expect(ensureLoaded).toHaveBeenCalled();
  });

  it('does not re-load on every re-render', () => {
    const { rerender } = render(<RichTextTabBar />);
    rerender(<RichTextTabBar />);
    rerender(<RichTextTabBar />);

    // The effect is mount-scoped; the store's own TTL handles staleness.
    expect(ensureLoaded).toHaveBeenCalledTimes(1);
  });
});
