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
import CollaborationCursor from '@tiptap/extension-collaboration-cursor';
import type { Doc as YDoc } from 'yjs';
import type { Awareness } from 'y-protocols/awareness';
import type { AnyExtension } from '@tiptap/core';
import { sharedProseExtensions } from './TiptapEditor';
import { handleCitationDoiPaste } from '../tiptap/citationPaste';
import { useRichTextStore } from '../store/richTextStore';
import { useRichTextPagesStore } from '../store/richTextPagesStore';
import { useActiveDocReadOnly } from '../store/documentRegistry';
import { useProseEditorChrome } from './useProseEditorChrome';
import './TiptapEditor.css';
import './collaborationCursor.css';

export interface CollaborativeProseEditorProps {
  /** Shared collaboration Y.Doc (from `collaborationStore.getYjsDocument()`). */
  ydoc: YDoc;
  /** The Collaboration `field` for this page, e.g. `prose:<pageId>`. */
  field: string;
  /** The rich-text page id this editor edits (for the richTextPages mirror). */
  pageId: string;
  /** Optional class name. */
  className?: string;
  /**
   * Live Yjs awareness (from `getSyncProvider()?.getAwareness()`). When present
   * with `user`, remote collaborators' carets render in the prose via
   * CollaborationCursor. Shares the awareness channel with canvas presence — the
   * caret state lives in the top-level `cursor` field; canvas cursors live under
   * `user.cursor`, so they coexist (the shared `user` name/color is the same
   * identity). Null offline / before the provider connects → no carets.
   */
  awareness?: Awareness | null;
  /** Local user identity for the caret label (from presence `localUser`). */
  user?: { name: string; color: string } | null;
  /** Editor instance callback (the panel keeps it for autosave/toolbar). The
   *  `pageId` lets the panel pair the editor with its page (JP-334). */
  onEditorReady?: (editor: Editor | null, pageId: string | null) => void;
}

export function CollaborativeProseEditor({
  ydoc,
  field,
  pageId,
  className,
  awareness,
  user,
  onEditorReady,
}: CollaborativeProseEditorProps) {
  // JP-370: view-only for this user → the prose editor is non-editable (the
  // relay also drops a viewer's writes; this is the UX layer).
  const readOnly = useActiveDocReadOnly();

  // Remote-caret extension, added only when an awareness channel + identity are
  // available (i.e. an active collab session). y-prosemirror stores the caret in
  // the awareness `cursor` field — disjoint from the canvas `user.cursor`.
  const collaborationCursor: AnyExtension[] =
    awareness && user
      ? [CollaborationCursor.configure({ provider: { awareness }, user })]
      : [];

  const editor = useEditor(
    {
      extensions: [
        // History MUST be off — Collaboration owns undo via the Yjs UndoManager.
        StarterKit.configure({
          heading: { levels: [1, 2, 3, 4, 5, 6] },
          // codeBlock replaced by the lowlight CodeBlock in sharedProseExtensions.
          codeBlock: false,
          history: false,
        }),
        ...sharedProseExtensions,
        Collaboration.configure({ document: ydoc, field }),
        ...collaborationCursor,
      ],
      editable: !readOnly,
      // Build the editor in a commit-phase effect, not during render. Tiptap's
      // default constructs the editor inside render; here that synchronously sets
      // local Yjs awareness (via CollaborationCursor), which fires the awareness
      // listener that writes collaborationStore.remoteUsers — a setState during
      // render that React flags ("Cannot update FloatingCollabIndicator while
      // rendering CollaborativeProseEditor"). Deferring construction keeps render
      // pure. The component already handles `editor === null` on first render.
      immediatelyRender: false,
      // No initial `content`: the relay is the sole prose seeder (JP-284), so the
      // editor adopts the bound fragment. Passing content would inject a second
      // prose lineage that merges into the fragment and duplicates content.
      editorProps: {
        attributes: { class: 'tiptap-prose' },
        // Paste a bare DOI → resolve + add to the library + insert a citation.
        handlePaste: (view, event) => handleCitationDoiPaste(view, event),
      },
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
    // `awareness` is included so the editor picks up CollaborationCursor once the
    // provider connects (it may be null on first mount when offline-first).
    [ydoc, field, awareness],
  );

  // Shared editor chrome: right-click formatting menu, spellcheck popover,
  // custom-dictionary loader, inline-link handling, and blob:// image
  // resolution. Heading-anchor nav is on (JP-417): collab docs are multi-page
  // too (prose pages are CRDT shared types) and the panel drives the active
  // page off the same richTextPagesStore the handler switches.
  const { onContextMenu, overlay } = useProseEditorChrome(editor, { headingAnchors: true });

  // Expose the editor instance to the panel (autosave + toolbar).
  useEffect(() => {
    onEditorReady?.(editor, pageId);
    return () => onEditorReady?.(null, pageId);
  }, [editor, onEditorReady, pageId]);

  // JP-370: keep editability in sync if the doc's permission flips in place
  // (e.g. demoted to viewer mid-session) without remounting the editor.
  useEffect(() => {
    editor?.setEditable(!readOnly);
  }, [editor, readOnly]);

  return (
    <div className={`tiptap-editor ${className ?? ''}`} onContextMenu={onContextMenu}>
      <EditorContent editor={editor} />
      {overlay}
    </div>
  );
}

export default CollaborativeProseEditor;
