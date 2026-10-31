/**
 * The prose context menu's clipboard section (DSK-208). The menu replaces the
 * browser's, so before this right-clicking prose took Cut, Copy and Paste away.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { sharedProseExtensions, sharedProseEditorProps } from './TiptapEditor';
import { DocumentEditorContextMenu } from './DocumentEditorContextMenu';
import { formatCombo } from '../engine/keybindings';
import { useNotificationStore } from '../store/notificationStore';

let editor: Editor;
let clipboard: Map<string, string>;

beforeEach(() => {
  clipboard = new Map();
  useNotificationStore.setState({ notifications: [] });
  Object.defineProperty(document, 'execCommand', {
    configurable: true,
    value: vi.fn((command: string) => {
      if (command !== 'copy') return false;
      const event = new Event('copy', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => clipboard.set(type, value) } });
      document.dispatchEvent(event);
      return true;
    }),
  });
  vi.stubGlobal('ClipboardEvent', class extends Event { clipboardData = null; });
  const element = document.createElement('div');
  document.body.appendChild(element);
  editor = new Editor({
    element,
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: false }), ...sharedProseExtensions],
    editorProps: sharedProseEditorProps,
    content: '<p>Hello <strong>world</strong></p>',
  });
});

afterEach(() => {
  cleanup();
  editor.destroy();
  vi.unstubAllGlobals();
});

const item = (label: string) => screen.getByText(label, { selector: '.doc-editor-context-menu-label' }).closest('.doc-editor-context-menu-item')!;

describe('prose context menu: clipboard (DSK-208)', () => {
  it("offers Cut, Copy, Copy as, Paste and Paste without formatting, with the platform's shortcuts", () => {
    editor.commands.selectAll();
    render(<DocumentEditorContextMenu x={10} y={10} onClose={() => {}} editor={editor} />);
    expect(item('Cut').textContent).toContain(formatCombo('Mod+X'));
    expect(item('Copy').textContent).toContain(formatCombo('Mod+C'));
    expect(item('Copy as').classList.contains('has-submenu')).toBe(true);
    expect(item('Paste').textContent).toContain(formatCombo('Mod+V'));
    expect(item('Paste without formatting').textContent).toContain(formatCombo('Mod+Shift+V'));
  });

  it('disables Cut, Copy and Copy as without a selection', () => {
    editor.commands.setTextSelection(2);
    render(<DocumentEditorContextMenu x={10} y={10} onClose={() => {}} editor={editor} />);
    for (const label of ['Cut', 'Copy', 'Copy as']) expect(item(label).classList.contains('disabled')).toBe(true);
    fireEvent.click(item('Copy'));
    expect(clipboard.size).toBe(0);
  });

  it('copies the selection as Markdown from the Copy as submenu, and closes', () => {
    editor.commands.selectAll();
    const onClose = vi.fn();
    render(<DocumentEditorContextMenu x={10} y={10} onClose={onClose} editor={editor} />);
    fireEvent.mouseEnter(item('Copy as'));
    fireEvent.click(item('Markdown'));
    expect(clipboard.get('text/plain')).toBe('Hello **world**');
    expect(onClose).toHaveBeenCalled();
  });

  it('tells the writer to use the keyboard when the browser refuses a menu paste', async () => {
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { read: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')), readText: vi.fn() },
    });
    render(<DocumentEditorContextMenu x={10} y={10} onClose={() => {}} editor={editor} />);
    fireEvent.click(item('Paste'));
    await vi.waitFor(() => expect(useNotificationStore.getState().notifications).toHaveLength(1));
    expect(useNotificationStore.getState().notifications[0]!.message).toContain(formatCombo('Mod+V'));
  });
});
