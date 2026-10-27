/**
 * The editor's right-click menus on a phone (DSK-202).
 *
 * On Android a long-press fires `contextmenu`, and a long-press is the system's
 * selection gesture: the formatting menu and the spelling popover opened at the
 * finger, over the selection handles, and ran under the bar with the keyboard
 * up. The phone layout opens neither, and a long-press on an image selects it
 * in place of the browser's image menu. Each phone case has a desktop control,
 * so removing the gate fails a test.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, fireEvent, cleanup, screen, act } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import { NodeSelection } from '@tiptap/pm/state';

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

const phone = vi.hoisted(() => ({ active: false }));
vi.mock('./layout/useMobileAdaptation', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./layout/useMobileAdaptation')>()),
  readMobileActive: () => phone.active,
}));

import { extensions } from './TiptapEditor';
import { useProseEditorChrome } from './useProseEditorChrome';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';

let editor: Editor | null = null;

beforeEach(() => {
  phone.active = false;
  useUIPreferencesStore.setState((s) => ({
    appearancePrefs: { ...s.appearancePrefs, spellcheck: 'custom' as const },
  }));
});

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
});

function ChromeHarness({ ed }: { ed: Editor }) {
  const { onContextMenu, overlay } = useProseEditorChrome(ed);
  return (
    <div data-testid="prose-host" onContextMenu={onContextMenu}>
      {overlay}
    </div>
  );
}

/** A real editor inside the chrome's container, so events bubble as in the app. */
async function mount(content: string): Promise<Editor> {
  const element = document.createElement('div');
  const ed = new Editor({ element, extensions, content });
  editor = ed;
  render(<ChromeHarness ed={ed} />);
  screen.getByTestId('prose-host').appendChild(element);
  // The editor's create event, then the checker's first pass.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  return ed;
}

function inEditor(ed: Editor, selector: string): Element {
  const el = ed.view.dom.querySelector(selector);
  if (!el) throw new Error(`nothing matches ${selector}`);
  return el;
}

const formattingMenu = () => document.querySelector('.doc-editor-context-menu');
const spellingPopover = () => document.querySelector('.spellcheck-popover');

describe('long-press menus on a phone (DSK-202)', () => {
  it('opens no formatting menu over text, and leaves the system its own', async () => {
    const ed = await mount('<p>plain words here</p>');
    phone.active = true;
    const notCancelled = fireEvent.contextMenu(inEditor(ed, 'p'));
    expect(formattingMenu()).toBeNull();
    // Not cancelled: the system's selection and its copy-and-paste bar stay.
    expect(notCancelled).toBe(true);
  });

  it('opens the formatting menu on a desktop (control)', async () => {
    const ed = await mount('<p>plain words here</p>');
    fireEvent.contextMenu(inEditor(ed, 'p'));
    expect(formattingMenu()).not.toBeNull();
  });

  it('opens no spelling popover over an underlined word', async () => {
    const ed = await mount('<p>one mispeled word</p>');
    phone.active = true;
    fireEvent.contextMenu(inEditor(ed, '.spellcheck-error'));
    expect(spellingPopover()).toBeNull();
    expect(formattingMenu()).toBeNull();
  });

  it('opens the spelling popover on a desktop (control)', async () => {
    const ed = await mount('<p>one mispeled word</p>');
    fireEvent.contextMenu(inEditor(ed, '.spellcheck-error'));
    expect(spellingPopover()).not.toBeNull();
  });

  it("selects a long-pressed image in place of the browser's image menu", async () => {
    const ed = await mount('<p>Before</p><img src="https://example.com/a.png"><p>After</p>');
    phone.active = true;
    const notCancelled = fireEvent.contextMenu(inEditor(ed, '.resizable-image-container img'));
    expect(notCancelled).toBe(false);
    const sel = ed.state.selection;
    expect(sel instanceof NodeSelection ? sel.node.type.name : null).toBe('image');
    expect(formattingMenu()).toBeNull();
  });
});
