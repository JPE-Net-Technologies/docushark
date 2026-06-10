/**
 * Tests for the `@`-trigger citation autocomplete (JP-89 delight slice).
 *
 * The pure trigger/filter helpers are unit-tested directly; activation +
 * commit are exercised through a headless `Editor` (jsdom), reading the plugin
 * state via `citationSuggestionKey` and inserting via `commitActiveSuggestion`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { TextSelection } from '@tiptap/pm/state';
import { CitationInline, Bibliography } from './CitationExtension';
import {
  CitationSuggestion,
  citationSuggestionKey,
  commitActiveSuggestion,
  matchCitationTrigger,
  filterReferences,
} from './CitationSuggestion';
import { useReferenceStore } from '../store/referenceStore';
import type { CSLItem } from '../types/Citation';

const extensions = [
  StarterKit.configure({ history: false }),
  CitationInline,
  Bibliography,
  CitationSuggestion,
];

const smith: CSLItem = {
  id: 'smith2020',
  type: 'article-journal',
  title: 'On the Behaviour of Things',
  author: [{ family: 'Smith', given: 'Jane' }],
  issued: { 'date-parts': [[2020]] },
};
const doe: CSLItem = {
  id: 'doe2019',
  type: 'book',
  title: 'A Treatise',
  author: [{ family: 'Doe', given: 'John' }],
  issued: { 'date-parts': [[2019]] },
};

function makeEditor() {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const editor = new Editor({ element, extensions, content: '<p></p>' });
  return { editor, element };
}

beforeEach(() => useReferenceStore.getState().clear());

describe('matchCitationTrigger', () => {
  it('matches `@` at the start of a block', () => {
    expect(matchCitationTrigger('@smi')).toEqual({ query: 'smi', from: 0 });
  });
  it('matches `@` after whitespace and reports the @ offset', () => {
    expect(matchCitationTrigger('see @smith')).toEqual({ query: 'smith', from: 4 });
  });
  it('matches a bare `@` with an empty query', () => {
    expect(matchCitationTrigger('hello @')).toEqual({ query: '', from: 6 });
  });
  it('matches after an opening bracket', () => {
    expect(matchCitationTrigger('(@doe')).toEqual({ query: 'doe', from: 1 });
  });
  it('does NOT match `@` glued to a preceding word (emails)', () => {
    expect(matchCitationTrigger('user@host')).toBeNull();
  });
  it('does NOT match once whitespace breaks the token', () => {
    expect(matchCitationTrigger('@smith now')).toBeNull();
  });
});

describe('filterReferences', () => {
  it('returns all (capped) for an empty query', () => {
    expect(filterReferences([smith, doe], '')).toHaveLength(2);
    expect(filterReferences([smith, doe], '', 1)).toHaveLength(1);
  });
  it('filters by author/title preview and by id', () => {
    expect(filterReferences([smith, doe], 'smith').map((r) => r.id)).toEqual(['smith2020']);
    expect(filterReferences([smith, doe], 'treatise').map((r) => r.id)).toEqual(['doe2019']);
    expect(filterReferences([smith, doe], 'doe2019').map((r) => r.id)).toEqual(['doe2019']);
  });
});

describe('suggestion activation + commit (headless editor)', () => {
  it('activates on a `@` token and tracks the query', () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.insertContent('@smi');

    const state = citationSuggestionKey.getState(editor.state)!;
    expect(state.from).not.toBeNull();
    expect(state.query).toBe('smi');

    editor.destroy();
    element.remove();
  });

  it('inserts a citationInline for the highlighted ref and removes the @token', () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.insertContent('see @smi');

    expect(commitActiveSuggestion(editor.view)).toBe(true);

    const html = editor.getHTML();
    expect(html).toContain('data-ref-id="smith2020"');
    expect(html).not.toContain('@smi'); // the trigger token was consumed
    // suggestion is closed after commit
    expect(citationSuggestionKey.getState(editor.state)!.from).toBeNull();

    editor.destroy();
    element.remove();
  });

  it('commits an explicitly-named ref (the popup click path)', () => {
    useReferenceStore.getState().addReference(smith);
    useReferenceStore.getState().addReference(doe);
    const { editor, element } = makeEditor();
    editor.commands.insertContent('@');

    expect(commitActiveSuggestion(editor.view, 'doe2019')).toBe(true);
    expect(editor.getHTML()).toContain('data-ref-id="doe2019"');

    editor.destroy();
    element.remove();
  });

  it('does not activate inside an email-like token', () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.insertContent('mail user@host');

    expect(citationSuggestionKey.getState(editor.state)!.from).toBeNull();
    expect(commitActiveSuggestion(editor.view)).toBe(false);

    editor.destroy();
    element.remove();
  });

  it('deactivates when the caret leaves the token', () => {
    useReferenceStore.getState().addReference(smith);
    const { editor, element } = makeEditor();
    editor.commands.insertContent('@smi');
    expect(citationSuggestionKey.getState(editor.state)!.from).not.toBeNull();

    // Move the caret to the very start of the doc, away from the token.
    editor.view.dispatch(
      editor.state.tr.setSelection(TextSelection.atStart(editor.state.doc)),
    );
    expect(citationSuggestionKey.getState(editor.state)!.from).toBeNull();

    editor.destroy();
    element.remove();
  });
});
