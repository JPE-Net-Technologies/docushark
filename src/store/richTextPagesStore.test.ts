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
    expect(pages['rt-page-1']?.name).toBe('Prose');
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

describe('richTextPagesStore — applyRemoteProsePageList (JP-339)', () => {
  beforeEach(() => {
    useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
  });

  it('adds a remote tab while PRESERVING existing pages content', () => {
    // Local page has live prose content (synced over its own fragment).
    useRichTextPagesStore.getState().createPage('Page 1', undefined, 'rt-page-1');
    useRichTextPagesStore.getState().updatePageContent('rt-page-1', '<p>my prose</p>');

    useRichTextPagesStore.getState().applyRemoteProsePageList({
      pages: {
        'rt-page-1': { id: 'rt-page-1', name: 'Page 1', order: 0 },
        'rt-new': { id: 'rt-new', name: 'From MCP', order: 1 },
      },
      pageOrder: ['rt-page-1', 'rt-new'],
    });

    const { pages, pageOrder } = useRichTextPagesStore.getState();
    expect(pageOrder).toEqual(['rt-page-1', 'rt-new']);
    // Content of the existing page must NOT be clobbered by the meta merge.
    expect(pages['rt-page-1']?.content).toBe('<p>my prose</p>');
    // The new tab arrives with empty content (its fragment syncs separately).
    expect(pages['rt-new']?.name).toBe('From MCP');
    expect(pages['rt-new']?.content).toBe('');
  });

  it('applies a remote rename + reorder without touching content', () => {
    useRichTextPagesStore.getState().createPage('Page 1', undefined, 'a');
    useRichTextPagesStore.getState().createPage('Page 2', undefined, 'b');
    useRichTextPagesStore.getState().updatePageContent('b', '<p>b body</p>');

    useRichTextPagesStore.getState().applyRemoteProsePageList({
      pages: {
        a: { id: 'a', name: 'A', order: 1 },
        b: { id: 'b', name: 'B renamed', order: 0 },
      },
      pageOrder: ['b', 'a'],
    });

    const { pages, pageOrder } = useRichTextPagesStore.getState();
    expect(pageOrder).toEqual(['b', 'a']);
    expect(pages['b']?.name).toBe('B renamed');
    expect(pages['b']?.content).toBe('<p>b body</p>');
  });

  it('prunes a deleted page and repoints the active page', () => {
    useRichTextPagesStore.getState().createPage('Page 1', undefined, 'a');
    useRichTextPagesStore.getState().createPage('Page 2', undefined, 'b');
    useRichTextPagesStore.getState().setActivePage('a');

    useRichTextPagesStore.getState().applyRemoteProsePageList({
      pages: { b: { id: 'b', name: 'Page 2', order: 0 } },
      pageOrder: ['b'],
    });

    const { pages, pageOrder, activePageId } = useRichTextPagesStore.getState();
    expect(pages['a']).toBeUndefined();
    expect(pageOrder).toEqual(['b']);
    expect(activePageId).toBe('b'); // the pruned active page was repointed
  });
});

describe('richTextPagesStore — page mirror provenance (JP-415)', () => {
  beforeEach(() => {
    useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
  });

  const mirror = {
    provider: 'notion',
    externalId: 'p-1',
    url: 'https://www.notion.so/Synth-p-1',
    version: '2026-07-10T09:00:00.000Z',
    syncedAt: 1752600000000,
  };

  it('setPageMirror sets and detach clears', () => {
    useRichTextPagesStore.getState().createPage('Mirror', undefined, 'm1');
    useRichTextPagesStore.getState().setPageMirror('m1', mirror);
    expect(useRichTextPagesStore.getState().pages['m1']?.mirror).toEqual(mirror);

    useRichTextPagesStore.getState().setPageMirror('m1', undefined);
    expect(useRichTextPagesStore.getState().pages['m1']?.mirror).toBeUndefined();
    expect('mirror' in (useRichTextPagesStore.getState().pages['m1'] ?? {})).toBe(false);
  });

  it('applyRemoteProsePageList adopts a remote mirror and propagates a remote detach', () => {
    useRichTextPagesStore.getState().createPage('Mirror', undefined, 'm1');
    useRichTextPagesStore.getState().updatePageContent('m1', '<p>mirrored body</p>');

    // Remote collaborator turned m1 into a mirror page.
    useRichTextPagesStore.getState().applyRemoteProsePageList({
      pages: { m1: { id: 'm1', name: 'Mirror', order: 0, mirror } },
      pageOrder: ['m1'],
    });
    expect(useRichTextPagesStore.getState().pages['m1']?.mirror).toEqual(mirror);
    expect(useRichTextPagesStore.getState().pages['m1']?.content).toBe('<p>mirrored body</p>');

    // Remote collaborator detached it — absence propagates.
    useRichTextPagesStore.getState().applyRemoteProsePageList({
      pages: { m1: { id: 'm1', name: 'Mirror', order: 0 } },
      pageOrder: ['m1'],
    });
    expect(useRichTextPagesStore.getState().pages['m1']?.mirror).toBeUndefined();
    expect(useRichTextPagesStore.getState().pages['m1']?.content).toBe('<p>mirrored body</p>');
  });

  it('serialize carries mirror provenance for persistence', () => {
    useRichTextPagesStore.getState().createPage('Mirror', undefined, 'm1');
    useRichTextPagesStore.getState().setPageMirror('m1', mirror);
    const snapshot = useRichTextPagesStore.getState().serialize();
    expect(snapshot.pages['m1']?.mirror).toEqual(mirror);
  });
});
