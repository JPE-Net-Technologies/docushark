/**
 * Read-only rendering of a prose page's HTML.
 *
 * Used by `DocumentEditorPanel` for a relay document while its collaboration
 * engine is still coming up (sub-second), and for the rare "opened offline and
 * never synced on this device" case where seeding the Y.Doc fragment isn't yet
 * safe (it would fork CRDT identity). Showing the content read-only means the
 * user always sees their prose; editing resumes the instant the engine is ready
 * / the relay confirms the fragment, with no risk of clobbering `richTextPages`.
 *
 * Implemented as a non-editable Tiptap instance (not `dangerouslySetInnerHTML`)
 * so the HTML is schema-sanitized and rendered with the exact prose styling.
 */

import { useEditor, EditorContent } from '@tiptap/react';
import { extensions } from './TiptapEditor';
import { useResolveBlobImages } from './useProseBlobImages';
import './TiptapEditor.css';

export interface ProsePreviewProps {
  /** The page's stored HTML to render read-only. */
  html: string;
  className?: string;
}

export function ProsePreview({ html, className }: ProsePreviewProps) {
  const editor = useEditor(
    {
      editable: false,
      content: html,
      extensions,
      editorProps: { attributes: { class: 'tiptap-prose' } },
    },
    [html],
  );

  // Resolve embedded `blob://` images to object URLs — the read-only preview is
  // shown for a relay doc while its collab engine comes up, and without this its
  // images render broken until the editable surface mounts (JP-363).
  useResolveBlobImages(editor);

  return (
    <div className={`tiptap-editor ${className ?? ''}`}>
      <EditorContent editor={editor} />
    </div>
  );
}

export default ProsePreview;
