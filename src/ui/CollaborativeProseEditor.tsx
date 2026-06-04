/**
 * CollaborativeProseEditor — the live, Yjs-backed rich-text editor used for
 * relay/team documents when the `collabProse` flag is on.
 *
 * Unlike the local `TiptapEditor` (which binds to `richTextStore` and swaps
 * content on page-switch), this editor binds a single prose page's
 * `Y.XmlFragment` (via Tiptap's `Collaboration` `field` option) inside the
 * shared collaboration `Y.Doc`. Edits then ride the relay's existing opaque
 * Y.Doc sync (JP-34) and go live across clients — exactly like the canvas.
 *
 * Source of truth = the Y.Doc fragment. The component is mounted per
 * `(docId, pageId, sessionEpoch)` (keyed by the panel) and bound to one
 * fragment; switching pages — or an engine restart — recreates it against the
 * right fragment / fresh Y.Doc.
 *
 * Durability (JP-108): the relay persists the whole Y.Doc — incl. these
 * `prose:<page>` fragments — as a binary sidecar, so prose survives
 * evict/reconnect/reload-via-join with NO relay-side flatten. `onUpdate` still
 * mirrors the current HTML into `richTextPages` (and marks `richTextStore`
 * dirty) so LOCAL consumers (offline cache, outline, PDF, the seed source) stay
 * current — but that client REST save is suppressed for active-collab docs
 * (relay is sole writer), so the binary, not REST, is the durable store.
 *
 * Behind the off-by-default `collabProse` flag — see `config/featureFlags.ts`.
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
import { resolveBlobUrl } from '../storage/blobResolver';
import './TiptapEditor.css';

export interface CollaborativeProseEditorProps {
  /** Shared collaboration Y.Doc (from `collaborationStore.getYjsDocument()`). */
  ydoc: YDoc;
  /** The Collaboration `field` for this page, e.g. `prose:<pageId>`. */
  field: string;
  /** The rich-text page id this editor edits (for persisting its HTML). */
  pageId: string;
  /**
   * Existing page HTML used to seed the fragment **iff it's empty**. Once any
   * client has seeded (or the relay holds content), the fragment wins and this
   * is ignored.
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
  seedHtml,
  className,
  onEditorReady,
}: CollaborativeProseEditorProps) {
  // Guard against re-seeding: only the first client to reach a never-seeded
  // fragment passes initial content. Late joiners and remounts get `undefined`
  // and render whatever the synced fragment holds. (y-prosemirror also ignores
  // initial content on a non-empty fragment; this trims the cold-open race.)
  const proseSeeded = ydoc.getMap<boolean>('proseSeeded');
  const alreadySeeded = proseSeeded.get(field) === true;

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
      // Only pass initial content when seeding a never-seeded fragment; omit it
      // otherwise (the synced fragment is the source of truth). Omitting — not
      // passing `undefined` — is required under `exactOptionalPropertyTypes`.
      ...(alreadySeeded ? {} : { content: seedHtml }),
      editorProps: { attributes: { class: 'tiptap-prose' } },
      onCreate: () => {
        if (!alreadySeeded) {
          // Mark seeded so a remount / late joiner doesn't re-apply seedHtml.
          ydoc.transact(() => proseSeeded.set(field, true));
        }
      },
      onUpdate: ({ editor }) => {
        const json = editor.getJSON();
        const html = editor.getHTML();
        // Deferred so it doesn't run inside Tiptap's flushSync dispatch.
        queueMicrotask(() => {
          // Keep the LOCAL HTML mirror current (offline cache / outline / PDF /
          // the seed source). Durable cross-session persistence is the relay's
          // binary Y.Doc sidecar (JP-108) — the client REST save is suppressed
          // for active-collab docs (relay is sole writer), so this mirror is for
          // local consumers, not durability.
          useRichTextPagesStore.getState().updatePageContent(pageId, html);
          // `setContent` marks richTextStore dirty (false→true), which is what
          // `useAutoSave` watches to schedule the (suppressed) local save.
          useRichTextStore.getState().setContent(json);
        });
      },
    },
    // Rebind when the bound fragment changes (page/doc switch via the key also
    // remounts, but this keeps the editor correct if props change in place).
    [ydoc, field],
  );

  // Resolve blob:// images to object URLs (initial + on every update) — same as
  // the local editor; collaborators on other devices embed images we must load.
  useEffect(() => {
    if (!editor) return;
    const convert = async () => {
      const images = editor.view.dom.querySelectorAll('img[src^="blob://"]');
      for (const el of Array.from(images)) {
        const img = el as HTMLImageElement;
        const blobUrl = img.getAttribute('src');
        if (!blobUrl) continue;
        const objectUrl = await resolveBlobUrl(blobUrl);
        if (objectUrl && objectUrl !== blobUrl) {
          img.setAttribute('src', objectUrl);
        } else if (!objectUrl) {
          img.setAttribute('alt', '(Image not found)');
          img.style.border = '2px dashed var(--border-color)';
          img.style.padding = '8px';
        }
      }
    };
    void convert();
    const onUpdate = () => void convert();
    editor.on('update', onUpdate);
    return () => {
      editor.off('update', onUpdate);
    };
  }, [editor]);

  // Inline link clicks (http(s)/mailto open in a new tab) — same as the local
  // editor; heading-anchor nav is a local-doc concern and omitted here.
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor || !dom.contains(anchor)) return;
      const href = anchor.getAttribute('href') || '';
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        event.preventDefault();
        event.stopPropagation();
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    };
    dom.addEventListener('click', onClick);
    return () => dom.removeEventListener('click', onClick);
  }, [editor]);

  // Expose the editor instance to the panel (autosave + toolbar).
  useEffect(() => {
    onEditorReady?.(editor);
    return () => onEditorReady?.(null);
  }, [editor, onEditorReady]);

  return (
    <div className={`tiptap-editor ${className ?? ''}`}>
      <EditorContent editor={editor} />
    </div>
  );
}

export default CollaborativeProseEditor;
