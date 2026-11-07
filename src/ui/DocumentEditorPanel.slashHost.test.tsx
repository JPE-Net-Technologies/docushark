/**
 * The panel answers the "/" commands in every layout (DSK-219). The phone
 * layout has no ribbon, and that is where they used to do nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, cleanup, act } from '@testing-library/react';
import type { Editor } from '@tiptap/core';

const h = vi.hoisted(() => ({ phone: false }));

vi.mock('./layout/useMobileAdaptation', () => ({ useMobileAdaptation: () => ({ mobileActive: h.phone }) }));
vi.mock('./TiptapEditor', () => ({ TiptapEditor: () => null }));
vi.mock('./CollaborativeProseEditor', () => ({ CollaborativeProseEditor: () => null }));
vi.mock('./DocumentEditorToolbar', () => ({ DocumentEditorToolbar: () => null }));
vi.mock('./mobile/MobileProseToolbar', () => ({ MobileProseToolbar: () => null }));
vi.mock('./ProseSelectionBubble', () => ({ ProseSelectionBubble: () => null }));
vi.mock('./RichTextTabBar', () => ({ RichTextTabBar: () => null }));

import { DocumentEditorPanel } from './DocumentEditorPanel';
import { SLASH_COMMANDS } from '../tiptap/slashCommands';

let chosen: number;

beforeEach(() => {
  chosen = 0;
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    if (this.type === 'file') chosen += 1;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe.each([
  ['phone', true],
  ['desktop', false],
])('the prose panel on a %s', (_layout, phone) => {
  it('opens the chooser for /image, /file and /gallery', () => {
    h.phone = phone;
    render(<DocumentEditorPanel />);
    for (const id of ['image', 'file', 'gallery']) {
      act(() => SLASH_COMMANDS.find((command) => command.id === id)!.run(undefined as unknown as Editor));
    }
    expect(chosen).toBe(3);
  });
});
