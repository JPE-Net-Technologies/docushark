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
    // Default scope is cited-only, so cite smith up front (ref not in the store
    // yet → renders [?]); the bibliography lists it once the ref is added.
    editor.commands.insertContent('Body text. ');
    editor.commands.setCitation('smith2020');
    editor.commands.insertBibliography();
    const bib = () => element.querySelector('.bibliography-content');

    await waitFor(() => (bib()?.textContent ?? '').includes('No references'));

    useReferenceStore.getState().addReference(smith);
    await waitFor(() => (bib()?.textContent ?? '').includes('Smith'));
    expect(bib()?.textContent).toContain('Behaviour of Things');

    editor.destroy();
    element.remove();
  });
});

describe('citation hover card (JP-89 delight slice)', () => {
  it('shows a card with the reference on hover and hides it on leave', async () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.setCitation('smith2020');

    const cite = element.querySelector('.citation-inline') as HTMLElement;
    expect(cite).not.toBeNull();

    cite.dispatchEvent(new MouseEvent('mouseenter'));
    // Card appears after the dwell delay, painted synchronously with the cheap
    // preview text (no need to await the async CSL format).
    await waitFor(() => {
      const card = document.querySelector('.citation-card') as HTMLElement | null;
      return !!card && card.style.display === 'block' && (card.textContent ?? '').includes('Smith');
    });

    cite.dispatchEvent(new MouseEvent('mouseleave'));
    const card = document.querySelector('.citation-card') as HTMLElement | null;
    expect(card?.style.display).toBe('none');

    editor.destroy();
    element.remove();
  });
});

describe('cited-only bibliography (JP-89 delight slice)', () => {
  const doe: CSLItem = {
    id: 'doe2019',
    type: 'book',
    title: 'A Treatise',
    author: [{ family: 'Doe', given: 'John' }],
    issued: { 'date-parts': [[2019]] },
  };

  it('defaults to cited-only: lists a ref only once it is cited', async () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.insertContent('Body text. '); // non-empty para so the bib appends after it
    editor.commands.insertBibliography();
    const content = () => element.querySelector('.bibliography-content');

    // Ref exists but is not cited → cited-only shows the empty-cited message.
    await waitFor(() => (content()?.textContent ?? '').includes('No citations in this document'));

    editor.commands.focus('start'); // caret into the paragraph (not on the bib node)
    editor.commands.setCitation('smith2020');
    await waitFor(() => (content()?.textContent ?? '').includes('Smith'));

    editor.destroy();
    element.remove();
  });

  it('the All toggle shows uncited references and persists data-scope', async () => {
    useReferenceStore.getState().addReference(smith); // uncited
    useReferenceStore.getState().addReference(doe); // uncited
    const { editor, element } = makeEditor();
    editor.commands.insertBibliography();
    const content = () => element.querySelector('.bibliography-content');
    await waitFor(() => (content()?.textContent ?? '').includes('No citations in this document'));

    // Default scope emits no data-scope attr (clean serialization).
    expect(editor.getHTML()).not.toContain('data-scope');

    const allBtn = [...element.querySelectorAll('.bibliography-scope-btn')].find(
      (b) => b.textContent === 'All references',
    ) as HTMLButtonElement;
    expect(allBtn).toBeTruthy();
    allBtn.click();

    await waitFor(() => (content()?.textContent ?? '').includes('Smith') && (content()?.textContent ?? '').includes('Doe'));
    expect(editor.getHTML()).toContain('data-scope="all"');

    editor.destroy();
    element.remove();
  });

  it('round-trips the scope attr through getHTML → setContent', () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.insertBibliography();
    // Force scope=all via a node-attr update (the toggle's effect).
    let pos = -1;
    editor.state.doc.descendants((n, p) => {
      if (n.type.name === 'bibliography') pos = p;
    });
    editor.view.dispatch(
      editor.state.tr.setNodeMarkup(pos, undefined, {
        ...editor.state.doc.nodeAt(pos)!.attrs,
        scope: 'all',
      }),
    );
    const html = editor.getHTML();
    expect(html).toContain('data-scope="all"');

    const { editor: e2, element: el2 } = makeEditor();
    e2.commands.setContent(html);
    let scope: unknown = null;
    e2.state.doc.descendants((n) => {
      if (n.type.name === 'bibliography') scope = n.attrs['scope'];
    });
    expect(scope).toBe('all');

    editor.destroy();
    element.remove();
    e2.destroy();
    el2.remove();
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
    editor.commands.setCitation('smith2020'); // cited-only default → cite it first
    editor.commands.insertBibliography();

    await waitFor(() => editor.getHTML().includes('Smith'));
    expect(editor.getHTML()).toContain('data-bibliography');
    expect(editor.getHTML()).toContain('Smith');

    editor.destroy();
    element.remove();
  });

  // Regression guard for the foundation: a save→load round-trip
  // (getHTML → setContent into a fresh editor) must preserve BOTH custom nodes.
  // The bibliography previously vanished on reload (reserved `content` attr +
  // DOM-node renderHTML + duplicated/newline'd serialization).
  it('survives a getHTML → setContent round-trip (bibliography node + cached html)', async () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.setCitation('smith2020'); // cited-only default → cite it first
    editor.commands.insertBibliography();
    await waitFor(() => editor.getHTML().includes('Smith'));
    const html = editor.getHTML();

    const { editor: e2, element: el2 } = makeEditor();
    e2.commands.setContent(html);

    let bibCount = 0;
    let bibHtml = '';
    e2.state.doc.descendants((n) => {
      if (n.type.name === 'bibliography') {
        bibCount++;
        bibHtml = (n.attrs['bibHtml'] as string) ?? '';
      }
    });
    expect(bibCount).toBe(1); // node preserved, not dropped
    expect(bibHtml).toContain('Smith'); // cached html preserved in the attribute
    expect(bibHtml).not.toMatch(/[\r\n]/); // single-line (serializer-robust)

    editor.destroy();
    element.remove();
    e2.destroy();
    el2.remove();
  });

  it('tags its write-back transactions as prose projections (silent, no autosave)', async () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();

    let projectionTxns = 0;
    editor.on('transaction', ({ transaction }) => {
      if (transaction.getMeta('proseProjection') === true) projectionTxns++;
    });

    editor.commands.setCitation('smith2020');
    editor.commands.insertBibliography();
    // Wait for both nodeViews to format + write back.
    await waitFor(() => projectionTxns >= 2);
    expect(projectionTxns).toBeGreaterThanOrEqual(2);

    editor.destroy();
    element.remove();
  });

  it('emits clean data-* serialization (no reserved/bare attrs, childless bib)', async () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.setCitation('smith2020');
    editor.commands.insertBibliography();
    await waitFor(() => editor.getHTML().includes('data-bib-html'));
    const html = editor.getHTML();

    // No reserved/auto-rendered bare attributes leaked.
    expect(html).not.toMatch(/<span[^>]*\srefid=/);
    expect(html).not.toMatch(/<span[^>]*\slabel=/);
    expect(html).not.toMatch(/<div[^>]*\scontent=/);
    // Bibliography is a childless div carrying its cached html in a data attr.
    expect(html).toMatch(/<div data-bib-html="[^"]*"[^>]*><\/div>|<div[^>]*data-bib-html="[^"]*"[^>]*><\/div>/);

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

  it('paints the cached label on mount without waiting on the format chunk', () => {
    // A reload scenario: the ref isn't in the store, but the node carries a
    // cached label — it must show immediately (resilient to a slow/failed chunk).
    const { editor, element } = makeEditor();
    editor.commands.setContent(
      '<p><span data-citation data-ref-id="x" data-label="(Cached, 2020)"></span></p>',
    );
    // Synchronous — no await, no store entry, no format chunk.
    expect(element.querySelector('.citation-inline')?.textContent).toBe('(Cached, 2020)');

    editor.destroy();
    element.remove();
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
