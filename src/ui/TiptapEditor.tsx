/**
 * TiptapEditor component - Core rich text editor wrapper.
 *
 * Uses Tiptap (ProseMirror) for rich text editing with:
 * - Headings (H1-H6)
 * - Bold, italic, underline, strikethrough, inline code
 * - Text color and highlight
 * - Subscript and superscript
 * - Bullet and numbered lists
 * - Horizontal rules
 * - Images with resize handles (stored in IndexedDB with blob:// URLs)
 * - Tables with styling
 * - Task lists
 * - LaTeX equations (inline and block)
 * - Embedded groups from canvas
 */

import { useEffect } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { history } from 'prosemirror-history';
import Placeholder from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Underline from '@tiptap/extension-underline';
import Subscript from '@tiptap/extension-subscript';
import Superscript from '@tiptap/extension-superscript';
import Highlight from '@tiptap/extension-highlight';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import TextAlign from '@tiptap/extension-text-align';
import Link from '@tiptap/extension-link';
import { useRichTextStore } from '../store/richTextStore';
import { EmbeddedGroup } from '../tiptap/EmbeddedGroupExtension';
import { ResizableImage } from '../tiptap/ResizableImageExtension';
import { MathInline, MathBlock } from '../tiptap/LatexExtension';
import { CitationInline, Bibliography } from '../tiptap/CitationExtension';
import { isProjectionTransaction } from '../tiptap/proseProjection';
import { CodeBlockKeymap } from '../tiptap/CodeBlockKeymap';
import { SpellcheckExtension } from '../tiptap/SpellcheckExtension';
import { useProseEditorChrome } from './useProseEditorChrome';
import { resolveBlobImagesIn } from './proseBlobImages';
import { registerProseSchema } from '../collaboration/proseSchema';
import 'katex/dist/katex.min.css';
import './TiptapEditor.css';

// `blob://<hash>` rich-text images resolve through the shared blobResolver:
// it returns directly-loadable URLs (`data:`/`http(s):`) unchanged, and for
// blob refs it checks the one content-addressed object-URL cache, then local
// IndexedDB, then downloads from the relay/R2 on a miss — so images embedded on
// another device render here too (JP-129), not just thumbnails.

/**
 * Non-StarterKit prose extensions (nodes/marks/behaviors), shared between the
 * local editor in this file and `CollaborativeProseEditor` — which composes
 * them with a **history-disabled** StarterKit + the Collaboration extension.
 * Keep this the single source of truth so both editors render identically.
 */
export const sharedProseExtensions = [
  CodeBlockKeymap,
  SpellcheckExtension,
  Placeholder.configure({
    placeholder: 'Start writing your document...',
  }),
  ResizableImage.configure({
    inline: false,
    allowBase64: true,
    HTMLAttributes: {
      class: 'tiptap-image',
    },
  }),
  // Text styling
  TextStyle,
  Color,
  Highlight.configure({
    multicolor: true,
  }),
  Underline,
  Subscript,
  Superscript,
  TextAlign.configure({
    types: ['heading', 'paragraph'],
    alignments: ['left', 'center', 'right', 'justify'],
  }),
  Link.configure({
    openOnClick: false,
    autolink: true,
    linkOnPaste: true,
    HTMLAttributes: { class: 'tiptap-link', rel: 'noopener noreferrer' },
    protocols: ['http', 'https', 'mailto', 'docushark'],
  }),
  // Tables
  Table.configure({
    resizable: true,
    HTMLAttributes: {
      class: 'tiptap-table',
    },
  }),
  TableRow,
  TableCell.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        backgroundColor: {
          default: null,
          parseHTML: element => element.style.backgroundColor || null,
          renderHTML: attributes => {
            if (!attributes['backgroundColor']) {
              return {};
            }
            return {
              style: `background-color: ${attributes['backgroundColor']}`,
            };
          },
        },
      };
    },
  }),
  TableHeader.extend({
    addAttributes() {
      return {
        ...this.parent?.(),
        backgroundColor: {
          default: null,
          parseHTML: element => element.style.backgroundColor || null,
          renderHTML: attributes => {
            if (!attributes['backgroundColor']) {
              return {};
            }
            return {
              style: `background-color: ${attributes['backgroundColor']}`,
            };
          },
        },
      };
    },
  }),
  // Task lists
  TaskList.configure({
    HTMLAttributes: {
      class: 'tiptap-task-list',
    },
  }),
  TaskItem.configure({
    nested: true,
    HTMLAttributes: {
      class: 'tiptap-task-item',
    },
  }),
  // LaTeX/Math
  MathInline,
  MathBlock,
  // Citations (JP-89): inline cite + bibliography block, rendered from referenceStore
  CitationInline,
  Bibliography,
  EmbeddedGroup,
];

/**
 * The local (non-collaborative) editor's full extension set: StarterKit (with
 * its built-in history) plus the shared prose extensions. Also reused by
 * `generateJSON` for PDF export.
 */
export const extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    // bulletList, orderedList, horizontalRule, bold, italic, code, strike,
    // blockquote are enabled by default.
    codeBlock: { HTMLAttributes: { class: 'tiptap-code-block' } },
  }),
  ...sharedProseExtensions,
];

// Register this schema for headless/programmatic prose writes (JP-193). It lives
// here, in the lazily-loaded prose chunk, so the heavy tiptap/katex/nspell stack
// stays out of the main bundle. History on/off and the Collaboration plugin add
// no nodes/marks, so this schema matches `CollaborativeProseEditor`'s exactly.
registerProseSchema(getSchema(extensions));

export interface TiptapEditorProps {
  /** Optional class name */
  className?: string;
  /** Callback when editor instance is ready (or destroyed) */
  onEditorReady?: (editor: Editor | null) => void;
}

import type { Editor } from '@tiptap/core';

export function TiptapEditor({ className, onEditorReady }: TiptapEditorProps) {
  const content = useRichTextStore((state) => state.content);
  const setContent = useRichTextStore((state) => state.setContent);
  const setContentSilently = useRichTextStore((state) => state.setContentSilently);

  const editor = useEditor({
    extensions,
    content: content.content,
    onUpdate: ({ editor, transaction }) => {
      // Defer the Zustand write so it doesn't run inside Tiptap's
      // transaction dispatch (which itself is wrapped in flushSync under
      // @tiptap/react), avoiding "flushSync was called from inside a
      // lifecycle method" warnings in React 18.
      //
      // A *projection* transaction (a prose-helper caching derived content —
      // JP-89) must mirror silently: it updates content but must not flip dirty
      // or schedule a save. Capture the flag now; the deferred microtask escapes
      // the synchronous `withAutoSaveSuppressed` window, so meta-gating (not
      // suppression) is what keeps it silent.
      const silent = isProjectionTransaction(transaction);
      const json = editor.getJSON();
      queueMicrotask(() => (silent ? setContentSilently(json) : setContent(json)));
    },
    editorProps: {
      attributes: {
        class: 'tiptap-prose',
      },
    },
  });

  // Shared editor chrome: right-click formatting menu, spellcheck popover,
  // custom-dictionary loader, inline-link handling (heading anchors on for the
  // local multi-page editor), and blob:// image resolution.
  const { onContextMenu, overlay } = useProseEditorChrome(editor, { headingAnchors: true });

  // Update editor content when loaded from document.
  // setContent dispatches a Tiptap transaction that synchronously mounts
  // ReactNodeViews via flushSync; running it inside the effect's commit
  // phase trips React's "flushSync called from inside a lifecycle method"
  // warning. Defer the whole swap to a microtask so the dispatch happens
  // after React's commit.
  useEffect(() => {
    if (!editor || !content.content) return;
    const newContent = content.content;
    const currentContent = JSON.stringify(editor.getJSON());
    if (currentContent === JSON.stringify(newContent)) return;

    queueMicrotask(() => {
      if (editor.isDestroyed) return;
      editor.commands.setContent(newContent);
      // Drop history so the "load document" transaction can never be
      // undone, and so any leftover entries from a previously-loaded
      // document don't leak across. Reconfigure with a fresh history
      // plugin instance — this resets only the history plugin's state
      // and leaves @tiptap/react's ReactNodeView tracking plugin alone
      // (a wholesale `EditorState.create` would crash mid-render here
      // by forcing every plugin to reinit and remounting node views
      // against a partial desc tree).
      const newPlugins = editor.state.plugins.map((p) => {
        const key = (p as unknown as { key?: string }).key;
        return typeof key === 'string' && key.startsWith('history$') ? history() : p;
      });
      editor.view.updateState(editor.state.reconfigure({ plugins: newPlugins }));

      // Resolve blob:// images after content is set (slight delay for DOM
      // update); on-update resolution is handled by useProseEditorChrome.
      requestAnimationFrame(() => void resolveBlobImagesIn(editor.view.dom));
    });
  }, [editor, content.content]);

  // Expose editor instance via callback for parent to provide context
  useEffect(() => {
    if (editor && onEditorReady) {
      onEditorReady(editor);
    }
    return () => {
      if (onEditorReady) {
        onEditorReady(null);
      }
    };
  }, [editor, onEditorReady]);

  return (
    <div className={`tiptap-editor ${className ?? ''}`} onContextMenu={onContextMenu}>
      <EditorContent editor={editor} />
      {overlay}
    </div>
  );
}

/**
 * Get the current Tiptap editor instance.
 * @deprecated Use useTiptapEditor() hook from TiptapEditorContext instead.
 * Kept for non-component callers (e.g., PDFExportDialog).
 */
export function getTiptapEditor() {
  return (window as unknown as { __tiptapEditor?: ReturnType<typeof useEditor> }).__tiptapEditor;
}
