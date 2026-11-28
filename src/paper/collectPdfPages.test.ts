/**
 * What Paper Mode and the PDF export lay out (DSK-48): every prose page, the
 * one being edited from the live editor, the others from their saved HTML.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Editor, JSONContent } from '@tiptap/core';
import { useRichTextPagesStore, type RichTextPage } from '../store/richTextPagesStore';
import { collectPdfPages, type PageJsonCache } from './collectPdfPages';

const page = (id: string, content: string): RichTextPage =>
  ({ id, name: id.toUpperCase(), content, createdAt: 0, updatedAt: 0 }) as unknown as RichTextPage;

const live: JSONContent = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Live text' }] }] };
const editor = { getJSON: () => live } as unknown as Editor;

beforeEach(() => {
  useRichTextPagesStore.setState({
    pages: { a: page('a', '<p>Saved A</p>'), b: page('b', '<h2>Saved B</h2>') },
    pageOrder: ['a', 'b'],
    activePageId: 'a',
  });
});

describe('collectPdfPages', () => {
  it('takes the page being edited from the editor and the rest from their HTML, in order', () => {
    const pages = collectPdfPages(editor);
    expect(pages.map((p) => p.id)).toEqual(['a', 'b']);
    expect(pages[0]!.content.content).toBe(live);
    expect(pages[1]!.content.content.content?.[0]).toMatchObject({ type: 'heading', content: [{ text: 'Saved B' }] });
  });

  it('parses a page again only when its HTML changed', () => {
    const cache: PageJsonCache = new Map();
    const first = collectPdfPages(editor, cache)[1]!.content.content;
    expect(collectPdfPages(editor, cache)[1]!.content.content).toBe(first);
    useRichTextPagesStore.setState((s) => ({ pages: { ...s.pages, b: page('b', '<p>Changed</p>') } }));
    const changed = collectPdfPages(editor, cache)[1]!.content.content;
    expect(changed).not.toBe(first);
    expect(changed.content?.[0]).toMatchObject({ type: 'paragraph', content: [{ text: 'Changed' }] });
  });

  it('reads every page from its HTML without an editor', () => {
    expect(collectPdfPages(null)[0]!.content.content.content?.[0]).toMatchObject({ content: [{ text: 'Saved A' }] });
  });
});
