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

import { detectFileCategory } from '../utils/fileUtils';
import { getFileTypeLucideIcon } from '../utils/fileTypeIcons';
import { formatFileSize } from '../utils/byteSize';

export interface FileRefOptions {
  HTMLAttributes: Record<string, unknown>;
}

/** The `blob://` URI form the attribute must carry. */
const BLOB_PREFIX = 'blob://';

/** Strip the URI form down to the bare hash, for callers that resolve bytes. */
export function fileRefHash(blobRef: string): string {
  return blobRef.startsWith(BLOB_PREFIX) ? blobRef.slice(BLOB_PREFIX.length) : blobRef;
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
    return ({ node }) => {
      const fileName = (node.attrs['fileName'] as string) ?? '';
      const mimeType = (node.attrs['mimeType'] as string) ?? '';
      const rawSize = (node.attrs['fileSize'] as string) ?? '';

      const dom = document.createElement('span');
      dom.setAttribute('data-file-ref', '');
      dom.className = 'file-ref';
      dom.contentEditable = 'false';
      dom.title = fileName;

      // Derived, never persisted — see the module note.
      const category = detectFileCategory(mimeType, fileName);
      const Icon = getFileTypeLucideIcon(category);

      // lucide-react components are React elements; the chip is plain DOM, so
      // render the icon's SVG shell directly and let CSS size it. Keeping the
      // node view DOM-only avoids mounting a React root per chip in a document
      // that may hold many.
      const iconEl = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      iconEl.setAttribute('class', 'file-ref-icon');
      iconEl.setAttribute('aria-hidden', 'true');
      iconEl.dataset['icon'] = (Icon as { displayName?: string }).displayName ?? category;
      dom.appendChild(iconEl);

      const label = document.createElement('span');
      label.className = 'file-ref-name';
      label.textContent = fileName || 'Attachment';
      dom.appendChild(label);

      const size = Number(rawSize);
      if (Number.isFinite(size) && size > 0) {
        const sizeEl = document.createElement('span');
        sizeEl.className = 'file-ref-size';
        sizeEl.textContent = formatFileSize(size);
        dom.appendChild(sizeEl);
      }

      return { dom };
    };
  },
});
