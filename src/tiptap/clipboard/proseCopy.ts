/**
 * Copy and paste from the prose context menu, and images that travel with a
 * copy (DSK-208).
 *
 * The menu's "Copy as" writes the selection as rich text (the editor's own
 * HTML, as Ctrl+C does), plain text or Markdown. Writing goes through a
 * one-shot `copy` listener and `execCommand('copy')`, which every shell
 * supports, including the desktop app's WebKitGTK; the listener stops the
 * event so ProseMirror's own copy handler doesn't overwrite it.
 *
 * Images are stored as `blob://` references, which nothing outside DocuShark
 * can load. Where the async clipboard takes a `ClipboardItem`, a rich copy
 * holding images is followed by a second write whose HTML has them inlined as
 * `data:` URIs, so they arrive in Word or a mail. It starts inside the same
 * gesture and resolves a moment later; if it fails, the first copy stands.
 * Ctrl+C and Ctrl+X get the same follow-up (see `upgradeCopiedImages`).
 *
 * Paste from a menu has to read the clipboard, which a browser may refuse; the
 * caller then tells the writer to use the keyboard. What is read goes through
 * `pasteHTML`/`pasteText`, the same path as Ctrl+V.
 */
import type { Editor } from '@tiptap/core';
import type { Slice } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { blobStorage } from '../../storage/BlobStorage';
import { proseToMarkdown, proseToPlainText } from './proseMarkdown';
import { insertImageFiles } from './pasteImages';
import { pastePlainText } from './prosePaste';

export type CopyFormat = 'rich' | 'plain' | 'markdown';

/** Copy the selection in a format; with `cut`, then delete it. Returns whether anything was written. */
export function copySelection(editor: Editor, format: CopyFormat, { cut = false } = {}): boolean {
  const { state, view } = editor;
  if (state.selection.empty) return false;

  let written: boolean;
  if (format === 'rich') {
    const { dom, text } = view.serializeForClipboard(state.selection.content());
    written = writeClipboard({ 'text/html': dom.innerHTML, 'text/plain': text });
    if (written) upgradeImages(dom.innerHTML, text);
  } else {
    const { from, to } = state.selection;
    const doc = state.doc.cut(from, to);
    written = writeClipboard({ 'text/plain': format === 'markdown' ? proseToMarkdown(doc) : proseToPlainText(doc) });
  }

  if (written && cut && editor.isEditable) editor.chain().focus().deleteSelection().run();
  return written;
}

/**
 * Ctrl+C / Ctrl+X: when the selection holds stored images, follow the editor's
 * own copy with one whose images other apps can load. Called from the `copy`
 * and `cut` DOM events, before ProseMirror writes (and, for a cut, deletes).
 */
export function upgradeCopiedImages(view: EditorView): void {
  const slice = view.state.selection.content();
  if (!hasStoredImages(slice)) return;
  const { dom, text } = view.serializeForClipboard(slice);
  upgradeImages(dom.innerHTML, text);
}

export type PasteOutcome = 'pasted' | 'empty' | 'blocked';

/**
 * Paste from the clipboard at the selection: with formatting (HTML, or an
 * image) or as plain text. `blocked` when the browser won't let a menu read
 * the clipboard.
 */
export async function pasteFromClipboard(editor: Editor, { plain = false } = {}): Promise<PasteOutcome> {
  const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
  try {
    if (plain || !clipboard?.read) {
      if (!clipboard?.readText) return 'blocked';
      const text = await clipboard.readText();
      if (!text) return 'empty';
      editor.commands.focus();
      if (plain) pastePlainText(editor.view, text);
      else editor.view.pasteText(text);
      return 'pasted';
    }

    for (const item of await clipboard.read()) {
      const html = item.types.includes('text/html') ? await (await item.getType('text/html')).text() : '';
      const imageType = item.types.find((type) => type.startsWith('image/'));
      // An image with HTML that only points at it ("Copy image"): the file is the image.
      if (imageType && !htmlHasText(html)) {
        const blob = await item.getType(imageType);
        editor.commands.focus();
        await insertImageFiles(editor.view, [new File([blob], `pasted-image.${imageType.split('/')[1] ?? 'png'}`, { type: imageType })]);
        return 'pasted';
      }
      if (html) {
        editor.commands.focus();
        editor.view.pasteHTML(html);
        return 'pasted';
      }
      if (item.types.includes('text/plain')) {
        const text = await (await item.getType('text/plain')).text();
        editor.commands.focus();
        editor.view.pasteText(text);
        return 'pasted';
      }
    }
    return 'empty';
  } catch {
    return 'blocked';
  }
}

// --- Writing -----------------------------------------------------------------

/** Write formats to the clipboard through a one-shot copy event. */
export function writeClipboard(data: Record<string, string>): boolean {
  let handled = false;
  const onCopy = (event: ClipboardEvent) => {
    if (!event.clipboardData) return;
    for (const [type, value] of Object.entries(data)) event.clipboardData.setData(type, value);
    event.preventDefault();
    event.stopImmediatePropagation();
    handled = true;
  };
  document.addEventListener('copy', onCopy, { capture: true });
  try {
    document.execCommand('copy');
  } catch {
    // Not supported here: nothing was written.
  } finally {
    document.removeEventListener('copy', onCopy, { capture: true });
  }
  return handled;
}

/** Rewrite the clipboard with the HTML's stored images inlined, where `ClipboardItem` allows. */
function upgradeImages(html: string, text: string): void {
  if (!html.includes('blob://') || typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return;
  try {
    const item = new ClipboardItem({
      'text/html': inlineStoredImages(html).then((resolved) => new Blob([resolved], { type: 'text/html' })),
      'text/plain': new Blob([text], { type: 'text/plain' }),
    });
    navigator.clipboard.write([item]).catch(() => {
      // The plain copy already on the clipboard stands.
    });
  } catch {
    // ClipboardItem without promise support: the plain copy stands.
  }
}

/** Replace `blob://` image sources with `data:` URIs read from blob storage. */
export async function inlineStoredImages(html: string): Promise<string> {
  const body = new DOMParser().parseFromString(html, 'text/html').body;
  await Promise.all(
    Array.from(body.querySelectorAll<HTMLImageElement>('img[src^="blob://"]')).map(async (img) => {
      const blob = await blobStorage.loadBlob(img.getAttribute('src')!.slice('blob://'.length)).catch(() => null);
      if (blob) img.setAttribute('src', await dataUrl(blob));
    }),
  );
  return body.innerHTML;
}

function dataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function hasStoredImages(slice: Slice): boolean {
  let found = false;
  slice.content.descendants((node) => {
    if (found) return false;
    if (node.type.name === 'image' && String(node.attrs['src'] ?? '').startsWith('blob://')) found = true;
    return !found;
  });
  return found;
}

function htmlHasText(html: string): boolean {
  if (!html) return false;
  return (new DOMParser().parseFromString(html, 'text/html').body.textContent ?? '').trim().length > 0;
}
