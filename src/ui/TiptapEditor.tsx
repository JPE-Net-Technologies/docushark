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

import { useEffect, useState, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
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
import { blobStorage } from '../storage/BlobStorage';
import { EmbeddedGroup } from '../tiptap/EmbeddedGroupExtension';
import { ResizableImage } from '../tiptap/ResizableImageExtension';
import { MathInline, MathBlock } from '../tiptap/LatexExtension';
import { CodeBlockKeymap } from '../tiptap/CodeBlockKeymap';
import { SpellcheckExtension, rebuildSpellcheck } from '../tiptap/SpellcheckExtension';
import { SpellcheckService } from '../services/SpellcheckService';
import { SpellcheckPopover } from './SpellcheckPopover';
import { DocumentEditorContextMenu } from './DocumentEditorContextMenu';
import 'katex/dist/katex.min.css';
import './TiptapEditor.css';

/**
 * Cache of object URLs for blob:// images.
 * Maps blob ID to object URL.
 */
const blobObjectUrls = new Map<string, string>();

/**
 * Convert blob:// URL to object URL by loading from IndexedDB.
 * Caches object URLs to avoid repeated loads.
 */
async function getBlobObjectUrl(blobUrl: string): Promise<string | null> {
  // Check if it's a blob:// URL
  if (!blobUrl.startsWith('blob://')) {
    return blobUrl; // Return as-is for regular URLs
  }

  const blobId = blobUrl.replace('blob://', '');

  // Check cache
  if (blobObjectUrls.has(blobId)) {
    return blobObjectUrls.get(blobId)!;
  }

  // Load from IndexedDB
  try {
    const blob = await blobStorage.loadBlob(blobId);
    if (!blob) {
      console.warn(`Blob not found: ${blobId}`);
      return null;
    }

    const objectUrl = URL.createObjectURL(blob);
    blobObjectUrls.set(blobId, objectUrl);
    return objectUrl;
  } catch (error) {
    console.error(`Failed to load blob: ${blobId}`, error);
    return null;
  }
}

/**
 * Configure Tiptap extensions for rich text editing.
 * Exported for use by generateJSON when converting HTML pages to JSON for PDF export.
 */
export const extensions = [
  StarterKit.configure({
    heading: { levels: [1, 2, 3, 4, 5, 6] },
    // These are enabled by default, no need to set true
    // bulletList, orderedList, horizontalRule, bold, italic, code, strike, blockquote
    codeBlock: {
      HTMLAttributes: { class: 'tiptap-code-block' },
    },
  }),
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
  EmbeddedGroup,
];

/**
 * Context menu state for the document editor.
 */
interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
}

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

  // Context menu state
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
  });

  // Spellcheck popover state
  const [spellPopover, setSpellPopover] = useState<{
    word: string;
    range: { from: number; to: number };
    x: number;
    y: number;
  } | null>(null);

  const editor = useEditor({
    extensions,
    content: content.content,
    onUpdate: ({ editor }) => {
      // Defer the Zustand write so it doesn't run inside Tiptap's
      // transaction dispatch (which itself is wrapped in flushSync under
      // @tiptap/react), avoiding "flushSync was called from inside a
      // lifecycle method" warnings in React 18.
      const json = editor.getJSON();
      queueMicrotask(() => setContent(json));
    },
    editorProps: {
      attributes: {
        class: 'tiptap-prose',
      },
    },
  });

  // DOM-level click handler so inline link clicks reliably fire (handleClickOn
  // doesn't trigger consistently for inline marks in all browsers).
  useEffect(() => {
    if (!editor) return;
    const dom = editor.view.dom;
    const onClick = (event: MouseEvent) => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest('a[href]') as HTMLAnchorElement | null;
      if (!anchor || !dom.contains(anchor)) return;
      const href = anchor.getAttribute('href') || '';

      const headingMatch = href.match(/^docushark:\/\/heading\/([^/]+)\/(\d+)$/);
      if (headingMatch) {
        event.preventDefault();
        event.stopPropagation();
        const pageId = headingMatch[1]!;
        const headingIndex = parseInt(headingMatch[2]!, 10);
        import('../store/richTextPagesStore').then(({ useRichTextPagesStore }) => {
          const store = useRichTextPagesStore.getState();
          if (store.activePageId !== pageId) store.setActivePage(pageId);
          const scrollToHeading = (attempts = 0) => {
            const headings = document.querySelectorAll(
              '.tiptap-prose h1, .tiptap-prose h2, .tiptap-prose h3, .tiptap-prose h4, .tiptap-prose h5, .tiptap-prose h6',
            );
            const el = headings[headingIndex] as HTMLElement | undefined;
            if (el) {
              el.scrollIntoView({ behavior: 'smooth', block: 'start' });
            } else if (attempts < 30) {
              requestAnimationFrame(() => scrollToHeading(attempts + 1));
            }
          };
          requestAnimationFrame(() => scrollToHeading());
        });
        return;
      }
      if (/^https?:\/\//i.test(href) || /^mailto:/i.test(href)) {
        event.preventDefault();
        event.stopPropagation();
        window.open(href, '_blank', 'noopener,noreferrer');
      }
    };
    dom.addEventListener('click', onClick);
    return () => dom.removeEventListener('click', onClick);
  }, [editor]);

  // Handle context menu — show spellcheck popover when right-clicking a misspelled word,
  // otherwise show the regular formatting context menu.
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    const target = e.target as HTMLElement | null;
    const errorSpan = target?.closest('.spellcheck-error') as HTMLElement | null;
    if (errorSpan && editor) {
      e.preventDefault();
      const word = errorSpan.textContent || '';
      const view = editor.view;
      const pos = view.posAtDOM(errorSpan, 0);
      const range = { from: pos, to: pos + word.length };
      setSpellPopover({ word, range, x: e.clientX, y: e.clientY });
      return;
    }
    e.preventDefault();
    setContextMenu({
      isOpen: true,
      x: e.clientX,
      y: e.clientY,
    });
  }, [editor]);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, isOpen: false }));
  }, []);

  // Push the document's custom dictionary into the spellcheck service whenever it changes
  useEffect(() => {
    if (!editor) return;
    const words = content.customDictionary;
    if (words && words.length > 0) {
      SpellcheckService.loadCustomWords(words);
      // rebuildSpellcheck dispatches a Tiptap transaction; defer past
      // the effect commit so flushSync doesn't fire inside a lifecycle.
      queueMicrotask(() => {
        if (!editor.isDestroyed) rebuildSpellcheck(editor.view);
      });
    }
  }, [editor, content.customDictionary]);

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

      // Convert blob:// URLs after content is set (slight delay for DOM update)
      requestAnimationFrame(async () => {
        const editorElement = editor.view.dom;
        const images = editorElement.querySelectorAll('img[src^="blob://"]');

        for (const element of Array.from(images)) {
          const img = element as HTMLImageElement;
          const blobUrl = img.getAttribute('src');
          if (!blobUrl) continue;

          const objectUrl = await getBlobObjectUrl(blobUrl);
          if (objectUrl && objectUrl !== blobUrl) {
            img.setAttribute('src', objectUrl);
          } else if (!objectUrl) {
            img.setAttribute('alt', '(Image not found)');
            img.style.border = '2px dashed var(--border-color)';
            img.style.padding = '8px';
          }
        }
      });
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

  // Convert blob:// URLs to object URLs for rendering
  useEffect(() => {
    if (!editor) return;

    const convertBlobUrls = async () => {
      const editorElement = editor.view.dom;
      const images = editorElement.querySelectorAll('img[src^="blob://"]');

      for (const element of Array.from(images)) {
        const img = element as HTMLImageElement;
        const blobUrl = img.getAttribute('src');
        if (!blobUrl) continue;

        const objectUrl = await getBlobObjectUrl(blobUrl);
        if (objectUrl && objectUrl !== blobUrl) {
          img.setAttribute('src', objectUrl);
        } else if (!objectUrl) {
          // Show placeholder for missing blobs
          img.setAttribute('alt', '(Image not found)');
          img.style.border = '2px dashed var(--border-color)';
          img.style.padding = '8px';
        }
      }
    };

    // Convert on initial load
    convertBlobUrls();

    // Convert whenever content updates
    const handleUpdate = () => {
      convertBlobUrls();
    };

    editor.on('update', handleUpdate);
    return () => {
      editor.off('update', handleUpdate);
    };
  }, [editor]);

  return (
    <div className={`tiptap-editor ${className ?? ''}`} onContextMenu={handleContextMenu}>
      <EditorContent editor={editor} />
      {contextMenu.isOpen && (
        <DocumentEditorContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={handleCloseContextMenu}
          editor={editor}
        />
      )}
      {spellPopover && editor && (
        <SpellcheckPopover
          editor={editor}
          word={spellPopover.word}
          range={spellPopover.range}
          x={spellPopover.x}
          y={spellPopover.y}
          onClose={() => setSpellPopover(null)}
        />
      )}
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
