/**
 * The "/" commands that open a picker work without the desktop ribbon, which a
 * phone doesn't mount (DSK-219): the host alone answers them, and stops where
 * the text can't be edited.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor, within } from '@testing-library/react';
import { Editor } from '@tiptap/core';

const h = vi.hoisted(() => ({
  readOnly: false,
  mirror: null as null | object,
  upload: vi.fn(),
}));

vi.mock('../store/documentRegistry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/documentRegistry')>()),
  useActiveDocReadOnly: () => h.readOnly,
}));
vi.mock('../store/richTextPagesStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../store/richTextPagesStore')>()),
  useActivePageMirror: () => h.mirror,
}));
vi.mock('./proseImageUpload', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./proseImageUpload')>()),
  uploadProseImage: h.upload,
}));

import { extensions } from './TiptapEditor';
import { DocumentEditorToolbar } from './DocumentEditorToolbar';
import { IMAGE_FILE_ACCEPT } from './proseImageUpload';
import { SlashUiHost } from './SlashUiHost';
import { TiptapEditorProvider } from './TiptapEditorContext';
import { SLASH_COMMANDS, runSlashUi } from '../tiptap/slashCommands';
import { useReferenceStore } from '../store/referenceStore';

let editor: Editor;
let chosen: HTMLInputElement[];

/** The panel, with the ribbon only where the layout has one. */
function Panel({ ribbon = false }: { ribbon?: boolean }) {
  return (
    <TiptapEditorProvider value={editor}>
      <SlashUiHost />
      {ribbon && <DocumentEditorToolbar />}
    </TiptapEditorProvider>
  );
}

const slash = (id: string) => act(() => SLASH_COMMANDS.find((command) => command.id === id)!.run(editor));
const dialog = (name: string) => screen.queryByRole('dialog', { name });
const closeDialog = (name: string) => fireEvent.click(within(dialog(name)!).getByRole('button', { name: 'Close' }));

beforeEach(() => {
  h.readOnly = false;
  h.mirror = null;
  h.upload.mockReset();
  useReferenceStore.getState().clear();
  chosen = [];
  vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
    if (this.type === 'file') chosen.push(this);
  });
  const element = document.createElement('div');
  document.body.appendChild(element);
  editor = new Editor({ element, extensions, content: '<p></p>' });
});

afterEach(() => {
  cleanup();
  editor.destroy();
  vi.restoreAllMocks();
});

describe('SlashUiHost, with no ribbon mounted', () => {
  it('opens the chooser for /image, /file and /gallery', () => {
    render(<Panel />);
    for (const id of ['image', 'file', 'gallery']) slash(id);
    expect(chosen.map((input) => [input.accept, input.multiple])).toEqual([
      [IMAGE_FILE_ACCEPT, false],
      ['', false],
      [expect.stringContaining('image/png'), true],
    ]);
  });

  it('inserts what the chooser picked into the text', async () => {
    h.upload.mockResolvedValue({ src: 'blob://abc', alt: 'a.png', wasResized: false, originalSize: 1, processedSize: 1 });
    render(<Panel />);
    slash('image');
    fireEvent.change(chosen[0]!, { target: { files: [new File(['x'], 'a.png', { type: 'image/png' })] } });
    await waitFor(() => expect(editor.getJSON().content?.some((node) => node.attrs?.['src'] === 'blob://abc')).toBe(true));
  });

  it('keeps the upload buttons it holds for their inputs out of sight', () => {
    render(<Panel />);
    for (const name of ['Upload image', 'Attach file', 'Insert image gallery']) {
      expect(screen.queryByRole('button', { name })).toBeNull();
    }
  });

  it.each([
    ['citation', 'Insert citation'],
    ['field', 'Manage fields'],
  ])('opens and closes the dialog for /%s', (id, name) => {
    render(<Panel />);
    expect(dialog(name)).toBeNull();
    slash(id);
    expect(dialog(name)).not.toBeNull();
    closeDialog(name);
    expect(dialog(name)).toBeNull();
  });

  it('opens the reference manager when asked, and closes it', () => {
    render(<Panel />);
    act(() => runSlashUi('references'));
    expect(dialog('Manage references')).not.toBeNull();
    closeDialog('Manage references');
    expect(dialog('Manage references')).toBeNull();
  });

  it("goes from the citation picker's empty state to the reference manager", () => {
    render(<Panel />);
    slash('citation');
    fireEvent.click(screen.getByRole('button', { name: 'Add references…' }));
    expect(dialog('Insert citation')).toBeNull();
    expect(dialog('Manage references')).not.toBeNull();
  });
});

describe('SlashUiHost, where the text cannot be edited', () => {
  const answersNothing = () => {
    for (const id of ['image', 'file', 'gallery', 'citation', 'field']) slash(id);
    act(() => runSlashUi('references'));
    expect(chosen).toHaveLength(0);
    expect(screen.queryByRole('dialog')).toBeNull();
  };

  it('answers nothing on a read-only document', () => {
    h.readOnly = true;
    render(<Panel />);
    answersNothing();
  });

  it('answers nothing on a mirror page', () => {
    h.mirror = {};
    render(<Panel />);
    answersNothing();
  });

  it('closes an open picker for good when the document turns read-only', () => {
    const { rerender } = render(<Panel />);
    slash('citation');
    expect(dialog('Insert citation')).not.toBeNull();

    h.readOnly = true;
    rerender(<Panel />);
    expect(dialog('Insert citation')).toBeNull();

    // Editable again: it stays closed until asked for, and "/" answers again.
    h.readOnly = false;
    rerender(<Panel />);
    expect(dialog('Insert citation')).toBeNull();
    slash('citation');
    expect(dialog('Insert citation')).not.toBeNull();
  });
});

describe('SlashUiHost beside the ribbon', () => {
  it('keeps answering "/" after the ribbon comes and goes, as the phone\'s Format panel does', () => {
    const { rerender } = render(<Panel />);
    rerender(<Panel ribbon />);
    // Its upload buttons exist only while Insert shows.
    fireEvent.click(screen.getByRole('tab', { name: 'Insert' }));
    rerender(<Panel />);
    for (const id of ['image', 'file', 'gallery']) slash(id);
    expect(chosen).toHaveLength(3);
  });

  it('keeps answering "/" after leaving the Insert tab', () => {
    render(<Panel ribbon />);
    fireEvent.click(screen.getByRole('tab', { name: 'Insert' }));
    fireEvent.click(screen.getByRole('tab', { name: 'Home' }));
    for (const id of ['image', 'file', 'gallery']) slash(id);
    expect(chosen).toHaveLength(3);
  });

  it('answers the ribbon\'s Insert controls that open its dialogs', () => {
    render(<Panel ribbon />);
    fireEvent.click(screen.getByRole('tab', { name: 'Insert' }));
    for (const [button, name] of [
      ['Insert citation', 'Insert citation'],
      ['Insert field', 'Manage fields'],
      ['Manage references', 'Manage references'],
    ] as const) {
      fireEvent.click(screen.getByRole('button', { name: button }));
      expect(dialog(name)).not.toBeNull();
      closeDialog(name);
    }
  });

  it('leaves the ribbon\'s own upload buttons their own inputs', () => {
    render(<Panel ribbon />);
    fireEvent.click(screen.getByRole('tab', { name: 'Insert' }));
    fireEvent.click(screen.getByRole('button', { name: 'Upload image' }));
    expect(chosen).toHaveLength(1);
    expect(chosen[0]!.closest('[hidden]')).toBeNull();
    // And "/" still goes to the hidden one.
    slash('image');
    expect(chosen).toHaveLength(2);
    expect(chosen[1]!.closest('[hidden]')).not.toBeNull();
  });
});
