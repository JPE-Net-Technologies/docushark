/**
 * Pasting into prose, end to end through the shared editor props (DSK-208).
 *
 * A headless editor with the real extensions and `sharedProseEditorProps`;
 * only the image store and the network are stubbed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { DOMParser as PMDOMParser, Slice } from '@tiptap/pm/model';
import { sharedProseExtensions, sharedProseEditorProps } from '../../ui/TiptapEditor';
import { useNotificationStore } from '../../store/notificationStore';
import { handleProseImageDrop, handleProsePaste } from './prosePaste';

const uploads: File[] = [];
vi.mock('../../ui/proseImageUpload', () => ({
  IMAGE_FILE_ACCEPT: 'image/png',
  uploadProseImage: vi.fn(async (file: File) => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    uploads.push(file);
    return { src: `blob://stored-${uploads.length}`, alt: file.name, wasResized: false, originalSize: file.size, processedSize: file.size };
  }),
}));

const PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const realFetch = globalThis.fetch;

let editor: Editor;

beforeEach(() => {
  uploads.length = 0;
  useNotificationStore.setState({ notifications: [] });
  // jsdom has no ClipboardEvent; pasteHTML constructs one when given no event.
  vi.stubGlobal('ClipboardEvent', class extends Event { clipboardData = null; });
  vi.stubGlobal('fetch', vi.fn((url: string, init?: RequestInit) =>
    String(url).startsWith('data:') ? realFetch(url, init) : Promise.reject(new TypeError('Failed to fetch')),
  ));
  const element = document.createElement('div');
  document.body.appendChild(element);
  editor = new Editor({
    element,
    // A 1 ms undo grouping window (prosemirror-history reads 0 as its 500 ms
    // default) and uploads that take 20 ms: an image swap recorded in the
    // history can't hide inside the paste's undo step.
    extensions: [
      StarterKit.configure({ heading: { levels: [1, 2, 3, 4, 5, 6] }, codeBlock: false, history: { newGroupDelay: 1 } }),
      ...sharedProseExtensions,
    ],
    editorProps: sharedProseEditorProps,
    content: '<p></p>',
  });
});

afterEach(() => {
  editor.destroy();
  vi.unstubAllGlobals();
});

const images = () => {
  const found: string[] = [];
  editor.state.doc.descendants((node) => {
    if (node.type.name === 'image') found.push(String(node.attrs['src']));
    return true;
  });
  return found;
};
const toasts = () => useNotificationStore.getState().notifications.map((n) => n.message);
const parseSlice = (html: string) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return PMDOMParser.fromSchema(editor.schema).parseSlice(div);
};

describe('pasting into prose (DSK-208)', () => {
  it('lands a Word paste as lists with clean colours, then stores its image; one Undo removes it all', async () => {
    editor.view.pasteHTML(`<html xmlns:o="urn:schemas-microsoft-com:office:office"><body>
<h1><span style='color:windowtext'>Report</span></h1>
<p class=MsoNormal><span style='color:black'>plain</span> <span style='color:#C00000'>red</span></p>
<p style='mso-list:l0 level1 lfo1'><![if !supportLists]><span>·<span>&nbsp;&nbsp;</span></span><![endif]>One</p>
<p style='mso-list:l0 level2 lfo1'><![if !supportLists]><span>o<span>&nbsp;&nbsp;</span></span><![endif]>Nested</p>
<p class=MsoNormal><img src="${PNG}" alt="Chart"><o:p></o:p></p>
</body></html>`);

    // Held until its image is stored: a placeholder, and no `data:` image in the document, ever.
    expect(editor.view.dom.querySelector('.prose-paste-placeholder')).not.toBeNull();
    expect(images()).toEqual([]);

    await vi.waitFor(() => expect(images()).toEqual(['blob://stored-1']));
    const json = JSON.stringify(editor.getJSON());
    expect(editor.state.doc.firstChild?.type.name).toBe('heading');
    expect(json).toContain('"bulletList"');
    expect(editor.getHTML()).toMatch(/<li><p[^>]*>One<\/p><ul><li><p[^>]*>Nested<\/p><\/li><\/ul><\/li>/);
    expect(json).not.toMatch(/windowtext|"color":"black"/);
    expect(json).toMatch(/"color":"(#C00000|rgb\(192, 0, 0\))"/i);
    expect(editor.view.dom.querySelector('.prose-paste-placeholder')).toBeNull();
    expect(toasts()).toEqual([]);

    editor.commands.undo();
    expect(editor.getText().trim()).toBe('');
    expect(images()).toEqual([]);
  });

  it('keeps a remote image that its website won’t share, and says so', async () => {
    editor.view.pasteHTML('<p>Text</p><img src="https://example.com/a.png" alt="a">');
    await vi.waitFor(() => expect(images()).toEqual(['https://example.com/a.png']));
    expect(toasts()).toHaveLength(1);
    expect(toasts()[0]).toMatch(/still loads from its website/);
  });

  it('drops an image the browser can’t read, and says so', async () => {
    editor.view.pasteHTML('<p>Word text</p><img src="file:///C:/Temp/clip_image001.png">');
    await vi.waitFor(() => expect(toasts()).toHaveLength(1));
    expect(images()).toEqual([]);
    expect(toasts()[0]).toMatch(/couldn’t be pasted because the browser can’t read it/);
  });

  it('inserts a pasted screenshot at the caret, behind a placeholder while it is stored', async () => {
    const file = new File([new Uint8Array([1, 2, 3])], 'shot.png', { type: 'image/png' });
    const event = { clipboardData: { getData: () => '', items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], files: [file] } };
    expect(handleProsePaste(editor.view, event as unknown as ClipboardEvent, Slice.empty)).toBe(true);
    expect(editor.view.dom.querySelector('.prose-paste-placeholder')).not.toBeNull();

    await vi.waitFor(() => expect(images()).toEqual(['blob://stored-1']));
    expect(uploads[0]).toBe(file);
    expect(editor.view.dom.querySelector('.prose-paste-placeholder')).toBeNull();
  });

  it('uses the clipboard’s file for "Copy image", not the website’s copy', async () => {
    const file = new File([new Uint8Array([1])], 'copied.png', { type: 'image/png' });
    const fetchMock = vi.mocked(globalThis.fetch);
    // What ProseMirror does with such a paste: tidy, parse, then handlePaste with the slice.
    const view = editor.view;
    const slice = parseSlice(sharedProseEditorProps.transformPastedHTML('<img src="https://example.com/b.png">', view));
    const event = { clipboardData: { getData: () => '', items: [{ kind: 'file', type: 'image/png', getAsFile: () => file }], files: [file] } };
    expect(handleProsePaste(view, event as unknown as ClipboardEvent, slice)).toBe(true);

    await vi.waitFor(() => expect(images()).toEqual(['blob://stored-1']));
    expect(fetchMock).not.toHaveBeenCalled();
    expect(toasts()).toEqual([]);
  });

  it('pastes Ctrl+Shift+V as the text exactly as copied, not as formatting', () => {
    editor.view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'V', ctrlKey: true, shiftKey: true, bubbles: true }));
    const event = { clipboardData: { getData: (type: string) => (type === 'text/plain' ? '**word**\nnext' : ''), items: [], files: [] } };
    expect(handleProsePaste(editor.view, event as unknown as ClipboardEvent, Slice.empty)).toBe(true);
    expect(editor.getText()).toContain('**word**');
    expect(editor.getHTML()).not.toContain('<strong>');
    expect(editor.state.doc.childCount).toBe(2);
  });

  it('stores the images of content dropped from outside, at the drop point; a move inside is left alone', async () => {
    editor.commands.setContent('<p>Before</p>');
    editor.view.posAtCoords = () => ({ pos: editor.state.doc.content.size, inside: -1 });
    const drop = { clientX: 0, clientY: 0 } as DragEvent;
    const slice = parseSlice(`<img src="${PNG}" alt="dropped">`);
    expect(handleProseImageDrop(editor.view, drop, slice, true)).toBe(false);
    expect(handleProseImageDrop(editor.view, drop, slice, false)).toBe(true);
    await vi.waitFor(() => expect(images()).toEqual(['blob://stored-1']));
    expect(editor.getText()).toContain('Before');
  });

  it('does no image work for a text-only paste', async () => {
    editor.view.pasteHTML('<p>Just <strong>words</strong></p>');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(uploads).toHaveLength(0);
    expect(vi.mocked(globalThis.fetch)).not.toHaveBeenCalled();
    expect(editor.getHTML()).toContain('<strong>words</strong>');
  });
});
