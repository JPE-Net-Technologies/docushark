/**
 * CollaborativeProseEditor — the live, Yjs-backed rich-text editor used for
 * **relay** documents (the single prose editor for collab docs; local-only docs
 * use the legacy `TiptapEditor`, which has no Y.Doc).
 *
 * It binds a single prose page's `Y.XmlFragment` (via Tiptap's `Collaboration`
 * `field` option) inside the shared collaboration `Y.Doc`. Edits ride the
 * relay's opaque Y.Doc sync (JP-34) and the offline-first engine (JP-108): the
 * fragment is live + persisted (y-indexeddb) whether or not there's a network,
 * so edits typed offline merge on reconnect via the normal Yjs handshake.
 *
 * **The relay is the single prose seeder (JP-284).** The relay seeds prose from
 * `richTextPages` on hydration (JSON rebuild + a binary-path backstop), so this
 * editor never passes initial `content` — it always **adopts** the bound
 * fragment. Injecting content here would create a second, independent prose
 * lineage that merges into the fragment and duplicates every page (the JP-282
 * failure mode). The panel only mounts us once the fragment is authoritative
 * (it already has content, or the relay confirmed it empty via `isSynced`).
 *
 * The fragment is the **single source of truth** for prose. `onUpdate` mirrors
 * the current HTML into `richTextPages` so non-editor consumers (offline cache,
 * outline, PDF) stay current — a pure projection, never an independent writer.
 */

import { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import type { Editor } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import Collaboration from '@tiptap/extension-collaboration';
import type { Doc as YDoc } from 'yjs';
import { sharedProseExtensions } from './TiptapEditor';
import { useRichTextStore } from '../store/richTextStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { useProseEditorChrome } from './useProseEditorChrome';
import './TiptapEditor.css';

export interface CollaborativeProseEditorProps {
  /** Shared collaboration Y.Doc (from `collaborationStore.getYjsDocument()`). */
  ydoc: YDoc;
  /** The Collaboration `field` for this page, e.g. `prose:<pageId>`. */
  field: string;
  /** The rich-text page id this editor edits (for the richTextPages mirror). */
  pageId: string;
  /** Optional class name. */
  className?: string;
  /** Editor instance callback (the panel keeps it for autosave/toolbar). */
  onEditorReady?: (editor: Editor | null) => void;
}

export function CollaborativeProseEditor({
  ydoc,
  field,
  pageId,
  className,
  onEditorReady,
}: CollaborativeProseEditorProps) {
  const editor = useEditor(
    {
      extensions: [
        // History MUST be off — Collaboration owns undo via the Yjs UndoManager.
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5, 6] },
          codeBlock: { HTMLAttributes: { class: 'tiptap-code-block' } },
          history: false,
        }),
        ...sharedProseExtensions,
        Collaboration.configure({ document: ydoc, field }),
      ],
      // No initial `content`: the relay is the sole prose seeder (JP-284), so the
      // editor adopts the bound fragment. Passing content would inject a second
      // prose lineage that merges into the fragment and duplicates content.
      editorProps: { attributes: { class: 'tiptap-prose' } },
      onUpdate: ({ editor }) => {
        const json = editor.getJSON();
        const html = editor.getHTML();
        // Deferred so it doesn't run inside Tiptap's flushSync dispatch.
        queueMicrotask(() => {
          // Keep the projection current: richTextPages is the durable HTML
          // mirror for non-editor consumers (offline cache / outline / PDF). It
          // derives FROM the fragment and is never written independently, so it
          // can't get ahead and clobber.
          useRichTextPagesStore.getState().updatePageContent(pageId, html);
          useRichTextStore.getState().setContent(json);
        });
      },
    },
    // Rebind when the bound fragment changes (page/doc switch via the key also
    // remounts, but this keeps the editor correct if props change in place).
    [ydoc, field],
  );

  // Shared editor chrome: right-click formatting menu, spellcheck popover,
  // custom-dictionary loader, inline-link handling, and blob:// image
  // resolution. Heading-anchor nav is a local multi-page concern, omitted here.
  const { onContextMenu, overlay } = useProseEditorChrome(editor, { headingAnchors: false });

  // Expose the editor instance to the panel (autosave + toolbar).
  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  return (
    <div className={`tiptap-editor ${className ?? ''}`} onContextMenu={onContextMenu}>
      <EditorContent editor={editor} />
      {overlay}
    </div>
  );
}

export default CollaborativeProseEditor;
