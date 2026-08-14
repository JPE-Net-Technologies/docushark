/**
 * Swallow file drops onto a prose editor (JP-495).
 *
 * Inserting a dropped file isn't built yet — but doing *nothing* is not the
 * neutral option. With no handler the browser falls back to its default for a
 * dropped file: navigate away and display it, discarding whatever was unsaved in
 * the editor. So the absence of a feature is a data-loss path, and this closes
 * it until drag-to-attach lands.
 *
 * Shared because there are **two** prose editors (`TiptapEditor` and
 * `CollaborativeProseEditor`); a guard wired into only one leaves the other
 * destructive, and nothing would fail to tell us.
 */

import type { EditorView } from '@tiptap/pm/view';

/**
 * ProseMirror `handleDrop`: consume a drop carrying files, ignore everything
 * else (text and internal node drags must keep working).
 *
 * Returns true when the event was consumed.
 */
export function handleProseFileDrop(_view: EditorView, event: DragEvent): boolean {
  if (!event.dataTransfer?.files?.length) return false;
  event.preventDefault();
  return true;
}
