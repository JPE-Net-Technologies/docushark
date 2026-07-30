/**
 * Read-only prose chrome (JP-470 S4): the right-click surfaces and the
 * spellcheck popover must be inert when the editor isn't editable.
 *
 * `editable: false` blocks typing, NOT programmatic commands — the popover's
 * `insertContent` and every formatting-menu action are exactly such commands,
 * and were live for view-only collab members. Each gate is asserted with an
 * editable control so removing it fails a test.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup, screen } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { extensions } from './TiptapEditor';
import { useProseEditorChrome } from './useProseEditorChrome';
import { SpellcheckPopover } from './SpellcheckPopover';
import { useRichTextStore } from '../store/richTextStore';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';

vi.mock('../services/SpellcheckService', () => ({
  SpellcheckService: {
    prepare: vi.fn(() => Promise.resolve(null)),
    isReady: () => true,
    isMisspelled: (w: string) => w.toLowerCase() === 'mispeled',
    suggest: () => ['misspelled'],
    addToSession: vi.fn(),
    loadCustomWords: vi.fn(),
  },
}));

import { SpellcheckService } from '../services/SpellcheckService';

let editor: Editor | null = null;
let host: HTMLElement | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  useUIPreferencesStore.setState((s) => ({
    appearancePrefs: { ...s.appearancePrefs, spellcheck: 'custom' as const },
  }));
});

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
  host?.remove();
  host = null;
});

function make(editable: boolean): Editor {
  host = document.createElement('div');
  document.body.appendChild(host);
  editor = new Editor({
    element: host,
    extensions,
    content: '<p>one mispeled word</p>',
    editable,
  });
  return editor;
}

function ChromeHarness({ ed }: { ed: Editor }) {
  const { onContextMenu, overlay } = useProseEditorChrome(ed);
  return (
    <div data-testid="prose-host" onContextMenu={onContextMenu}>
      {overlay}
    </div>
  );
}

describe('formatting context menu', () => {
  it('does not open on a read-only surface (native menu keeps copy)', () => {
    const ed = make(false);
    render(<ChromeHarness ed={ed} />);
    const evt = fireEvent.contextMenu(screen.getByTestId('prose-host'));
    expect(document.querySelector('.doc-editor-context-menu')).toBeNull();
    // No preventDefault — the browser's own menu (with Copy) must survive.
    expect(evt).toBe(true);
  });

  it('opens when editable (control)', () => {
    const ed = make(true);
    render(<ChromeHarness ed={ed} />);
    fireEvent.contextMenu(screen.getByTestId('prose-host'));
    expect(document.querySelector('.doc-editor-context-menu')).not.toBeNull();
  });
});

describe('SpellcheckPopover writes', () => {
  it('suggestion click writes nothing into a read-only editor', () => {
    const ed = make(false);
    const before = ed.getHTML();
    render(
      <SpellcheckPopover
        editor={ed}
        word="mispeled"
        range={{ from: 5, to: 13 }}
        x={0}
        y={0}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('misspelled'));
    expect(ed.getHTML()).toBe(before);
  });

  it('suggestion click replaces the word when editable (control)', () => {
    const ed = make(true);
    render(
      <SpellcheckPopover
        editor={ed}
        word="mispeled"
        range={{ from: 5, to: 13 }}
        x={0}
        y={0}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('misspelled'));
    expect(ed.getHTML()).toContain('misspelled');
    expect(ed.getHTML()).not.toContain('mispeled');
  });

  it('Add to Dictionary is inert on a read-only editor', () => {
    const ed = make(false);
    const addWord = vi.spyOn(useRichTextStore.getState(), 'addDictionaryWord');
    render(
      <SpellcheckPopover
        editor={ed}
        word="mispeled"
        range={{ from: 5, to: 13 }}
        x={0}
        y={0}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Add to Dictionary'));
    expect(SpellcheckService.addToSession).not.toHaveBeenCalled();
    expect(addWord).not.toHaveBeenCalled();
    addWord.mockRestore();
  });

  it('Add to Dictionary works when editable (control)', () => {
    const ed = make(true);
    const addWord = vi
      .spyOn(useRichTextStore.getState(), 'addDictionaryWord')
      .mockImplementation(() => {});
    render(
      <SpellcheckPopover
        editor={ed}
        word="mispeled"
        range={{ from: 5, to: 13 }}
        x={0}
        y={0}
        onClose={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByText('Add to Dictionary'));
    expect(SpellcheckService.addToSession).toHaveBeenCalledWith('mispeled');
    expect(addWord).toHaveBeenCalledWith('mispeled');
    addWord.mockRestore();
  });
});
