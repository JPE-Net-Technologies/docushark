/**
 * Bibliography fallback (JP-89 delight follow-up).
 *
 * When the lazy CSL formatter is unavailable (failed dynamic import) or citeproc
 * returns nothing, the bibliography must degrade to a dependency-free list built
 * from `referencePreview` instead of showing an error box. Here the format
 * module is mocked to return empty strings (the citeproc-produced-nothing case),
 * scoped to this file so it doesn't affect the real-formatting tests.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

vi.mock('../services/citations/format', () => ({
  formatBibliography: async () => '',
  formatCitation: async () => '',
  __resetCiteCacheForTests: () => {},
}));

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

async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => useReferenceStore.getState().clear());

describe('bibliography fallback when the formatter yields nothing', () => {
  it('renders a plain preview list instead of an error box', async () => {
    useReferenceStore.getState().addReference(smith);
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({ element, extensions, content: '<p></p>' });
    editor.commands.setCitation('smith2020'); // cited-only default → cite it first
    editor.commands.insertBibliography();

    const content = () => element.querySelector('.bibliography-content');
    await waitFor(() => (content()?.textContent ?? '').includes('Smith'));
    expect(content()?.textContent).toContain('Behaviour of Things'); // referencePreview
    expect(content()?.textContent).not.toContain('Could not render');

    editor.destroy();
    element.remove();
  });

  it('inline citation degrades to a readable author-year, not the bare DOI', async () => {
    // A DOI-resolved ref whose id IS the DOI — the exact "displays DOI URIs" case.
    useReferenceStore.getState().addReference({
      id: '10.1038/nphys1170',
      type: 'article-journal',
      title: 'Measured measurement',
      author: [{ family: 'Aspelmeyer', given: 'Markus' }],
      issued: { 'date-parts': [[2009]] },
      DOI: '10.1038/nphys1170',
    });
    const element = document.createElement('div');
    document.body.appendChild(element);
    const editor = new Editor({ element, extensions, content: '<p></p>' });
    editor.commands.setCitation('10.1038/nphys1170');

    const cite = () => element.querySelector('.citation-inline');
    await waitFor(() => (cite()?.textContent ?? '').includes('Aspelmeyer'));
    expect(cite()?.textContent).toBe('(Aspelmeyer, 2009)');
    expect(cite()?.textContent).not.toContain('10.1038'); // never the bare DOI

    editor.destroy();
    element.remove();
  });
});
