/**
 * Tests for the citation Tiptap nodes (JP-89 slice 4).
 *
 * Headless via `new Editor` in jsdom (modelled on
 * `src/collaboration/YjsDocument.prose.test.ts`; there is no `@tiptap/html` dep).
 * Covers the schema round-trip (sync `renderHTML`/`parseHTML`) and the live,
 * store-reactive `nodeView` rendering (async, real citation-js + bundled CSL).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CitationInline, Bibliography } from './CitationExtension';
import { useReferenceStore } from '../store/referenceStore';
import type { CSLItem } from '../types/Citation';

const extensions = [StarterKit.configure({ history: false }), CitationInline, Bibliography];

const smith: CSLItem = {
  id: 'smith2020',
  type: 'article-journal',
  title: 'On the Behaviour of Things',
  author: [{ family: 'Smith', given: 'Jane' }],
  issued: { 'date-parts': [[2020]] },
};

function makeEditor(): { editor: Editor; element: HTMLElement } {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions, content: '<p></p>' });
  return { editor, element };
}

/** Poll the DOM until `predicate` passes or we time out. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => useReferenceStore.getState().clear());

describe('citation schema round-trip', () => {
  it('setCitation inserts an inline node carrying the refId', () => {
    const { editor, element } = makeEditor();
    editor.commands.setCitation('smith2020', '12');

    const html = editor.getHTML();
    expect(html).toContain('data-citation');
    expect(html).toContain('data-ref-id="smith2020"');
    expect(html).toContain('data-locator="12"');

    editor.destroy();
    element.remove();
  });

  it('parses citation HTML back into a node, preserving refId', () => {
    const { editor, element } = makeEditor();
    editor.commands.setContent('<p><span data-citation data-ref-id="doe2019"></span></p>');

    let found: { refId: unknown } | null = null;
    editor.state.doc.descendants((node) => {
      if (node.type.name === 'citationInline') found = { refId: node.attrs['refId'] };
    });
    expect(found).not.toBeNull();
    expect(found!.refId).toBe('doe2019');

    editor.destroy();
    element.remove();
  });

  it('insertBibliography inserts a bibliography block', () => {
    const { editor, element } = makeEditor();
    editor.commands.insertBibliography();
    expect(editor.getHTML()).toContain('data-bibliography');

    editor.destroy();
    element.remove();
  });
});

describe('citation nodeView (live, store-reactive)', () => {
  it('renders the formatted citation and re-renders on style change', async () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.setCitation('smith2020');

    const cite = () => element.querySelector('.citation-inline');
    await waitFor(() => (cite()?.textContent ?? '').includes('Smith'));
    expect(cite()?.textContent).toContain('2020'); // APA author-date

    useReferenceStore.getState().setStyle('vancouver');
    await waitFor(() => /\d/.test(cite()?.textContent ?? '') && !(cite()?.textContent ?? '').includes('Smith'));
    expect(cite()?.textContent).not.toContain('Smith'); // numeric style

    editor.destroy();
    element.remove();
  });

  it('shows a placeholder for a missing reference', async () => {
    const { editor, element } = makeEditor();
    editor.commands.setCitation('does-not-exist');
    const cite = () => element.querySelector('.citation-inline');
    await waitFor(() => (cite()?.textContent ?? '') === '[?]');
    expect(cite()?.textContent).toBe('[?]');

    editor.destroy();
    element.remove();
  });

  it('bibliography renders entries and reacts to added references', async () => {
    const { editor, element } = makeEditor();
    editor.commands.insertBibliography();
    const bib = () => element.querySelector('.bibliography-block');

    await waitFor(() => (bib()?.textContent ?? '').includes('No references'));

    useReferenceStore.getState().addReference(smith);
    await waitFor(() => (bib()?.textContent ?? '').includes('Smith'));
    expect(bib()?.textContent).toContain('Behaviour of Things');

    editor.destroy();
    element.remove();
  });
});

describe('citation projection — getHTML self-contained (JP-89 slice 5.5)', () => {
  it('caches the formatted citation into getHTML (refId + label)', async () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.setCitation('smith2020');

    const cite = () => element.querySelector('.citation-inline');
    await waitFor(() => (cite()?.textContent ?? '').includes('Smith'));
    // The nodeView writes the label back into the node attr (async microtask).
    await waitFor(() => editor.getHTML().includes('Smith'));

    const html = editor.getHTML();
    expect(html).toContain('data-ref-id="smith2020"');
    expect(html).toContain('Smith'); // formatted text now in the projection
    expect(html).toContain('2020');

    editor.destroy();
    element.remove();
  });

  it('caches the bibliography HTML into getHTML', async () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.insertBibliography();

    await waitFor(() => editor.getHTML().includes('csl-entry') || editor.getHTML().includes('Smith'));
    expect(editor.getHTML()).toContain('Smith');

    editor.destroy();
    element.remove();
  });

  it('re-labels the projection when the style changes', async () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.setCitation('smith2020');
    await waitFor(() => editor.getHTML().includes('Smith'));

    useReferenceStore.getState().setStyle('vancouver');
    // Numeric style → the cached label becomes a number, no author name.
    await waitFor(() => /data-label="[^"]*\d[^"]*"/.test(editor.getHTML()) && !editor.getHTML().includes('Smith'));
    expect(editor.getHTML()).not.toContain('Smith');

    editor.destroy();
    element.remove();
  });

  it('round-trips the cached label through parse (label preserved)', async () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.setCitation('smith2020');
    await waitFor(() => editor.getHTML().includes('Smith'));
    const html = editor.getHTML();

    const { editor: editor2, element: el2 } = makeEditor();
    editor2.commands.setContent(html);
    let label: unknown = null;
    editor2.state.doc.descendants((n) => {
      if (n.type.name === 'citationInline') label = n.attrs['label'];
    });
    expect(label).toContain('Smith');

    editor.destroy();
    element.remove();
    editor2.destroy();
    el2.remove();
  });

  it('keeps the label write-back out of the undo stack', async () => {
    useReferenceStore.getState().addReference(smith);
    // History on (default StarterKit) so undo() exists — the local editor's setup.
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({
      element,
      extensions: [StarterKit, CitationInline, Bibliography],
      content: '<p></p>',
    });
    editor.commands.setCitation('smith2020');
    await waitFor(() => editor.getHTML().includes('Smith'));

    // A single undo should remove the citation itself, not undo a label tweak
    // (the write-back uses addToHistory:false, so it isn't its own undo step).
    editor.commands.undo();
    let hasCitation = false;
    editor.state.doc.descendants((n) => {
      if (n.type.name === 'citationInline') hasCitation = true;
    });
    expect(hasCitation).toBe(false);

    editor.destroy();
    element.remove();
  });
});
