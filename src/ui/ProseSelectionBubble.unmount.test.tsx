/**
 * The selection bubble can be turned off, or its panel can go away, while the
 * editor lives (DSK-200). Tiptap's BubbleMenu plugin moves the menu's element
 * into tippy's popper; unmounting used to make React remove that element from
 * a parent it had already left, which threw and took the editor down.
 * Uses the real BubbleMenu and tippy.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';

const h = vi.hoisted(() => ({ editor: null as unknown }));
vi.mock('./TiptapEditorContext', () => ({ useTiptapEditor: () => h.editor }));

import { ProseSelectionBubble } from './ProseSelectionBubble';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';

let editor: Editor | null = null;
afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
  useUIPreferencesStore.getState().setSelectionBubble(true);
});

describe('ProseSelectionBubble unmounting (DSK-200)', () => {
  it('can be turned off, and unmounted, without throwing', () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    editor = new Editor({ element, extensions: [StarterKit], content: '<p>Hello</p>' });
    h.editor = editor;

    const { unmount } = render(<ProseSelectionBubble />);
    expect(() => act(() => useUIPreferencesStore.getState().setSelectionBubble(false))).not.toThrow();
    act(() => useUIPreferencesStore.getState().setSelectionBubble(true));
    expect(() => unmount()).not.toThrow();
  });
});
