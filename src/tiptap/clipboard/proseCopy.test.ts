/**
 * Copy formats and menu paste for prose (DSK-208).
 *
 * `execCommand('copy')` is stubbed to fire a copy event the way a browser
 * does; the async clipboard and blob storage are stubbed too.
 */
import { describe, it, expect, vi, beforeEach, afterEach, type Mock } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { sharedProseExtensions, sharedProseEditorProps } from '../../ui/TiptapEditor';
import { copySelection, pasteFromClipboard } from './proseCopy';

vi.mock('../../storage/BlobStorage', () => ({
  blobStorage: {
    loadBlob: vi.fn(async () => new Blob([new Uint8Array([137, 80, 78, 71])], { type: 'image/png' })),
    saveBlob: vi.fn(async () => 'saved'),
  },
}));

let editor: Editor;
let clipboard: Map<string, string>;
let execCommand: Mock<[string], boolean>;
const writes: Array<Record<string, Blob | Promise<Blob>>> = [];

class FakeClipboardItem {
  constructor(readonly items: Record<string, Blob | Promise<Blob>>) {}
}

/** jsdom's Blob has no text(): read it the old way, and give fakes a text() like a browser's. */
function blobText(blob: Blob): Promise<string> {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.readAsText(blob);
  });
}

function textBlob(text: string): Blob {
  return Object.assign(new Blob([text]), { text: async () => text });
}

function setClipboard(api: Partial<Clipboard>): void {
  Object.defineProperty(navigator, 'clipboard', { value: api, configurable: true });
}

beforeEach(() => {
  clipboard = new Map();
  writes.length = 0;
  execCommand = vi.fn((command: string) => {
    if (command !== 'copy') return false;
    const event = new Event('copy', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { setData: (type: string, value: string) => clipboard.set(type, value) } });
    document.dispatchEvent(event);
    return true;
  });
  Object.defineProperty(document, 'execCommand', { value: execCommand, configurable: true });
  vi.stubGlobal('ClipboardEvent', class extends Event { clipboardData = null; });
  vi.stubGlobal('ClipboardItem', FakeClipboardItem);
  setClipboard({ write: vi.fn(async (items: ClipboardItem[]) => { writes.push((items[0] as unknown as FakeClipboardItem).items); }) });

  const element = document.createElement('div');
  document.body.appendChild(element);
  editor = new Editor({
    element,
    extensions: [StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: false }), ...sharedProseExtensions],
    editorProps: sharedProseEditorProps,
    content: '<p>Hello <strong>world</strong></p><ul><li><p>Item</p></li></ul>',
  });
  editor.commands.selectAll();
});

afterEach(() => {
  editor.destroy();
  vi.unstubAllGlobals();
});

describe('copy as (DSK-208)', () => {
  it('copies Markdown', () => {
    expect(copySelection(editor, 'markdown')).toBe(true);
    expect(clipboard.get('text/plain')).toBe('Hello **world**\n\n- Item');
    expect(clipboard.has('text/html')).toBe(false);
  });

  it('copies plain text', () => {
    copySelection(editor, 'plain');
    expect(clipboard.get('text/plain')).toBe('Hello world\n\n- Item');
  });

  it("copies rich text as the editor's own HTML, and plain text alongside", () => {
    copySelection(editor, 'rich');
    expect(clipboard.get('text/html')).toMatch(/data-pm-slice/);
    expect(clipboard.get('text/html')).toContain('<strong>world</strong>');
    expect(clipboard.get('text/plain')).toContain('Hello world');
  });

  it('cuts: copies, then deletes the selection', () => {
    copySelection(editor, 'rich', { cut: true });
    expect(clipboard.get('text/html')).toContain('Hello');
    expect(editor.getText().trim()).toBe('');
  });

  it('writes nothing for an empty selection', () => {
    editor.commands.setTextSelection(1);
    expect(copySelection(editor, 'markdown')).toBe(false);
    expect(execCommand).not.toHaveBeenCalled();
  });

  it('follows a rich copy holding stored images with one whose images other apps can load', async () => {
    editor.commands.setContent('<p>Chart</p><img src="blob://abc" alt="Chart">');
    editor.commands.selectAll();
    copySelection(editor, 'rich');
    expect(clipboard.get('text/html')).toContain('blob://abc');
    expect(writes).toHaveLength(1);
    const html = await blobText((await writes[0]!['text/html'])!);
    expect(html).toContain('src="data:image/png;base64,');
    expect(html).not.toContain('blob://');
  });

  it('does not rewrite the clipboard when there are no stored images', () => {
    copySelection(editor, 'rich');
    expect(writes).toHaveLength(0);
  });
});

describe('paste from the menu (DSK-208)', () => {
  it('reports blocked when the browser refuses to read the clipboard', async () => {
    setClipboard({ read: vi.fn().mockRejectedValue(new DOMException('denied', 'NotAllowedError')), readText: vi.fn() });
    expect(await pasteFromClipboard(editor)).toBe('blocked');
  });

  it('pastes plain text without formatting', async () => {
    setClipboard({ readText: vi.fn().mockResolvedValue('**not bold**') });
    expect(await pasteFromClipboard(editor, { plain: true })).toBe('pasted');
    expect(editor.getHTML()).toContain('**not bold**');
    expect(editor.getHTML()).not.toContain('<strong>');
  });

  it('pastes HTML through the same pipeline as Ctrl+V', async () => {
    const item = {
      types: ['text/html', 'text/plain'],
      getType: vi.fn(async (type: string) => textBlob(type === 'text/html' ? '<p><span style="color:black">Pasted</span></p>' : 'Pasted')),
    };
    setClipboard({ read: vi.fn().mockResolvedValue([item]) });
    expect(await pasteFromClipboard(editor)).toBe('pasted');
    expect(editor.getText()).toContain('Pasted');
    expect(editor.getHTML()).not.toContain('color: black');
  });
});
