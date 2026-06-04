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
