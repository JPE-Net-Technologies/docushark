/**
 * The prose context menu knows where you clicked (DSK-213): on a link it acts
 * on that link, wherever the caret was, and Insert offers what "/" inserts.
 * (A misspelled word's fixes are tested with the read-only chrome.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { sharedProseExtensions, sharedProseEditorProps } from './TiptapEditor';
import { DocumentEditorContextMenu, type DocumentEditorContextMenuProps } from './DocumentEditorContextMenu';
import { INSERT_COMMANDS } from '../tiptap/slashCommands';

let editor: Editor;

beforeEach(() => {
  const element = document.createElement('div');
  document.body.appendChild(element);
  editor = new Editor({
    element,
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: false }), ...sharedProseExtensions],
    editorProps: sharedProseEditorProps,
    content: '<p>See <a href="https://example.com">the site</a> now</p>',
  });
});

afterEach(() => {
  cleanup();
  editor.destroy();
});

const item = (label: string) =>
  screen.getByText(label, { selector: '.doc-editor-context-menu-label' }).closest('.doc-editor-context-menu-item')!;

// "See " runs from 1 to 5, the link "the site" from 5 to 13, " now" to 17.
const LINK = { href: 'https://example.com', pos: 5 };

function renderMenu(props: Partial<DocumentEditorContextMenuProps> = {}) {
  return render(
    <DocumentEditorContextMenu
      x={0}
      y={0}
      onClose={() => {}}
      editor={editor}
      onEditLink={() => {}}
      onOpenLink={() => {}}
      {...props}
    />,
  );
}

describe('prose context menu: where you clicked (DSK-213)', () => {
  it('offers Open, Edit and Remove on a link, and none of them elsewhere', () => {
    const { unmount } = renderMenu({ link: LINK });
    expect(item('Open link')).toBeTruthy();
    expect(item('Edit link…')).toBeTruthy();
    expect(item('Remove link')).toBeTruthy();
    unmount();

    renderMenu();
    expect(screen.queryByText('Open link')).toBeNull();
    expect(screen.queryByText('Remove link')).toBeNull();
  });

  it('Remove link removes the whole right-clicked link, with the caret elsewhere', () => {
    editor.commands.setTextSelection(16);
    const onClose = vi.fn();
    renderMenu({ link: LINK, onClose });
    fireEvent.click(item('Remove link'));
    expect(editor.getHTML()).not.toContain('<a');
    expect(editor.getText()).toBe('See the site now');
    expect(onClose).toHaveBeenCalled();
  });

  it('Edit link selects the right-clicked link, then opens the dialog', () => {
    editor.commands.setTextSelection(1);
    const onEditLink = vi.fn();
    renderMenu({ link: LINK, onEditLink });
    fireEvent.click(item('Edit link…'));
    expect(onEditLink).toHaveBeenCalled();
    const { from, to } = editor.state.selection;
    expect(editor.state.doc.textBetween(from, to)).toBe('the site');
  });

  it('Open link follows the right-clicked link', () => {
    const onOpenLink = vi.fn();
    renderMenu({ link: LINK, onOpenLink });
    fireEvent.click(item('Open link'));
    expect(onOpenLink).toHaveBeenCalledWith('https://example.com');
  });

  it('Insert lists what "/" inserts, and runs the one chosen', () => {
    editor.commands.setTextSelection(17);
    renderMenu();
    fireEvent.mouseEnter(item('Insert'));
    for (const command of INSERT_COMMANDS) expect(item(command.title)).toBeTruthy();
    fireEvent.click(item('Divider'));
    expect(editor.getHTML()).toContain('<hr');
  });
});
