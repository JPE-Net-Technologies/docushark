/**
 * Read-only prose chrome (JP-470 S4): the right-click menu and its spelling
 * fixes must be inert when the editor isn't editable.
 *
 * `editable: false` blocks typing, NOT programmatic commands — a suggestion's
 * `insertContent` and every formatting-menu action are exactly such commands,
 * and were live for view-only collab members. Each gate is asserted with an
 * editable control so removing it fails a test.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup, screen, waitFor } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { extensions } from './TiptapEditor';
import { useProseEditorChrome } from './useProseEditorChrome';
import { DocumentEditorContextMenu } from './DocumentEditorContextMenu';
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

describe('spelling fixes in the context menu (DSK-213)', () => {
  // The menu can be open when a permission flip makes the page read-only.
  function renderMenu(ed: Editor) {
    render(
      <DocumentEditorContextMenu
        x={0}
        y={0}
        onClose={vi.fn()}
        editor={ed}
        misspelling={{ word: 'mispeled', range: { from: 5, to: 13 } }}
      />,
    );
  }

  it('right-clicking a misspelled word opens the menu with its fixes first', async () => {
    const ed = make(true);
    render(<ChromeHarness ed={ed} />);
    // In the app the editor sits inside the element carrying onContextMenu.
    screen.getByTestId('prose-host').appendChild(host!);
    const word = await waitFor(() => {
      const underline = ed.view.dom.querySelector('.spellcheck-error');
      if (!underline) throw new Error('no spellcheck underline yet');
      return underline;
    });
    fireEvent.contextMenu(word);
    const first = document.querySelector('.doc-editor-context-menu .doc-editor-context-menu-item');
    expect(first?.textContent).toBe('misspelled');
    expect(screen.getByText('Add to dictionary')).not.toBeNull();
  });

  it('a suggestion writes nothing into a read-only editor', () => {
    const ed = make(false);
    const before = ed.getHTML();
    renderMenu(ed);
    fireEvent.click(screen.getByText('misspelled'));
    expect(ed.getHTML()).toBe(before);
  });

  it('a suggestion replaces the word when editable (control)', () => {
    const ed = make(true);
    renderMenu(ed);
    fireEvent.click(screen.getByText('misspelled'));
    expect(ed.getHTML()).toContain('misspelled');
    expect(ed.getHTML()).not.toContain('mispeled');
  });

  it('Add to dictionary is inert on a read-only editor', () => {
    const ed = make(false);
    const addWord = vi.spyOn(useRichTextStore.getState(), 'addDictionaryWord');
    renderMenu(ed);
    fireEvent.click(screen.getByText('Add to dictionary'));
    expect(SpellcheckService.addToSession).not.toHaveBeenCalled();
    expect(addWord).not.toHaveBeenCalled();
    addWord.mockRestore();
  });

  it('Add to dictionary works when editable (control)', () => {
    const ed = make(true);
    const addWord = vi
      .spyOn(useRichTextStore.getState(), 'addDictionaryWord')
      .mockImplementation(() => {});
    renderMenu(ed);
    fireEvent.click(screen.getByText('Add to dictionary'));
    expect(SpellcheckService.addToSession).toHaveBeenCalledWith('mispeled');
    expect(addWord).toHaveBeenCalledWith('mispeled');
    addWord.mockRestore();
  });
});
