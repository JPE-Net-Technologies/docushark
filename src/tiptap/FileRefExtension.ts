/**
 * Inline file chip (JP-495) — an attached file referenced from prose.
 *
 * Inline rather than block so it composes inside a table cell and mid-sentence.
 * That is also what import fidelity needs: a provider's file block can sit
 * anywhere, and a block-level node would flatten that placement.
 *
 * The blob is addressed in **`blob://<hash>` URI form**, never a bare hash.
 * Blob references are discovered by exactly two shapes — a bare hash under a
 * key literally named `blobRef`, or the `blob://` grammar inside a string — and
 * an HTML attribute is inside a string, so only the URI form is discoverable.
 * Store a bare hash and the blob is invisible to the reference walk, the
 * publish manifest, and the MCP file tools, none of which fail loudly; the
 * bytes are simply swept later (JP-494).
 *
 * `fileCategory` is deliberately NOT an attribute — `detectFileCategory` derives
 * it from the mime + filename, and persisting derived state invites it drifting
 * out of step with the mime it came from.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { ReactNodeViewRenderer } from '@tiptap/react';

import { FileRefChip } from '../ui/FileRefChip';

export interface FileRefOptions {
  HTMLAttributes: Record<string, unknown>;
}

/**
 * What a chip stores. `blobRef` is the **`blob://<hash>` URI form**, never a
 * bare hash — the attribute lives inside an HTML string, and only that grammar
 * is discoverable by the blob reference walk (JP-494). `fileSize` is a string
 * because it arrives as an HTML attribute and the relay stores PM attrs as
 * strings; parsing it here would make an editor-written node differ from a
 * relay-written one on every flatten.
 */
export interface FileRefAttrs {
  blobRef: string;
  fileName: string;
  mimeType: string;
  fileSize: string;
}

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    fileRef: {
      /** Insert an inline file chip at the current selection. */
      insertFileRef: (attrs: FileRefAttrs) => ReturnType;
    };
  }
}

/**
 * Inline file node — renders as a chip showing the file's type icon, name, and
 * size.
 */
export const FileRef = Node.create<FileRefOptions>({
  name: 'fileRef',
  group: 'inline',
  inline: true,
  atom: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  // Each attribute owns its `data-*` serialization so getHTML emits only clean
  // `data-*` attributes — the same round-trip shape as FieldRef/CitationInline,
  // and the shape the relay's `file_ref_html` writes. Optional attributes are
  // omitted when empty rather than emitted blank, so an editor-written node and
  // a relay-written one are byte-identical.
  addAttributes() {
    return {
      blobRef: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-blob-ref') ?? '',
        renderHTML: (attrs) =>
          attrs['blobRef'] ? { 'data-blob-ref': String(attrs['blobRef']) } : {},
      },
      fileName: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-file-name') ?? '',
        renderHTML: (attrs) =>
          attrs['fileName'] ? { 'data-file-name': String(attrs['fileName']) } : {},
      },
      mimeType: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-mime-type') ?? '',
        renderHTML: (attrs) =>
          attrs['mimeType'] ? { 'data-mime-type': String(attrs['mimeType']) } : {},
      },
      // Kept as a string end-to-end: it arrives as an HTML attribute and the
      // relay stores PM attrs as strings, so parsing to a number here would make
      // an editor-written node differ from a relay-written one on every flatten.
      fileSize: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-file-size') ?? '',
        renderHTML: (attrs) =>
          attrs['fileSize'] ? { 'data-file-size': String(attrs['fileSize']) } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-file-ref]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const fileName = (node.attrs['fileName'] as string) ?? '';
    // The filename is also the text child, copying FieldRef's degradation
    // contract: a consumer that doesn't understand the node still shows
    // something a reader can use rather than nothing.
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-file-ref': '',
        class: 'file-ref',
      }),
      fileName,
    ];
  },

  addNodeView() {
    return ReactNodeViewRenderer(FileRefChip);
  },

  addCommands() {
    return {
      /**
       * Insert a file chip at the selection. One transaction, so undo removes
       * the chip in a single step.
       */
      insertFileRef:
        (attrs: FileRefAttrs) =>
        ({ commands }) => {
          // `insertContent` leaves the caret AFTER the inserted node, which is
          // what lets a writer keep typing mid-sentence — the whole reason this
          // node is inline rather than a block.
          return commands.insertContent({ type: this.name, attrs });
        },
    };
  },
});
