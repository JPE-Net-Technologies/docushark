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
import { useRichTextStore } from '../store/richTextStore';
import { blobStorage } from '../storage/BlobStorage';
import { EmbeddedGroup } from '../tiptap/EmbeddedGroupExtension';
import { ResizableImage } from '../tiptap/ResizableImageExtension';
import { MathInline, MathBlock } from '../tiptap/LatexExtension';
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
    codeBlock: false,
  }),
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

  const editor = useEditor({
    extensions,
    content: content.content,
    onUpdate: ({ editor }) => {
      setContent(editor.getJSON());
    },
    editorProps: {
      attributes: {
        class: 'tiptap-prose',
      },
    },
  });

  // Handle context menu
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setContextMenu({
      isOpen: true,
      x: e.clientX,
      y: e.clientY,
    });
  }, []);

  const handleCloseContextMenu = useCallback(() => {
    setContextMenu((prev) => ({ ...prev, isOpen: false }));
  }, []);

  // Update editor content when loaded from document
  useEffect(() => {
    if (editor && content.content) {
      // Only update if content is different to avoid cursor jump
      const currentContent = JSON.stringify(editor.getJSON());
      const newContent = JSON.stringify(content.content);
      if (currentContent !== newContent) {
        editor.commands.setContent(content.content);

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
      }
    }
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
