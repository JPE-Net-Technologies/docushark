/**
 * Pressing the selection bubble's buttons (DSK-200). Tiptap's BubbleMenu plugin
 * moves the bubble into tippy's popper on <body>, outside the container React
 * renders into, and React drops events from elements outside its containers:
 * every press did nothing while the same commands worked from the ribbon.
 * Uses the real BubbleMenu and tippy, so the bubble lands where it does in the app.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

const h = vi.hoisted(() => ({ editor: null as unknown }));
vi.mock('./TiptapEditorContext', () => ({ useTiptapEditor: () => h.editor }));

import { ProseSelectionBubble } from './ProseSelectionBubble';

let editor: Editor | null = null;
afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
  document.body.innerHTML = '';
});

/** An editor attached to the page, with the browser's focus and layout stood in. */
function makeEditor(): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const made = new Editor({ element, extensions: [StarterKit], content: '<p>Hello world</p>' });
  made.view.hasFocus = () => true;
  made.view.coordsAtPos = () => ({ left: 0, right: 0, top: 0, bottom: 0 });
  h.editor = made;
  return made;
}

/** Select "Hello" and wait for the bubble to show inside tippy's popper. */
async function showBubble(made: Editor): Promise<HTMLElement> {
  made.commands.setTextSelection({ from: 1, to: 6 });
  return waitFor(() => {
    const bubble = document.querySelector<HTMLElement>('[data-tippy-root] .prose-bubble');
    if (!bubble) throw new Error('bubble not shown');
    return bubble;
  });
}

describe('ProseSelectionBubble presses (DSK-200)', () => {
  it('formats the selection when a button is pressed', async () => {
    editor = makeEditor();
    render(<ProseSelectionBubble />);
    const bubble = await showBubble(editor);

    fireEvent.click(bubble.querySelector('button[aria-label^="Bold"]')!);
    expect(editor.isActive('bold')).toBe(true);
  });

  it('keeps focus in the text when a button is pressed', async () => {
    editor = makeEditor();
    render(<ProseSelectionBubble />);
    const bubble = await showBubble(editor);

    // fireEvent returns false when a handler prevented the default (the focus move).
    expect(fireEvent.mouseDown(bubble.querySelector('button')!)).toBe(false);
  });
});
