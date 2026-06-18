/**
 * Tests for the prose-projection machinery (JP-89): the transaction marker AND
 * `scheduleProjectionWriteBack`, the deferred write-back helper.
 *
 * The helper's contract (see the invariant in proseProjection.ts): a node view's
 * derived-attr write-back must NEVER dispatch synchronously during view
 * reconciliation — that re-enters the view tree and crashes with "Cannot read
 * properties of undefined (reading 'children')". It defers to a microtask,
 * re-validates the target, and tags the write as a silent projection.
 *
 * NOTE on the regression suite: the actual "reading 'children'" crash is a
 * real-browser ProseMirror view-desc failure that jsdom (no layout) does NOT
 * reproduce, even via the Collaboration fragment-adoption path. So the **guard**
 * against the regression is the `defers ... never during reconciliation` contract
 * test above — it fails the moment the helper dispatches synchronously (the exact
 * cause of the crash). The mount tests below are jsdom **smoke tests**: they prove
 * the deferred write-back path renders a page full of label-less fieldRefs and
 * bakes the labels back in without throwing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Editor, type Extensions } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import {
  PROSE_PROJECTION_META,
  isProjectionTransaction,
  scheduleProjectionWriteBack,
} from './proseProjection';
import Collaboration from '@tiptap/extension-collaboration';
import { prosemirrorToYDoc } from 'y-prosemirror';
import { FieldRef } from './FieldExtension';
import { extensions as fullProseExtensions, sharedProseExtensions } from '../ui/TiptapEditor';
import { useFieldStore } from '../store/fieldStore';

function makeEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  return new Editor({ element, extensions: [StarterKit.configure({ history: false })], content: '<p>x</p>' });
}

describe('isProjectionTransaction', () => {
  it('is false for an ordinary transaction', () => {
    const editor = makeEditor();
    expect(isProjectionTransaction(editor.state.tr)).toBe(false);
    editor.destroy();
  });

  it('is true once tagged with PROSE_PROJECTION_META', () => {
    const editor = makeEditor();
    const tr = editor.state.tr.setMeta(PROSE_PROJECTION_META, true);
    expect(isProjectionTransaction(tr)).toBe(true);
    editor.destroy();
  });
});

// ---- scheduleProjectionWriteBack ------------------------------------------

const isolated: Extensions = [StarterKit.configure({ history: false }), FieldRef];

function mount(content: string, exts: Extensions = isolated): { editor: Editor; element: HTMLElement } {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions: exts, content });
  return { editor, element };
}

/** Position of the first fieldRef node in the doc, or -1. */
function firstFieldPos(editor: Editor): number {
  let pos = -1;
  editor.state.doc.descendants((node, p) => {
    if (pos === -1 && node.type.name === 'fieldRef') pos = p;
    return pos === -1;
  });
  return pos;
}

const flush = () => Promise.resolve();

describe('scheduleProjectionWriteBack', () => {
  beforeEach(() => useFieldStore.getState().clear());
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // A fieldRef whose cached label already equals the store value, so the node
  // view's OWN write-back no-ops — letting us observe the helper in isolation.
  function mountStableField(): { editor: Editor; element: HTMLElement; pos: number } {
    useFieldStore.getState().setField('Company', 'Acme');
    const { editor, element } = mount(
      '<p><span data-field data-name="Company" data-label="Acme"></span></p>',
    );
    return { editor, element, pos: firstFieldPos(editor) };
  }

  it('defers the dispatch to a microtask (never during reconciliation)', async () => {
    const { editor, element, pos } = mountStableField();
    await flush(); // let any mount-time write-back settle (it no-ops here)
    const spy = vi.spyOn(editor.view, 'dispatch');

    scheduleProjectionWriteBack({ editor, getPos: () => pos, nodeName: 'fieldRef', attrs: { label: 'Changed' } });
    expect(spy).not.toHaveBeenCalled(); // synchronous: nothing yet

    await flush();
    expect(spy).toHaveBeenCalledTimes(1); // dispatched only after the microtask

    editor.destroy();
    element.remove();
  });

  it('tags the write-back as a silent projection, out of undo', async () => {
    const { editor, element, pos } = mountStableField();
    await flush();
    let tagged = false;
    let outOfUndo = false;
    editor.on('transaction', ({ transaction }) => {
      if (isProjectionTransaction(transaction)) {
        tagged = true;
        outOfUndo = transaction.getMeta('addToHistory') === false;
      }
    });
    scheduleProjectionWriteBack({ editor, getPos: () => pos, nodeName: 'fieldRef', attrs: { label: 'New' } });
    await flush();
    expect(tagged).toBe(true);
    expect(outOfUndo).toBe(true);
    editor.destroy();
    element.remove();
  });

  it('is idempotent — no dispatch when attrs already match', async () => {
    const { editor, element, pos } = mountStableField();
    await flush();
    const spy = vi.spyOn(editor.view, 'dispatch');
    scheduleProjectionWriteBack({ editor, getPos: () => pos, nodeName: 'fieldRef', attrs: { label: 'Acme' } });
    await flush();
    expect(spy).not.toHaveBeenCalled();
    editor.destroy();
    element.remove();
  });

  it('skips when the identity guard fails (stale pos → different node)', async () => {
    const { editor, element, pos } = mountStableField();
    await flush();
    const spy = vi.spyOn(editor.view, 'dispatch');
    scheduleProjectionWriteBack({
      editor,
      getPos: () => pos,
      nodeName: 'fieldRef',
      identity: (n) => n.attrs['name'] === 'SomeoneElse',
      attrs: { label: 'New' },
    });
    await flush();
    expect(spy).not.toHaveBeenCalled();
    editor.destroy();
    element.remove();
  });

  it('skips when the node type at pos does not match', async () => {
    const { editor, element, pos } = mountStableField();
    await flush();
    const spy = vi.spyOn(editor.view, 'dispatch');
    scheduleProjectionWriteBack({ editor, getPos: () => pos, nodeName: 'citationInline', attrs: { label: 'New' } });
    await flush();
    expect(spy).not.toHaveBeenCalled();
    editor.destroy();
    element.remove();
  });

  it('never dirties a view-only (non-editable) editor', async () => {
    const { editor, element, pos } = mountStableField();
    await flush();
    editor.setEditable(false);
    const spy = vi.spyOn(editor.view, 'dispatch');
    scheduleProjectionWriteBack({ editor, getPos: () => pos, nodeName: 'fieldRef', attrs: { label: 'Changed' } });
    await flush();
    expect(spy).not.toHaveBeenCalled();
    editor.destroy();
    element.remove();
  });

  it('skips when getPos is unavailable (boolean false)', async () => {
    const { editor, element } = mountStableField();
    await flush();
    const spy = vi.spyOn(editor.view, 'dispatch');
    scheduleProjectionWriteBack({ editor, getPos: false, nodeName: 'fieldRef', attrs: { label: 'New' } });
    await flush();
    expect(spy).not.toHaveBeenCalled();
    editor.destroy();
    element.remove();
  });
});

describe('multi-fieldRef live mount (regression: the "reading children" crash)', () => {
  beforeEach(() => useFieldStore.getState().clear());

  it('mounts an editable editor full of label-less fieldRefs without crashing', async () => {
    // Smoke test (jsdom can't reproduce the real-browser crash): many label-less
    // fieldRefs across paragraphs, a table cell, and list items render and write
    // their labels back via the deferred helper without throwing.
    const store = useFieldStore.getState();
    for (const [n, v] of [
      ['Project', 'My Lobby'],
      ['Framework', 'Next.js 15'],
      ['CMS', 'Payload CMS v3'],
      ['Database', 'MongoDB'],
      ['PackageManager', 'bun'],
      ['DocStatus', 'Living document'],
      ['LastReviewed', '2026-06-17'],
    ] as const) {
      store.setField(n, v);
    }
    const content =
      '<p><span data-field data-name="Project"></span> is built on <span data-field data-name="Framework"></span> and <span data-field data-name="CMS"></span>, with <span data-field data-name="Database"></span> for data; the package manager is <span data-field data-name="PackageManager"></span>.</p>' +
      '<table><tbody><tr><th><p>Layer</p></th><th><p>Choice</p></th></tr><tr><td><p>Framework</p></td><td><p><span data-field data-name="Framework"></span></p></td></tr></tbody></table>' +
      '<ul><li><p>Status: <span data-field data-name="DocStatus"></span></p></li><li><p>Reviewed <span data-field data-name="LastReviewed"></span></p></li></ul>';

    let editor!: Editor;
    let element!: HTMLElement;
    expect(() => {
      ({ editor, element } = mount(content, fullProseExtensions));
    }).not.toThrow();

    await flush();
    await flush(); // let the deferred label write-backs apply

    // The page rendered AND the deferred write-backs baked the labels in, so the
    // HTML projection is self-contained (values resolvable offline / in PDF).
    const html = editor.getHTML();
    expect(html).toContain('data-label="My Lobby"');
    expect(html).toContain('data-label="bun"');

    editor.destroy();
    element.remove();
  });

  it('adopts a Collaboration fragment of label-less fieldRefs without crashing', async () => {
    // Smoke test of the TRUE crash path: a relay doc binds the page's
    // Y.XmlFragment via the Collaboration extension, and y-prosemirror builds the
    // editor doc straight from the fragment. With label-less fieldRefs + fields
    // set, every fieldRef's render() write-back fired synchronously during that
    // adoption → the real-browser "reading 'children'" crash. jsdom doesn't
    // reproduce the crash itself, but this exercises the adoption path end-to-end
    // and proves the deferred write-back renders + labels it without throwing.
    const store = useFieldStore.getState();
    for (const [n, v] of [
      ['Project', 'My Lobby'],
      ['Framework', 'Next.js 15'],
      ['CMS', 'Payload CMS v3'],
      ['Database', 'MongoDB'],
      ['PackageManager', 'bun'],
      ['DocStatus', 'Living document'],
      ['LastReviewed', '2026-06-17'],
    ] as const) {
      store.setField(n, v);
    }
    const content =
      '<p><span data-field data-name="Project"></span> on <span data-field data-name="Framework"></span> + <span data-field data-name="CMS"></span>, data <span data-field data-name="Database"></span>, pkg <span data-field data-name="PackageManager"></span>.</p>' +
      '<ul><li><p>Status: <span data-field data-name="DocStatus"></span></p></li><li><p>Reviewed <span data-field data-name="LastReviewed"></span></p></li></ul>';

    // Seed the Y.Doc fragment from a NON-editable parse so the fieldRefs stay
    // label-less (no write-back fires) — matching an MCP-authored relay doc.
    const seedEl = document.createElement('div');
    document.body.appendChild(seedEl);
    const seed = new Editor({ element: seedEl, editable: false, extensions: fullProseExtensions, content });
    const ydoc = prosemirrorToYDoc(seed.state.doc, 'prose:p1');
    seed.destroy();
    seedEl.remove();

    const element = document.createElement('div');
    document.body.appendChild(element);
    let editor!: Editor;
    expect(() => {
      editor = new Editor({
        element,
        extensions: [
          StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: false, history: false }),
          ...sharedProseExtensions,
          Collaboration.configure({ document: ydoc, field: 'prose:p1' }),
        ],
      });
    }).not.toThrow();

    await flush();
    await flush();

    expect(editor.getHTML()).toContain('data-label="My Lobby"');

    editor.destroy();
    element.remove();
  });
});
