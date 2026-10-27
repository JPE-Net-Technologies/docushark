/**
 * Actions on a selected prose image, shared by the right-click menu and the
 * phone bar (DSK-202).
 *
 * On a desktop they live in the editor's context menu. On a phone a long-press
 * is the system's selection gesture, so a selected image puts the same actions
 * in the bar instead.
 */

import type { Editor } from '@tiptap/core';
import { NodeSelection, type EditorState } from '@tiptap/pm/state';
import { uploadProseImage } from './proseImageUpload';

/** What can be done with the selected image. */
export interface SelectedImage {
  /** The image is in a gallery, so it can move left or right in it. */
  inGallery: boolean;
  canLeft: boolean;
  canRight: boolean;
}

/** The selected image's actions, or null when the selection isn't an image. */
export function selectedImage(state: EditorState): SelectedImage | null {
  const sel = state.selection;
  if (!(sel instanceof NodeSelection) || sel.node.type.name !== 'image') return null;
  const $from = state.doc.resolve(sel.from);
  if ($from.parent.type.name === 'gallery') {
    const index = $from.index();
    return { inGallery: true, canLeft: index > 0, canRight: index < $from.parent.childCount - 1 };
  }
  return { inGallery: false, canLeft: false, canRight: false };
}

/**
 * Swap the selected image for an uploaded file. The image's NodeSelection
 * survives the file picker, so the swap lands on the image that was selected.
 */
export async function replaceSelectedImageWithFile(editor: Editor, file: File): Promise<void> {
  const { src, alt } = await uploadProseImage(file);
  editor.chain().focus().replaceSelectedImage({ src, alt }).run();
}
