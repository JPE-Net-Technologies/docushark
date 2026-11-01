/**
 * What the selection brings to the phone's bar (DSK-202), on a real editor.
 *
 * On a phone a long-press is the system's selection gesture, so the editor's
 * right-click menus never open there. Their spelling fixes and image actions
 * come to the bar instead, in the formatting controls' place, while they apply.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import { Editor } from '@tiptap/core';

vi.mock('../../tiptap/slashUi', () => ({ registerSlashUiHandler: () => () => {} }));
vi.mock('../../services/SpellcheckService', () => ({
  SpellcheckService: {
    prepare: vi.fn(() => Promise.resolve(null)),
    isReady: () => true,
    isMisspelled: (w: string) => w.toLowerCase() === 'mispeled',
    suggest: () => ['misspelled', 'dispelled'],
    addToSession: vi.fn(),
    loadCustomWords: vi.fn(),
  },
}));

import { extensions } from '../TiptapEditor';
import { TiptapEditorProvider } from '../TiptapEditorContext';
import { MobileProseToolbar } from './MobileProseToolbar';
import { SpellcheckService } from '../../services/SpellcheckService';
import { useRichTextStore } from '../../store/richTextStore';
import { useUIPreferencesStore } from '../../store/uiPreferencesStore';

let editor: Editor | null = null;

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
});

async function mount(content: string): Promise<Editor> {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const ed = new Editor({ element, extensions, content });
  editor = ed;
  render(
    <TiptapEditorProvider value={ed}>
      <MobileProseToolbar />
    </TiptapEditorProvider>,
  );
  // The editor's create event, then the checker's first pass.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return ed;
}

/** The document position `offset` characters into the first occurrence of `text`. */
function posOf(ed: Editor, text: string, offset = 0): number {
  let pos = -1;
  ed.state.doc.descendants((node, p) => {
    if (pos < 0 && node.isText && node.text?.includes(text)) pos = p + node.text.indexOf(text) + offset;
  });
  if (pos < 0) throw new Error(`no text ${text}`);
  return pos;
}

function select(ed: Editor, from: number, to = from): void {
  act(() => {
    ed.commands.setTextSelection({ from, to });
  });
}

function selectImage(ed: Editor, index = 0): void {
  const positions: number[] = [];
  ed.state.doc.descendants((node, p) => {
    if (node.type.name === 'image') positions.push(p);
  });
  const pos = positions[index];
  if (pos === undefined) throw new Error(`no image ${index}`);
  act(() => {
    ed.commands.setNodeSelection(pos);
  });
}

const bar = () => within(screen.getByRole('toolbar', { name: 'Quick formatting' }));
const spelling = () => bar().queryByRole('group', { name: 'Spelling: mispeled' });
const bold = () => bar().queryByRole('button', { name: 'Bold' });

describe('spelling fixes in the bar (DSK-202)', () => {
  it('take the formatting controls’ place while the caret is in an underlined word', async () => {
    const ed = await mount('<p>one mispeled word</p>');
    select(ed, posOf(ed, 'mispeled', 3));
    expect(spelling()).not.toBeNull();
    expect(bold()).toBeNull();

    select(ed, posOf(ed, 'word', 2));
    expect(spelling()).toBeNull();
    expect(bold()).not.toBeNull();
  });

  it('count a caret at either end of the word, not a selection that runs past it', async () => {
    const ed = await mount('<p>one mispeled word</p>');
    select(ed, posOf(ed, 'mispeled'));
    expect(spelling()).not.toBeNull();
    select(ed, posOf(ed, 'mispeled', 'mispeled'.length));
    expect(spelling()).not.toBeNull();
    select(ed, posOf(ed, 'mispeled', 2), posOf(ed, 'word', 2));
    expect(spelling()).toBeNull();
  });

  it('replace the word with a suggestion, and the formatting comes back', async () => {
    const ed = await mount('<p>one mispeled word</p>');
    select(ed, posOf(ed, 'mispeled', 1));
    fireEvent.click(bar().getByRole('button', { name: 'Replace with misspelled' }));
    expect(ed.getText()).toBe('one misspelled word');
    expect(spelling()).toBeNull();
    expect(bold()).not.toBeNull();
  });

  it('add the word to the dictionary', async () => {
    const addWord = vi.spyOn(useRichTextStore.getState(), 'addDictionaryWord').mockImplementation(() => {});
    const ed = await mount('<p>one mispeled word</p>');
    select(ed, posOf(ed, 'mispeled', 1));
    fireEvent.click(bar().getByRole('button', { name: 'Add to dictionary' }));
    expect(SpellcheckService.addToSession).toHaveBeenCalledWith('mispeled');
    expect(addWord).toHaveBeenCalledWith('mispeled');
    addWord.mockRestore();
  });

  it('hide from the word’s chip until the caret leaves the word', async () => {
    const ed = await mount('<p>one mispeled word</p>');
    select(ed, posOf(ed, 'mispeled', 1));
    fireEvent.click(bar().getByRole('button', { name: 'Hide suggestions for mispeled' }));
    expect(spelling()).toBeNull();
    expect(bold()).not.toBeNull();

    select(ed, posOf(ed, 'mispeled', 5));
    expect(spelling()).toBeNull();

    select(ed, posOf(ed, 'word', 1));
    select(ed, posOf(ed, 'mispeled', 2));
    expect(spelling()).not.toBeNull();
  });
});

describe('image actions in the bar (DSK-202)', () => {
  it('take the formatting controls’ place while an image is selected', async () => {
    const ed = await mount('<p>Before</p><img src="https://example.com/a.png"><p>After</p>');
    selectImage(ed);
    const image = within(bar().getByRole('group', { name: 'Image' }));
    expect(image.getByRole('button', { name: 'Replace image…' })).toBeTruthy();
    // Moving belongs to a gallery.
    expect(image.queryByRole('button', { name: 'Move image left' })).toBeNull();
    expect(bold()).toBeNull();

    fireEvent.click(image.getByRole('button', { name: 'Remove image' }));
    expect(ed.getHTML()).not.toContain('<img');
    expect(bold()).not.toBeNull();
  });

  it('move an image within its gallery', async () => {
    const ed = await mount(
      '<div data-gallery data-layout="row"><div class="gallery-items">' +
        '<img src="https://example.com/a.png"><img src="https://example.com/b.png"></div></div>',
    );
    selectImage(ed, 0);
    const image = within(bar().getByRole('group', { name: 'Image' }));
    expect((image.getByRole('button', { name: 'Move image left' }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(image.getByRole('button', { name: 'Move image right' }));
    const html = ed.getHTML();
    expect(html.indexOf('b.png')).toBeLessThan(html.indexOf('a.png'));
  });
});
