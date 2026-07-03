/**
 * JP-423 — orphaned-prose-fragment DETECTION (`listOrphanedProseFragmentIds`).
 *
 * The fragment↔page-list asymmetry: `prose:<id>` fragments sync
 * unconditionally, `prosePages` meta is a separate write. Detection must
 * report content-bearing roots with no meta — and NOTHING else: merely
 * accessed (empty) roots don't count, and a deleted page's undeletable root
 * IS reported (presence alone can't distinguish it — the policy layer
 * corroborates before repairing).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSchema, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import * as Y from 'yjs';
import { YjsDocument, type ProsePageMeta } from './YjsDocument';
import { registerProseSchema, __resetProseSchemaForTests } from './proseSchema';

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

function meta(id: string, name: string): ProsePageMeta {
  return { id, name, order: 0, createdAt: 1, modifiedAt: 2 };
}

function crossSync(a: YjsDocument, b: YjsDocument): void {
  Y.applyUpdate(b.getDoc(), Y.encodeStateAsUpdate(a.getDoc()));
  Y.applyUpdate(a.getDoc(), Y.encodeStateAsUpdate(b.getDoc()));
}

describe('YjsDocument.listOrphanedProseFragmentIds (JP-423)', () => {
  beforeEach(() => registerProseSchema(schema));
  afterEach(() => __resetProseSchemaForTests());

  it('fragment + meta → not orphaned', () => {
    const doc = new YjsDocument();
    doc.setProse('rt-1', paras('content'));
    doc.setProsePage(meta('rt-1', 'Page'));

    expect(doc.listOrphanedProseFragmentIds()).toEqual([]);
  });

  it('content-bearing fragment with no meta → reported', () => {
    const doc = new YjsDocument();
    doc.setProse('rt-orphan', paras('content that no list shows'));

    expect(doc.listOrphanedProseFragmentIds()).toEqual(['rt-orphan']);
  });

  it('a merely-accessed empty root is NOT reported', () => {
    const doc = new YjsDocument();
    // Accessing a root creates it in doc.share even with zero content.
    doc.getDoc().getXmlFragment('prose:rt-empty');

    expect(doc.listOrphanedProseFragmentIds()).toEqual([]);
  });

  it('a fragment synced from a peer without its meta → reported on the receiver', () => {
    const writer = new YjsDocument();
    const receiver = new YjsDocument();
    crossSync(writer, receiver);

    // The writer wrote content but "forgot" the meta write (the orphan class
    // an integration manufactures on its first mirror write).
    writer.setProse('rt-m', paras('mirrored content'));
    crossSync(writer, receiver);

    expect(receiver.listOrphanedProseFragmentIds()).toEqual(['rt-m']);

    // Once the meta lands, the orphan disappears everywhere.
    writer.setProsePage(meta('rt-m', 'Mirror'));
    crossSync(writer, receiver);
    expect(receiver.listOrphanedProseFragmentIds()).toEqual([]);
    expect(writer.listOrphanedProseFragmentIds()).toEqual([]);
  });

  it('deleteProsePage leaves a content-bearing root that IS reported (undeletable roots)', () => {
    const doc = new YjsDocument();
    doc.setProse('rt-del', paras('kept by Yjs forever'));
    doc.setProsePage(meta('rt-del', 'Doomed'));
    expect(doc.listOrphanedProseFragmentIds()).toEqual([]);

    doc.deleteProsePage('rt-del');

    // Pins the sharp edge: meta+order are gone, the root cannot be — so a
    // deleted page is indistinguishable from an orphan by presence alone.
    // Policy (healOrphanedProseFragments) must corroborate before repairing.
    expect(doc.listOrphanedProseFragmentIds()).toEqual(['rt-del']);
  });
});
