/**
 * resetEditorHistory (DSK-201): after a page or document load, undo has
 * nothing to revert.
 *
 * The previous reset swapped in a fresh `history()` plugin and reconfigured,
 * but `reconfigure` carries plugin state over by field name, and every
 * prosemirror-history plugin shares one key: the old stack survived. Undo right
 * after opening a document blanked the page; after a page switch it brought
 * back the previous page's content.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { extensions } from '../ui/TiptapEditor';
import { resetEditorHistory } from './resetEditorHistory';

let editor: Editor | null = null;

function make(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  editor = new Editor({ element, extensions, content });
  return editor;
}

function undoDepth(ed: Editor): number {
  const plugin = ed.state.plugins.find((p) => (p as unknown as { key: string }).key.startsWith('history$'));
  const state = plugin?.getState(ed.state) as { done: { eventCount: number } } | undefined;
  return state?.done.eventCount ?? -1;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe('resetEditorHistory (DSK-201)', () => {
  it('leaves nothing to undo after a load, so undo cannot blank the page', () => {
    const ed = make('<p></p>');
    ed.commands.setContent('<p>The document just opened.</p>');
    expect(ed.can().undo()).toBe(true); // the load is undoable until reset

    resetEditorHistory(ed);

    expect(undoDepth(ed)).toBe(0);
    expect(ed.can().undo()).toBe(false);
    ed.commands.undo();
    expect(ed.getText()).toBe('The document just opened.');
  });

  it('keeps undo from walking back into the previous page', () => {
    const ed = make('<p>Page one</p>');
    ed.chain().focus('end').insertContent(', edited').run();

    // Switch to page two, as the editor panel does.
    ed.commands.setContent('<p>Page two</p>');
    resetEditorHistory(ed);

    ed.commands.undo();
    expect(ed.getText()).toBe('Page two');
  });

  it('keeps undo working for edits made after the reset', () => {
    const ed = make('<p>Hello</p>');
    resetEditorHistory(ed);
    ed.chain().focus('end').insertContent(' world').run();

    ed.commands.undo();
    expect(ed.getText()).toBe('Hello');
    ed.commands.redo();
    expect(ed.getText()).toBe('Hello world');
  });

  it('keeps the document, selection and plugin set', () => {
    const ed = make('<p>Keep me</p>');
    ed.commands.setTextSelection(3);
    const plugins = ed.state.plugins.length;

    resetEditorHistory(ed);

    expect(ed.getText()).toBe('Keep me');
    expect(ed.state.selection.from).toBe(3);
    expect(ed.state.plugins.length).toBe(plugins);
  });
});
