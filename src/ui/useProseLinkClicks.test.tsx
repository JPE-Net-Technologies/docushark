/**
 * useProseLinkClicks — inline link click handling shared by every prose surface.
 *
 * This is the automated repro for JP-417 ("Heading Links are Noops"): clicking a
 * `docushark://heading/<pageId>/<index>` anchor must switch the active prose page
 * via richTextPagesStore. Before the fix the handler was wired only into the
 * local editor, so the same click was a noop in the collab editor and the
 * read-only ProsePreview. We exercise it through ProsePreview (which now calls
 * the hook with `headingAnchors: true`).
 *
 * jsdom doesn't implement Element.scrollIntoView; we stub it so the post-switch
 * scroll (fired in a rAF) doesn't throw. The page-switch call is the assertion —
 * it happens before the scroll.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, waitFor } from '@testing-library/react';
import { registerBlobDownloader, resetBlobCache } from '../storage/blobResolver';
import { ProsePreview } from './ProsePreview';

const { setActivePageMock } = vi.hoisted(() => ({ setActivePageMock: vi.fn() }));

// The hook dynamically imports the page store; mock it with a stable spy.
vi.mock('../store/richTextPagesStore', () => ({
  useRichTextPagesStore: Object.assign(() => ({}), {
    getState: () => ({ activePageId: 'other-page', setActivePage: setActivePageMock }),
  }),
}));

describe('useProseLinkClicks heading-anchor nav (JP-417)', () => {
  beforeEach(() => {
    setActivePageMock.mockClear();
    Element.prototype.scrollIntoView = vi.fn();
    registerBlobDownloader(null);
    resetBlobCache();
  });

  afterEach(() => {
    registerBlobDownloader(null);
    resetBlobCache();
  });

  it('switches the active page when a docushark://heading link is clicked', async () => {
    const { container } = render(
      <ProsePreview html={'<p><a href="docushark://heading/target-page/0">jump</a></p><h1>Target</h1>'} />,
    );

    const anchor = await waitFor(() => {
      const a = container.querySelector('a[href^="docushark://heading/"]');
      expect(a).not.toBeNull();
      return a as HTMLAnchorElement;
    });

    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    await waitFor(() => {
      expect(setActivePageMock).toHaveBeenCalledWith('target-page');
    });
  });

  it('does not switch pages for an external https link', async () => {
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
    const { container } = render(
      <ProsePreview html={'<p><a href="https://example.com">out</a></p>'} />,
    );

    const anchor = await waitFor(() => {
      const a = container.querySelector('a[href^="https://"]');
      expect(a).not.toBeNull();
      return a as HTMLAnchorElement;
    });

    anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));

    await waitFor(() => {
      expect(openSpy).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener,noreferrer');
    });
    expect(setActivePageMock).not.toHaveBeenCalled();
    openSpy.mockRestore();
  });
});
