import { describe, it, expect, beforeEach } from 'vitest';
import { useRichTextPagesStore } from './richTextPagesStore';

describe('richTextPagesStore — deterministic default page id (JP-171)', () => {
  beforeEach(() => {
    useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
  });

  it('initializeDefaultPage pins the default prose page to rt-page-1', () => {
    useRichTextPagesStore.getState().initializeDefaultPage();
    const { pageOrder, pages, activePageId } = useRichTextPagesStore.getState();
    expect(pageOrder).toEqual(['rt-page-1']);
    expect(pages['rt-page-1']).toBeDefined();
    expect(activePageId).toBe('rt-page-1');
  });

  it('two fresh stores agree on the default page id (collaborators align)', () => {
    useRichTextPagesStore.getState().initializeDefaultPage();
    const firstId = useRichTextPagesStore.getState().pageOrder[0];
    useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
    useRichTextPagesStore.getState().initializeDefaultPage();
    const secondId = useRichTextPagesStore.getState().pageOrder[0];
    expect(firstId).toBe(secondId);
    expect(firstId).toBe('rt-page-1');
  });

  it('createPage honors an explicit id and still generates one when omitted', () => {
    const pinned = useRichTextPagesStore.getState().createPage('Pinned', undefined, 'custom-id');
    expect(pinned).toBe('custom-id');
    const generated = useRichTextPagesStore.getState().createPage('Auto');
    expect(generated).not.toBe('custom-id');
    expect(generated).toMatch(/^page-/);
  });
});
