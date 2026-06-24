/**
 * useResolveBlobImages — resolve `blob://<hash>` images inside a Tiptap editor's
 * DOM to displayable object URLs, on mount and on every update.
 *
 * Shared by every prose render surface — the local `TiptapEditor`, the relay
 * `CollaborativeProseEditor` (both via `useProseEditorChrome`), and the
 * read-only `ProsePreview` shown while a relay doc's collab engine is still
 * coming up. Keeping the resolution in one hook is what stops the surfaces from
 * drifting: a surface that forgets to resolve renders raw `blob://` srcs the
 * browser can't load, which is exactly the transient broken-image flash when a
 * doc flips between local and collab mode (JP-363 — `ProsePreview` used to miss
 * this).
 *
 * JP-319: a collab/MCP update re-renders the image node view, which resets the
 * DOM `<img>` back to the unresolved `blob://` src from the node attrs. Running
 * the resolver only synchronously can lose that race (the node view re-renders
 * after we resolve), leaving a broken-image icon until the next interaction (the
 * "toggle float to make it reappear" symptom). So also re-resolve on the next
 * frame, after the node view has settled. The resolver is idempotent — it only
 * touches remaining `blob://` srcs, never object/http/data URLs. A read-only
 * surface never fires `update`, but it recreates its editor when its content
 * changes, so the `[editor]` effect re-runs and still covers it.
 */

import { useEffect } from 'react';
import type { Editor } from '@tiptap/core';
import { resolveBlobImagesIn } from './proseBlobImages';

export function useResolveBlobImages(editor: Editor | null): void {
  useEffect(() => {
    if (!editor) return;
    let raf = 0;
    const convert = () => {
      void resolveBlobImagesIn(editor.view.dom);
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => void resolveBlobImagesIn(editor.view.dom));
    };
    convert();
    editor.on('update', convert);
    return () => {
      cancelAnimationFrame(raf);
      editor.off('update', convert);
    };
  }, [editor]);
}
