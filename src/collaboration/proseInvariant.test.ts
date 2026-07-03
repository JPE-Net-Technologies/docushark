/**
 * JP-423 — orphaned-prose-fragment POLICY (`healOrphanedProseFragments`).
 *
 * Log always; repair only when the local `richTextPagesStore` corroborates;
 * repair is additive-only (`setProsePage` — never a fragment or meta delete).
 * The named cases: a deleted page is never resurrected, an in-flight external
 * write is never fought, a corroborated orphan is repaired idempotently.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getSchema, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { YjsDocument } from './YjsDocument';
import { registerProseSchema, __resetProseSchemaForTests } from './proseSchema';
import { healOrphanedProseFragments, synthesizeProsePageMeta } from './proseInvariant';
import { useRichTextPagesStore, type RichTextPage } from '../store/richTextPagesStore';

const schema = getSchema([StarterKit.configure({ history: false })]);

function paras(...texts: string[]): JSONContent {
  return {
    type: 'doc',
    content: texts.map((text) => ({
      type: 'paragraph',
      content: text ? [{ type: 'text', text }] : [],
    })),
  };
}

function storePage(id: string, name: string, color?: string): RichTextPage {
  const page: RichTextPage = {
    id,
    name,
    content: '<p>x</p>',
    order: 0,
    createdAt: 11,
    modifiedAt: 22,
  };
  if (color !== undefined) page.color = color;
  return page;
}

describe('healOrphanedProseFragments (JP-423)', () => {
  beforeEach(() => {
    registerProseSchema(schema);
    useRichTextPagesStore.setState({ pages: {}, pageOrder: [], activePageId: null });
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });
  afterEach(() => {
    __resetProseSchemaForTests();
    vi.restoreAllMocks();
  });

  it('does not resurrect a deleted page', () => {
    const doc = new YjsDocument();
    doc.setProse('rt-del', paras('content'));
    doc.setProsePage({ id: 'rt-del', name: 'Doomed', order: 0, createdAt: 1, modifiedAt: 2 });
    doc.deleteProsePage('rt-del');
    // Adoption already pruned the local store (no entry) — no corroboration.

    const result = healOrphanedProseFragments(doc, 'doc-1');

    expect(result.logged).toEqual(['rt-del']);
    expect(result.repaired).toEqual([]);
    expect(doc.getProsePageList().pages['rt-del']).toBeUndefined();
    // The fragment itself is untouched (additive-only policy).
    expect(doc.getDoc().getXmlFragment('prose:rt-del').length).toBeGreaterThan(0);
  });

  it('leaves an uncorroborated orphan alone (in-flight external write window)', () => {
    // An integration wrote the fragment; its meta write hasn't landed yet.
    // This client has never seen the page — log-only, nothing to fight.
    const doc = new YjsDocument();
    doc.setProse('rt-mirror', paras('externally mirrored'));

    const result = healOrphanedProseFragments(doc, 'doc-1');

    expect(result.logged).toEqual(['rt-mirror']);
    expect(result.repaired).toEqual([]);
    expect(doc.getProsePageList().pages['rt-mirror']).toBeUndefined();
  });

  it('repairs a corroborated orphan from the local page, idempotently', () => {
    const doc = new YjsDocument();
    doc.setProse('rt-lost', paras('content whose meta write was lost'));
    useRichTextPagesStore.setState({
      pages: { 'rt-lost': storePage('rt-lost', 'Lost notes', '#aabbcc') },
      pageOrder: ['rt-lost'],
      activePageId: 'rt-lost',
    });

    const first = healOrphanedProseFragments(doc, 'doc-1');
    expect(first.repaired).toEqual(['rt-lost']);
    const repaired = doc.getProsePageList().pages['rt-lost'];
    expect(repaired).toMatchObject({
      id: 'rt-lost',
      name: 'Lost notes',
      color: '#aabbcc',
      order: 0,
      createdAt: 11,
      modifiedAt: 22,
    });

    // Second run: the meta exists now — nothing to log or repair.
    const second = healOrphanedProseFragments(doc, 'doc-1');
    expect(second).toEqual({ logged: [], repaired: [] });
  });

  it('handles a mixed batch: repairs the corroborated, logs the rest', () => {
    const doc = new YjsDocument();
    doc.setProse('rt-known', paras('known'));
    doc.setProse('rt-foreign', paras('foreign'));
    useRichTextPagesStore.setState({
      pages: { 'rt-known': storePage('rt-known', 'Known') },
      pageOrder: ['rt-known'],
      activePageId: 'rt-known',
    });

    const result = healOrphanedProseFragments(doc, 'doc-1');

    expect(result.logged.sort()).toEqual(['rt-foreign', 'rt-known']);
    expect(result.repaired).toEqual(['rt-known']);
    expect(doc.getProsePageList().pages['rt-foreign']).toBeUndefined();
  });
});

describe('synthesizeProsePageMeta (JP-423)', () => {
  it('builds the meta from the page, clamping a not-found order to 0', () => {
    expect(synthesizeProsePageMeta(storePage('rt-1', 'Notes'), -1)).toEqual({
      id: 'rt-1',
      name: 'Notes',
      order: 0,
      createdAt: 11,
      modifiedAt: 22,
    });
  });

  it('round-trips optional color without materializing undefined', () => {
    const withColor = synthesizeProsePageMeta(storePage('rt-1', 'Notes', '#123456'), 2);
    expect(withColor.color).toBe('#123456');
    expect(withColor.order).toBe(2);

    const withoutColor = synthesizeProsePageMeta(storePage('rt-2', 'Plain'), 1);
    // exactOptionalPropertyTypes: the key must be absent, not undefined.
    expect('color' in withoutColor).toBe(false);
  });
});
