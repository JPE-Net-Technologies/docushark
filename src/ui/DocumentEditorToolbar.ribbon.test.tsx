/**
 * The ribbon's row (DSK-200) and its contextual tabs (DSK-27): undo and redo
 * first; Table and Image only while the selection is in their context, never
 * chosen for you; and the upload commands working whichever tab shows.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';

const h = vi.hoisted(() => ({
  inTable: false,
  image: null as null | { inGallery: boolean; canLeft: boolean; canRight: boolean },
  canUndo: true,
  canRedo: false,
  undo: vi.fn(),
  redo: vi.fn(),
  removeSelectedImage: vi.fn(),
  moveGalleryImage: vi.fn(),
  listeners: new Map<string, () => void>(),
}));

vi.mock('../store/documentRegistry', () => ({ useActiveDocReadOnly: () => false }));
vi.mock('./TiptapEditorContext', () => ({
  useTiptapEditor: () => ({
    isActive: (name: unknown) => name === 'table' && h.inTable,
    on: (event: string, handler: () => void) => h.listeners.set(event, handler),
    off: vi.fn(),
    can: () => ({ chain: () => ({ focus: () => ({ run: () => true }) }) }),
    getAttributes: () => ({}),
    state: { selection: {} },
    commands: { removeSelectedImage: h.removeSelectedImage, moveGalleryImage: h.moveGalleryImage },
  }),
}));
vi.mock('./proseImageActions', () => ({
  selectedImage: () => h.image,
  replaceSelectedImageWithFile: vi.fn(),
}));
vi.mock('./editorCommands', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./editorCommands')>()),
  undo: h.undo,
  redo: h.redo,
  canUndo: () => h.canUndo,
  canRedo: () => h.canRedo,
}));

import { DocumentEditorToolbar } from './DocumentEditorToolbar';
import { SLASH_COMMANDS } from '../tiptap/slashCommands';

/** The editor changed: the ribbon re-reads it on each transaction. */
const editorChanged = () => act(() => h.listeners.get('transaction')?.());
const tab = (name: string) => screen.queryByRole('tab', { name });
const selected = () => screen.getAllByRole('tab').find((t) => t.getAttribute('aria-selected') === 'true')?.textContent;

beforeEach(() => {
  h.inTable = false;
  h.image = null;
  h.canUndo = true;
  h.canRedo = false;
  h.listeners.clear();
  vi.clearAllMocks();
});

afterEach(cleanup);

describe('the ribbon (DSK-200, DSK-27)', () => {
  it('starts with undo and redo, each enabled only when it can run', () => {
    render(<DocumentEditorToolbar />);
    const undo = screen.getByRole<HTMLButtonElement>('button', { name: 'Undo' });
    const redo = screen.getByRole<HTMLButtonElement>('button', { name: 'Redo' });
    expect(undo.disabled).toBe(false);
    expect(redo.disabled).toBe(true);
    fireEvent.click(undo);
    expect(h.undo).toHaveBeenCalledTimes(1);

    h.canRedo = true;
    editorChanged();
    fireEvent.click(redo);
    expect(h.redo).toHaveBeenCalledTimes(1);
  });

  it('shows the Table tab only in a table, without switching to it', () => {
    render(<DocumentEditorToolbar />);
    expect(tab('Table')).toBeNull();
    h.inTable = true;
    editorChanged();
    expect(tab('Table')).not.toBeNull();
    expect(selected()).toBe('Home');
  });

  it('goes back to the tab you were on when the selection leaves, and stays there', () => {
    render(<DocumentEditorToolbar />);
    fireEvent.click(tab('Insert')!);
    h.inTable = true;
    editorChanged();
    fireEvent.click(tab('Table')!);
    expect(selected()).toBe('Table');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Delete table' }).disabled).toBe(false);

    h.inTable = false;
    editorChanged();
    expect(tab('Table')).toBeNull();
    expect(selected()).toBe('Insert');

    // Back in a table later: its tab returns, but you stay where you were.
    h.inTable = true;
    editorChanged();
    expect(tab('Table')).not.toBeNull();
    expect(selected()).toBe('Insert');
  });

  it('offers the image actions while an image is selected', () => {
    h.image = { inGallery: true, canLeft: false, canRight: true };
    render(<DocumentEditorToolbar />);
    expect(selected()).toBe('Home');
    fireEvent.click(tab('Image')!);
    screen.getByRole('button', { name: 'Replace image' });
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Move image left' }).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Move image right' }));
    expect(h.moveGalleryImage).toHaveBeenCalledWith(1);
    fireEvent.click(screen.getByRole('button', { name: 'Remove image' }));
    expect(h.removeSelectedImage).toHaveBeenCalledTimes(1);
  });

  it('keeps /image, /file and /gallery working while another tab shows', () => {
    const opened: string[] = [];
    const click = vi.spyOn(HTMLInputElement.prototype, 'click').mockImplementation(function (this: HTMLInputElement) {
      if (this.type === 'file') opened.push(this.accept || 'any');
    });
    render(<DocumentEditorToolbar />);
    expect(selected()).toBe('Home');
    for (const id of ['image', 'file', 'gallery']) SLASH_COMMANDS.find((command) => command.id === id)!.run(undefined as never);
    expect(opened).toHaveLength(3);
    click.mockRestore();
  });

  it('ends the row with Find', () => {
    render(<DocumentEditorToolbar />);
    const buttons = within(screen.getByRole('tablist').parentElement!).getAllByRole('button');
    expect(buttons[buttons.length - 1]!.getAttribute('aria-label')).toBe('Find and replace');
  });
});
