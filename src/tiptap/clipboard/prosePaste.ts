/**
 * The prose editors' paste and drop handling (DSK-208), wired into both
 * editors through `sharedProseEditorProps`.
 *
 * ProseMirror runs a paste as: `transformPastedHTML` on the raw HTML, the
 * parse, then `handlePaste` with the parsed slice, which may claim the paste;
 * otherwise the slice is inserted. A drop of outside content is parsed the same
 * way and offered to `handleDrop`.
 *
 * - `transformPastedHTML` tidies Word and Google Docs markup.
 * - `handlePaste`, in order:
 *   1. after Mod+Shift+V, inserts the text exactly as copied (`pastePlainText`);
 *   2. resolves a bare DOI into a citation;
 *   3. takes image files from the clipboard when the paste carries no text: a
 *      screenshot, or "Copy image", where the file is the real image and the
 *      HTML only points at it;
 *   4. holds a paste whose images need storing until they're stored (see
 *      `insertStoringImages`).
 * - `handleProseImageDrop` does step 4 for content dropped from outside.
 */
import { Fragment, Slice } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { handleCitationDoiPaste } from '../citationPaste';
import { normalizePastedHtml } from './normalizePastedHtml';
import { imageSourcesIn, insertImageFiles, insertStoringImages, reportPaste } from './pasteImages';

/** Images the current paste's tidy removed, from `transformPastedHTML` to the handler. */
const droppedImages = new WeakMap<EditorView, number>();

export function transformPastedProseHtml(html: string, view: EditorView): string {
  const tidy = normalizePastedHtml(html);
  droppedImages.set(view, tidy.droppedImages);
  return tidy.html;
}

export function handleProsePaste(view: EditorView, event: ClipboardEvent, slice: Slice): boolean {
  const dropped = takeDroppedImages(view);

  if (plainPasteIntent.get(view)) {
    plainPasteIntent.delete(view);
    const text = event.clipboardData?.getData('text/plain') ?? '';
    if (text) {
      pastePlainText(view, text);
      return true;
    }
  }
  if (handleCitationDoiPaste(view, event)) return true;

  const files = clipboardImageFiles(event.clipboardData);
  if (files.length > 0 && !hasText(slice)) {
    void insertImageFiles(view, files);
    return true;
  }

  if (imageSourcesIn(slice).length > 0) {
    void insertStoringImages(view, slice, { droppedImages: dropped });
    return true;
  }

  reportPaste({ dropped, linked: 0, failed: 0 });
  return false;
}

/** Content dropped from outside whose images need storing: held like a paste, at the drop point. */
export function handleProseImageDrop(view: EditorView, event: DragEvent, slice: Slice, moved: boolean): boolean {
  const dropped = takeDroppedImages(view);
  if (moved || imageSourcesIn(slice).length === 0) {
    reportPaste({ dropped, linked: 0, failed: 0 });
    return false;
  }
  const at = view.posAtCoords({ left: event.clientX, top: event.clientY })?.pos;
  if (at === undefined) return false;
  void insertStoringImages(view, slice, { at, droppedImages: dropped });
  return true;
}

/**
 * Paste without formatting: the text exactly as copied. A paste's transaction
 * would run Tiptap's paste rules, which turn `**word**` into bold, so the text
 * goes in by a plain replace instead: one paragraph per line, or the lines
 * themselves inside a code block.
 */
export function pastePlainText(view: EditorView, text: string): void {
  const { state } = view;
  const normalized = text.replace(/\r\n?/g, '\n');
  const paragraph = state.schema.nodes['paragraph'];
  const lines = normalized.split('\n');
  if (state.selection.$from.parent.type.spec.code || lines.length === 1 || !paragraph) {
    view.dispatch(state.tr.insertText(normalized).scrollIntoView());
    return;
  }
  const paragraphs = lines.map((line) => paragraph.create(null, line ? state.schema.text(line) : null));
  view.dispatch(state.tr.replaceSelection(new Slice(Fragment.from(paragraphs), 1, 1)).scrollIntoView());
}

/** Set by Mod+Shift+V's keydown, so the paste that follows goes in as plain text. */
const plainPasteIntent = new WeakMap<EditorView, boolean>();

export function notePlainPasteShortcut(view: EditorView, event: KeyboardEvent): void {
  const plain = event.shiftKey && (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v';
  if (plain) plainPasteIntent.set(view, true);
  else plainPasteIntent.delete(view);
}

function takeDroppedImages(view: EditorView): number {
  const count = droppedImages.get(view) ?? 0;
  droppedImages.delete(view);
  return count;
}

function clipboardImageFiles(data: DataTransfer | null): File[] {
  if (!data) return [];
  const fromItems = Array.from(data.items ?? [])
    .filter((item) => item.kind === 'file' && item.type.startsWith('image/'))
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null);
  if (fromItems.length > 0) return fromItems;
  return Array.from(data.files ?? []).filter((file) => file.type.startsWith('image/'));
}

function hasText(slice: Slice): boolean {
  return slice.content.textBetween(0, slice.content.size, ' ', ' ').trim().length > 0;
}
