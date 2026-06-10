/**
 * Tests for paste-a-DOI-to-cite (JP-89 delight slice).
 *
 * `isBareDoi` is unit-tested directly; the paste handler is exercised through a
 * headless editor with `resolveDoi` mocked (no network), asserting the pasted
 * DOI text becomes a citation and the reference lands in the store.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { CitationInline, Bibliography } from './CitationExtension';

vi.mock('../services/citations/ingest', async (orig) => {
  const actual = (await orig()) as Record<string, unknown>;
  return {
    ...actual,
    resolveDoi: vi.fn(async (doi: string) => ({
      items: [
        {
          id: 'resolved-1',
          type: 'article-journal',
          title: 'Resolved Work',
          author: [{ family: 'Curie', given: 'Marie' }],
          issued: { 'date-parts': [[1903]] },
          DOI: doi.replace(/^https?:\/\/doi\.org\//, ''),
        },
      ],
      report: { source: 'doi', count: 1, errors: [], warnings: [] },
    })),
  };
});

import { handleCitationDoiPaste, isBareDoi } from './citationPaste';
import { useReferenceStore } from '../store/referenceStore';

const extensions = [StarterKit.configure({ history: false }), CitationInline, Bibliography];

function makeEditor() {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions, content: '<p></p>' });
  return { editor, element };
}

function pasteEvent(text: string): ClipboardEvent {
  return { clipboardData: { getData: () => text } } as unknown as ClipboardEvent;
}

async function tick(predicate: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error('tick timed out');
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => useReferenceStore.getState().clear());

describe('isBareDoi', () => {
  it('accepts a bare DOI and a doi.org URL', () => {
    expect(isBareDoi('10.1000/xyz123')).toBe(true);
    expect(isBareDoi('https://doi.org/10.1000/xyz123')).toBe(true);
    expect(isBareDoi('  10.1000/xyz123  ')).toBe(true);
  });
  it('rejects non-DOIs and multi-token pastes', () => {
    expect(isBareDoi('hello world')).toBe(false);
    expect(isBareDoi('10.1000/xyz here is text')).toBe(false);
    expect(isBareDoi('not a doi')).toBe(false);
    expect(isBareDoi('')).toBe(false);
  });
});

describe('handleCitationDoiPaste', () => {
  it('ignores a non-DOI paste (returns false)', () => {
    const { editor, element } = makeEditor();
    expect(handleCitationDoiPaste(editor.view, pasteEvent('just some text'))).toBe(false);
    editor.destroy();
    element.remove();
  });

  it('resolves a pasted DOI into a citation and adds the reference', async () => {
    const { editor, element } = makeEditor();
    editor.commands.focus();

    expect(handleCitationDoiPaste(editor.view, pasteEvent('10.1000/xyz123'))).toBe(true);
    // The DOI text is inserted synchronously first (nothing lost).
    expect(editor.getText()).toContain('10.1000/xyz123');

    // After async resolution the text is replaced with a citation node.
    await tick(() => editor.getHTML().includes('data-ref-id'));
    expect(editor.getHTML()).toContain('data-citation');
    expect(editor.getHTML()).not.toContain('10.1000/xyz123'); // text consumed

    // The resolved reference is in the library.
    expect(useReferenceStore.getState().listReferences().some((r) => r.DOI === '10.1000/xyz123')).toBe(true);

    editor.destroy();
    element.remove();
  });
});
