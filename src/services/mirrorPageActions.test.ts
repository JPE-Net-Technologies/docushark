/**
 * The shared mirror page actions (DSK-193). The banner, the prose tab menu and
 * the Navigator all go through these, so their feedback and confirmation copy
 * can no longer drift apart.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  refreshMirrorPage: vi.fn(),
  detachMirrorPage: vi.fn(),
  confirmDialog: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
}));

vi.mock('./mirrorPageService', () => ({
  refreshMirrorPage: h.refreshMirrorPage,
  detachMirrorPage: h.detachMirrorPage,
}));
vi.mock('../ui/confirm/confirmStore', () => ({ confirmDialog: h.confirmDialog }));
vi.mock('../store/notificationStore', () => ({
  useNotificationStore: { getState: () => ({ success: h.success, error: h.error }) },
}));
vi.mock('../platform/opener', () => ({ opener: { openExternalUrl: vi.fn() } }));

import { refreshMirrorPageWithFeedback, detachMirrorPageWithConfirm } from './mirrorPageActions';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('refreshMirrorPageWithFeedback', () => {
  it('confirms a clean refresh', async () => {
    h.refreshMirrorPage.mockResolvedValue({ pageId: 'p', warnings: [], childRefs: [] });

    await expect(refreshMirrorPageWithFeedback('p')).resolves.toBe(true);
    expect(h.success).toHaveBeenCalledWith('Page refreshed from source');
  });

  it('counts what could not be mirrored', async () => {
    h.refreshMirrorPage.mockResolvedValue({ pageId: 'p', warnings: [{ count: 2 }, {}], childRefs: [] });

    await refreshMirrorPageWithFeedback('p');
    expect(h.success).toHaveBeenCalledWith('Page refreshed — 3 element(s) could not be mirrored');
  });

  it('reports the failure, with its message', async () => {
    h.refreshMirrorPage.mockRejectedValue(new Error('notion blocks fetch failed (429)'));

    await expect(refreshMirrorPageWithFeedback('p')).resolves.toBe(false);
    expect(h.error).toHaveBeenCalledWith('notion blocks fetch failed (429)');
    expect(h.success).not.toHaveBeenCalled();
  });
});

describe('detachMirrorPageWithConfirm', () => {
  it('asks first, says it cannot be undone, and detaches on confirm', async () => {
    h.confirmDialog.mockResolvedValue(true);

    await expect(detachMirrorPageWithConfirm('p', 'Notion')).resolves.toBe(true);
    expect(h.confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Detach from Notion?', details: expect.stringMatching(/cannot be undone/) }),
    );
    expect(h.detachMirrorPage).toHaveBeenCalledWith('p');
  });

  it('leaves the page alone when the user declines', async () => {
    h.confirmDialog.mockResolvedValue(false);

    await expect(detachMirrorPageWithConfirm('p', 'Notion')).resolves.toBe(false);
    expect(h.detachMirrorPage).not.toHaveBeenCalled();
  });
});
