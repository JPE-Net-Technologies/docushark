/**
 * Figure extension — wraps an image with an editable caption.
 *
 * Two nodes that serialize as standard HTML `<figure><img><figcaption></figure>`:
 *   - `figure`     — block container, `content: 'image figcaption'`.
 *   - `figcaption` — the caption (`inline*`).
 *
 * Figures are opt-in: a bare `<img>` still parses as a plain `image` node, so
 * existing documents are unaffected (no migration). The `toggleImageFigure`
 * command wraps the selected image in a figure (caret lands in the caption) or
 * unwraps it back to a bare image. Auto-numbering ("Figure N") is intentionally
 * deferred to the shared document-outline work (Phase 4) so there's one
 * numbering source feeding the figure label, cross-references, and the TOC —
 * rather than a throwaway counter here.
 *
 * Serialization is sync + standard, so getHTML() → PDF / MCP / offline round-trip
 * the caption losslessly.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import { TextSelection } from '@tiptap/pm/state';
import './FigureExtension.css';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    figure: {
      /** Wrap the selected image in a figure+caption, or unwrap it back. */
      toggleImageFigure: () => ReturnType;
    };
  }
}

export interface FigureOptions {
  HTMLAttributes: Record<string, unknown>;
}

/** The caption line under a figure's image. */
export const Figcaption = Node.create({
  name: 'figcaption',
  content: 'inline*',
  defining: true,

  parseHTML() {
    return [{ tag: 'figcaption' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['figcaption', mergeAttributes(HTMLAttributes, { class: 'prose-figcaption' }), 0];
  },
});

export const Figure = Node.create<FigureOptions>({
  name: 'figure',
  group: 'block',
  content: 'image figcaption',
  draggable: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  parseHTML() {
    return [{ tag: 'figure' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['figure', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { class: 'prose-figure' }), 0];
  },

  addCommands() {
    return {
      toggleImageFigure:
        () =>
        ({ state, dispatch, tr }) => {
          const figureType = state.schema.nodes['figure'];
          const figcaptionType = state.schema.nodes['figcaption'];
          if (!figureType || !figcaptionType) return false;

          const pos = state.selection.from;
          const node = state.doc.nodeAt(pos);
          if (!node || node.type.name !== 'image') return false;
          const $pos = state.doc.resolve(pos);

          // Already inside a figure → unwrap to a bare image (drops the caption).
          if ($pos.parent.type.name === this.name) {
            const figurePos = $pos.before($pos.depth);
            const figureNode = $pos.parent;
            if (dispatch) {
              tr.replaceWith(figurePos, figurePos + figureNode.nodeSize, node);
              dispatch(tr.scrollIntoView());
            }
            return true;
          }

          // Wrap the image in a figure + empty caption; caret into the caption.
          if (dispatch) {
            const figure = figureType.create(null, [node, figcaptionType.create()]);
            tr.replaceWith(pos, pos + node.nodeSize, figure);
            const captionInside = pos + node.nodeSize + 2; // figure open + image + figcaption open
            const sel = TextSelection.near(tr.doc.resolve(Math.min(captionInside, tr.doc.content.size)), 1);
            tr.setSelection(sel).scrollIntoView();
            dispatch(tr);
          }
          return true;
        },
    };
  },
});
