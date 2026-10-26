/**
 * The phone's prose bar (DSK-197), on a real editor.
 *
 * A phone has no Mod+Z and no Tab key, so prose undo and list nesting were
 * unreachable on one; the bar now carries them, with a text-style menu, more
 * marks and link, and keeps the caret (and the keyboard) in the editor when a
 * button is pressed.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, act, within } from '@testing-library/react';
import { Editor } from '@tiptap/core';

vi.mock('../../tiptap/slashUi', () => ({ registerSlashUiHandler: () => () => {} }));

import { extensions } from '../TiptapEditor';
import { TiptapEditorProvider } from '../TiptapEditorContext';
import { MobileProseToolbar } from './MobileProseToolbar';

let editor: Editor | null = null;

function mount(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const ed = new Editor({ element, extensions, content });
  editor = ed;
  render(
    <TiptapEditorProvider value={ed}>
      <MobileProseToolbar />
    </TiptapEditorProvider>,
  );
  return ed;
}

function caretIn(ed: Editor, text: string): void {
  let pos = -1;
  ed.state.doc.descendants((node, p) => {
    if (node.isText && node.text === text) pos = p + 1;
  });
  if (pos < 0) throw new Error(`no text ${text}`);
  act(() => {
    ed.commands.setTextSelection(pos);
  });
}

const bar = () => within(screen.getByRole('toolbar', { name: 'Quick formatting' }));

/** The document's HTML without the editor's block ids, so structure is what's compared. */
const html = (ed: Editor) => ed.getHTML().replace(/ id="[^"]*"/g, '');

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
});

describe('MobileProseToolbar (DSK-197)', () => {
  it('undoes and redoes, enabled only when there is something to undo or redo', () => {
    const ed = mount('<p>Hello</p>');
    expect((bar().getByRole('button', { name: 'Undo' }) as HTMLButtonElement).disabled).toBe(true);

    act(() => {
      ed.chain().focus('end').insertContent(' world').run();
    });
    expect(ed.getText()).toBe('Hello world');

    fireEvent.click(bar().getByRole('button', { name: 'Undo' }));
    expect(ed.getText()).toBe('Hello');
    expect((bar().getByRole('button', { name: 'Redo' }) as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(bar().getByRole('button', { name: 'Redo' }));
    expect(ed.getText()).toBe('Hello world');
  });

  it('offers indent and outdent only while the caret is in a list', () => {
    const ed = mount('<ul><li><p>One</p></li><li><p>Two</p></li></ul><p>After</p>');
    caretIn(ed, 'Two');

    fireEvent.click(bar().getByRole('button', { name: 'Indent' }));
    expect(html(ed)).toMatch(/<li><p>One<\/p><ul><li><p>Two<\/p><\/li><\/ul><\/li>/);

    fireEvent.click(bar().getByRole('button', { name: 'Outdent' }));
    expect(html(ed)).toMatch(/<li><p>One<\/p><\/li><li><p>Two<\/p><\/li>/);

    caretIn(ed, 'After');
    expect(bar().queryByRole('button', { name: 'Indent' })).toBeNull();
  });

  it('names the current text style and changes it from the menu', () => {
    const ed = mount('<h2>Title</h2>');
    caretIn(ed, 'Title');

    const trigger = bar().getByRole('button', { name: 'Text style: Heading 2' });
    expect(trigger.textContent).toContain('H2');

    fireEvent.click(trigger);
    fireEvent.click(screen.getByRole('menuitem', { name: 'Body text' }));
    expect(html(ed)).toBe('<p>Title</p>');

    fireEvent.click(bar().getByRole('button', { name: 'Text style: Body text' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Quote' }));
    expect(ed.isActive('blockquote')).toBe(true);

    // Leaving a quote for a heading unwraps it first.
    fireEvent.click(bar().getByRole('button', { name: 'Text style: Quote' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Heading 1' }));
    expect(ed.isActive('blockquote')).toBe(false);
    expect(ed.isActive('heading', { level: 1 })).toBe(true);
  });

  it('keeps the caret in the editor when a bar button is pressed', () => {
    mount('<p>Hello</p>');
    // `false`: the press's default (moving focus to the button) was cancelled.
    expect(fireEvent.mouseDown(bar().getByRole('button', { name: 'Bold' }))).toBe(false);
    expect(fireEvent.mouseDown(screen.getByRole('button', { name: 'More formatting' }))).toBe(false);
  });

  it('keeps only undo and redo in the bar while Format is open', () => {
    mount('<p>Hello</p>');
    fireEvent.click(screen.getByRole('button', { name: 'More formatting' }));

    expect(bar().getByRole('button', { name: 'Undo' })).toBeTruthy();
    expect(bar().queryByRole('button', { name: 'Bold' })).toBeNull();
    expect(screen.getByRole('region', { name: 'Formatting' })).toBeTruthy();
  });
});
