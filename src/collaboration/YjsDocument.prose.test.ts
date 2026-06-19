/**
 * JP-193 — CRDT-native headless prose write (`YjsDocument.setProse`/`appendProse`).
 * Promoted from the JP-184 spike; asserts the primitive against a registered
 * schema (here a StarterKit-only stand-in; the app registers the full editor
 * schema from the prose chunk at runtime — see TiptapEditor.tsx).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getSchema, Editor, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import { yXmlFragmentToProseMirrorRootNode } from 'y-prosemirror';
import * as Y from 'yjs';
import { YjsDocument } from './YjsDocument';
import { registerProseSchema, __resetProseSchemaForTests } from './proseSchema';

// History off — Collaboration owns undo; matches CollaborativeProseEditor.
const testExtensions = [StarterKit.configure({ history: false })];
const schema = getSchema(testExtensions);

function paras(...texts: string[]): JSONContent {
  return {
    type: 'doc',
    content: texts.map((text) => ({
      type: 'paragraph',
      content: text ? [{ type: 'text', text }] : [],
    })),
  };
}

function readText(doc: YjsDocument, pageId: string): string {
  const node = yXmlFragmentToProseMirrorRootNode(
    doc.getDoc().getXmlFragment(`prose:${pageId}`),
    schema,
  );
  return node.textBetween(0, node.content.size, '\n');
}

describe('YjsDocument prose (JP-193)', () => {
  beforeEach(() => registerProseSchema(schema));
  afterEach(() => __resetProseSchemaForTests());

  it('setProse then appendProse merges — existing content preserved', () => {
    const doc = new YjsDocument();
    doc.setProse('p1', paras('Hello world'));
    expect(readText(doc, 'p1')).toBe('Hello world');

    doc.appendProse('p1', paras('Injected by an agent'));
    expect(readText(doc, 'p1')).toBe('Hello world\nInjected by an agent');
  });

  it('setProse replaces the page content (merge-safe diff, not a wipe)', () => {
    const doc = new YjsDocument();
    doc.setProse('p1', paras('First', 'Second'));
    doc.setProse('p1', paras('Replaced'));
    expect(readText(doc, 'p1')).toBe('Replaced');
  });

  it('scopes writes per page via the prose:<pageId> fragment', () => {
    const doc = new YjsDocument();
    doc.setProse('p1', paras('Page one'));
    doc.setProse('p2', paras('Page two'));
    expect(readText(doc, 'p1')).toBe('Page one');
    expect(readText(doc, 'p2')).toBe('Page two');
  });

  it('a mounted Collaboration editor live-reflects a headless append without clobber', async () => {
    const doc = new YjsDocument();
    doc.setProse('p1', paras('Hello world'));

    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      extensions: [
        ...testExtensions,
        Collaboration.configure({ document: doc.getDoc(), field: 'prose:p1' }),
      ],
    });
    expect(editor.getHTML()).toContain('Hello world');

    // Write headlessly — NOT via editor commands — and let ySyncPlugin observe.
    doc.appendProse('p1', paras('Injected by an agent'));
    await new Promise((r) => setTimeout(r, 0));

    const html = editor.getHTML();
    expect(html).toContain('Hello world'); // not clobbered
    expect(html).toContain('Injected by an agent'); // live-reflected

    editor.destroy();
    element.remove();
  });

  it('throws a clear error when no schema is registered', () => {
    __resetProseSchemaForTests();
    const doc = new YjsDocument();
    expect(() => doc.setProse('p1', paras('x'))).toThrow(/no schema registered/);
  });
});

describe('YjsDocument.healDoubledProse (JP-338)', () => {
  beforeEach(() => registerProseSchema(schema));
  afterEach(() => __resetProseSchemaForTests());

  // Append a [heading, paragraph] body to the fragment as independent items —
  // the raw shape a merged duplicate lineage produces (cf. proseReseedDuplication).
  function appendBody(doc: YjsDocument, pageId: string, title: string, body: string): void {
    const frag = doc.getDoc().getXmlFragment(`prose:${pageId}`);
    const h = new Y.XmlElement('heading');
    h.setAttribute('level', '1');
    const ht = new Y.XmlText();
    ht.insert(0, title);
    h.insert(0, [ht]);
    const p = new Y.XmlElement('paragraph');
    const pt = new Y.XmlText();
    pt.insert(0, body);
    p.insert(0, [pt]);
    frag.insert(frag.length, [h, p]);
  }

  it('collapses an exact body×2 double and propagates the delete', () => {
    const doc = new YjsDocument();
    appendBody(doc, 'p1', 'Title', 'the body'); // [h, p]
    appendBody(doc, 'p1', 'Title', 'the body'); // doubled → [h, p, h, p]
    expect(doc.getDoc().getXmlFragment('prose:p1').length).toBe(4);

    expect(doc.healDoubledProse('p1')).toBe(true);
    expect(doc.getDoc().getXmlFragment('prose:p1').length).toBe(2);
    expect(readText(doc, 'p1')).toBe('Title\nthe body');
  });

  it('is a no-op for two identical single paragraphs (n === 2)', () => {
    const doc = new YjsDocument();
    doc.setProse('p1', paras('same', 'same'));
    expect(doc.healDoubledProse('p1')).toBe(false);
    expect(readText(doc, 'p1')).toBe('same\nsame');
  });

  it('is a no-op on a clean single body', () => {
    const doc = new YjsDocument();
    appendBody(doc, 'p1', 'Title', 'body');
    expect(doc.healDoubledProse('p1')).toBe(false);
    expect(doc.getDoc().getXmlFragment('prose:p1').length).toBe(2);
  });
});
