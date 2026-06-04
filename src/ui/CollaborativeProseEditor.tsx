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
 * The fragment is the **single source of truth** for prose. `onUpdate` mirrors
 * the current HTML into `richTextPages` so non-editor consumers (offline cache,
 * outline, PDF, the seed source) stay current — a pure projection, never an
 * independent writer (which is what previously diverged and clobbered).
 *
 * The panel mounts this only when the engine is ready and the fragment is the
 * authoritative truth (it already has content, or the relay confirmed empty via
 * `isSynced`). Seeding an empty fragment happens only when `isSynced` —
 * never offline, where two devices could fork independent identities.
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
  /**
   * Whether the relay has confirmed this doc's state. Gates seeding: an empty
   * fragment is seeded from `seedHtml` only when `true` (online-confirmed
   * empty). Seeding offline could fork a second CRDT identity that duplicates
   * on the first sync.
   */
  isSynced: boolean;
  /**
   * Existing page HTML used to seed the fragment **iff it's empty AND
   * `isSynced`**. Once seeded (or the fragment already holds content), the
   * fragment wins and this is ignored.
   */
  seedHtml: string;
  /** Optional class name. */
  className?: string;
  /** Editor instance callback (the panel keeps it for autosave/toolbar). */
  onEditorReady?: (editor: Editor | null) => void;
}

export function CollaborativeProseEditor({
  ydoc,
  field,
  pageId,
  isSynced,
  seedHtml,
  className,
  onEditorReady,
}: CollaborativeProseEditorProps) {
  const proseSeeded = ydoc.getMap<boolean>('proseSeeded');
  // Seed only a never-seeded fragment, and only once the relay confirms the
  // doc's state. The panel won't even mount us for an empty fragment offline
  // (it shows a read-only preview instead), so this is also the safety gate.
  const shouldSeed = proseSeeded.get(field) !== true && isSynced;

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
      // Only pass initial content when seeding a never-seeded, online-confirmed
      // fragment; omit it otherwise (the synced fragment is the source of
      // truth). Omitting — not passing `undefined` — is required under
      // `exactOptionalPropertyTypes`.
      ...(shouldSeed ? { content: seedHtml } : {}),
      editorProps: { attributes: { class: 'tiptap-prose' } },
      onCreate: () => {
        if (shouldSeed) {
          // Mark seeded so a remount / late joiner doesn't re-apply seedHtml.
          ydoc.transact(() => proseSeeded.set(field, true));
        }
      },
      onUpdate: ({ editor }) => {
        const json = editor.getJSON();
        const html = editor.getHTML();
        // Deferred so it doesn't run inside Tiptap's flushSync dispatch.
        queueMicrotask(() => {
          // Keep the projection current: richTextPages is the durable HTML
          // mirror for non-editor consumers (offline cache / outline / PDF /
          // seed). It derives FROM the fragment and is never written
          // independently, so it can't get ahead and clobber.
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
