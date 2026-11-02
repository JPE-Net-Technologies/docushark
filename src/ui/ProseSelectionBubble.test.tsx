/**
 * The selection bubble (DSK-200): when it shows, and what its buttons do.
 * tippy can't lay out in jsdom, so the BubbleMenu renders its contents in place.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Highlight from '@tiptap/extension-highlight';
import { NodeSelection } from '@tiptap/pm/state';

const h = vi.hoisted(() => ({ editor: null as unknown }));
vi.mock('./TiptapEditorContext', () => ({ useTiptapEditor: () => h.editor }));
vi.mock('@tiptap/react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tiptap/react')>()),
  BubbleMenu: ({ children }: { children: ReactNode }) => <div data-testid="bubble">{children}</div>,
}));

import { BUBBLE_HIGHLIGHT, ProseSelectionBubble, shouldShowBubble } from './ProseSelectionBubble';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';

let editor: Editor;
function make(content: string): Editor {
  editor = new Editor({
    element: document.createElement('div'),
    extensions: [StarterKit, Highlight.configure({ multicolor: true })],
    content,
  });
  // jsdom can't focus a contenteditable; focus is the browser's business.
  editor.view.hasFocus = () => focused;
  h.editor = editor;
  return editor;
}
let focused = true;

const shows = () =>
  shouldShowBubble({
    editor,
    view: editor.view,
    state: editor.state,
    from: editor.state.selection.from,
    to: editor.state.selection.to,
  });

afterEach(() => {
  cleanup();
  editor?.destroy();
  focused = true;
  useUIPreferencesStore.getState().setSelectionBubble(true);
});

describe('ProseSelectionBubble (DSK-200)', () => {
  it('shows for selected text in focused, editable prose', () => {
    make('<p>Hello world</p>');
    editor.commands.setTextSelection({ from: 1, to: 6 });
    expect(shows()).toBe(true);
  });

  it('stays away from a caret, unfocused or read-only text, code and node selections', () => {
    // <p>Hello world</p> spans 0-13, the code block 13-20, the rule 20.
    make('<p>Hello world</p><pre><code>let x</code></pre><hr>');
    editor.commands.setTextSelection(3);
    expect(shows()).toBe(false);

    editor.commands.setTextSelection({ from: 1, to: 6 });
    focused = false;
    expect(shows()).toBe(false);
    focused = true;

    editor.setEditable(false);
    expect(shows()).toBe(false);
    editor.setEditable(true);

    editor.commands.setTextSelection({ from: 14, to: 17 });
    expect(shows()).toBe(false);

    editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc, 20)));
    expect(shows()).toBe(false);
  });

  it('formats the selection, and turns highlight and headings back off', () => {
    make('<p>Hello world</p>');
    render(<ProseSelectionBubble />);
    editor.commands.setTextSelection({ from: 1, to: 6 });

    fireEvent.click(screen.getByRole('button', { name: /^Bold/ }));
    expect(editor.isActive('bold')).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'Highlight' }));
    expect(editor.getAttributes('highlight')['color']).toBe(BUBBLE_HIGHLIGHT);
    fireEvent.click(screen.getByRole('button', { name: 'Highlight' }));
    expect(editor.isActive('highlight')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Heading 1' }));
    expect(editor.isActive('heading', { level: 1 })).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Heading 1' }));
    expect(editor.isActive('heading', { level: 1 })).toBe(false);
  });

  it('is gone while the setting is off', () => {
    make('<p>Hello</p>');
    useUIPreferencesStore.getState().setSelectionBubble(false);
    render(<ProseSelectionBubble />);
    expect(screen.queryByTestId('bubble')).toBeNull();
  });
});
