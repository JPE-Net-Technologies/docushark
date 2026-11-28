/**
 * A writing page's parent (DSK-260), read and kept before anything writes it.
 *
 * Slice 3 (DSK-262) lets any writing page take subpages through a new
 * `parentId`. A build that rewrites a page's metadata (a rename, a colour)
 * drops any field it doesn't copy, so this release only teaches every copy to
 * carry it. Nothing here writes one (DSK-235: readers before writers).
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { YjsDocument } from './YjsDocument';
import { prosePageMetaChanged, synthesizeProsePageMeta } from './proseInvariant';
import { useRichTextPagesStore, type RichTextPage } from '../store/richTextPagesStore';

const store = () => useRichTextPagesStore.getState();

/** Give a page a parent the way a newer build's write would arrive. */
function setParent(id: string, parentId: string): void {
  const { pages } = store();
  useRichTextPagesStore.setState({ pages: { ...pages, [id]: { ...pages[id]!, parentId } } });
}

beforeEach(() => {
  useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
});

describe("a writing page's parent", () => {
  it('is adopted from the shared page list, and cleared when the list drops it', () => {
    store().createPage('Chapter', undefined, 'p1');
    store().createPage('Section', undefined, 'p2');
    store().updatePageContent('p2', '<p>body</p>');

    store().applyRemoteProsePageList({
      pages: {
        p1: { id: 'p1', name: 'Chapter', order: 0 },
        p2: { id: 'p2', name: 'Section', order: 1, parentId: 'p1' },
      },
      pageOrder: ['p1', 'p2'],
    });
    expect(store().pages['p2']?.parentId).toBe('p1');
    expect(store().pages['p2']?.content).toBe('<p>body</p>');

    store().applyRemoteProsePageList({
      pages: {
        p1: { id: 'p1', name: 'Chapter', order: 0 },
        p2: { id: 'p2', name: 'Section', order: 1 },
      },
      pageOrder: ['p1', 'p2'],
    });
    expect(store().pages['p2']?.parentId).toBeUndefined();
  });

  it('goes back into the metadata this build writes', () => {
    store().createPage('Section', undefined, 'p2');
    setParent('p2', 'p1');
    expect(synthesizeProsePageMeta(store().pages['p2']!, 1).parentId).toBe('p1');
  });

  it('counts as a metadata change, so it syncs', () => {
    const page: RichTextPage = { id: 'p2', name: 'Section', content: '', order: 1, createdAt: 1, modifiedAt: 1 };
    expect(prosePageMetaChanged(page, { ...page, parentId: 'p1' })).toBe(true);
    expect(prosePageMetaChanged({ ...page, parentId: 'p1' }, { ...page, parentId: 'p1' })).toBe(false);
    expect(prosePageMetaChanged(undefined, page)).toBe(true);
  });

  it('survives a shared round trip: adopt, rename, write back', () => {
    const doc = new YjsDocument();
    doc.setProsePage({ id: 'p1', name: 'Chapter', order: 0 });
    doc.setProsePage({ id: 'p2', name: 'Section', order: 1, parentId: 'p1' });

    store().applyRemoteProsePageList(doc.getProsePageList());
    store().renamePage('p2', 'Sync rules');
    doc.setProsePage(synthesizeProsePageMeta(store().pages['p2']!, store().pageOrder.indexOf('p2')));

    expect(doc.getProsePageList().pages['p2']).toMatchObject({ name: 'Sync rules', parentId: 'p1' });
  });

  it('is kept by the local save', () => {
    store().createPage('Section', undefined, 'p2');
    setParent('p2', 'p1');
    expect(store().serialize().pages['p2']?.parentId).toBe('p1');
  });
});
