/**
 * Details extension for Tiptap — collapsible toggle sections.
 *
 * Three nodes mirroring HTML <details>/<summary> but rendered as plain `<div>`s
 * with `data-*` attributes (NOT native <details>/<summary>, whose built-in
 * click-to-toggle fights cursor placement when editing the title):
 *   - `details`        — block container, `content: 'detailsSummary detailsContent'`,
 *                        an `open` attribute, and a nodeView with a disclosure
 *                        triangle that toggles `open`.
 *   - `detailsSummary` — the always-visible title (`inline*`).
 *   - `detailsContent` — the collapsible body (`block+`), hidden by CSS when closed.
 *
 * Serialization is sync + div-based so `getHTML()` round-trips losslessly
 * (PDF / MCP / offline) and re-parses cleanly. The disclosure triangle and the
 * `.details-body` wrapper are nodeView-only chrome — never serialized. `open` is
 * an ordinary attribute (a genuine user toggle), so it persists + syncs like any
 * edit; no projection machinery needed.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import './DetailsExtension.css';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    details: {
      /** Insert a collapsible section (titled summary + a body paragraph). */
      insertDetails: () => ReturnType;
      /** Toggle the open/closed state of the details around the selection. */
      toggleDetailsOpen: () => ReturnType;
    };
  }
}

export interface DetailsOptions {
  HTMLAttributes: Record<string, unknown>;
}

/** The collapsible title line. */
export const DetailsSummary = Node.create({
  name: 'detailsSummary',
  content: 'inline*',
  defining: true,
  selectable: false,

  parseHTML() {
    return [{ tag: 'div[data-details-summary]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-details-summary': '', class: 'details-summary' }), 0];
  },
});

/** The collapsible body. */
export const DetailsContent = Node.create({
  name: 'detailsContent',
  content: 'block+',

  parseHTML() {
    return [{ tag: 'div[data-details-content]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return ['div', mergeAttributes(HTMLAttributes, { 'data-details-content': '', class: 'details-content' }), 0];
  },
});

/** The container — summary + content, with an `open` flag and a toggle nodeView. */
export const Details = Node.create<DetailsOptions>({
  name: 'details',
  group: 'block',
  content: 'detailsSummary detailsContent',
  defining: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      open: {
        default: true,
        parseHTML: (el: HTMLElement) =>
          el.hasAttribute('data-open') ? el.getAttribute('data-open') !== 'false' : el.hasAttribute('open'),
        renderHTML: (attrs) => ({ 'data-open': attrs['open'] ? 'true' : 'false' }),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-details]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, { 'data-details': '', class: 'details' }),
      0,
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.className = 'details';
      dom.setAttribute('data-details', '');
      dom.setAttribute('data-open', node.attrs['open'] ? 'true' : 'false');

      // Disclosure triangle — chrome (contentEditable=false), outside contentDOM
      // so it isn't part of the document. Clicking toggles the `open` attr.
      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.className = 'details-toggle';
      toggle.contentEditable = 'false';
      toggle.setAttribute('aria-label', 'Toggle section');
      toggle.addEventListener('mousedown', (e) => e.preventDefault()); // keep selection
      toggle.addEventListener('click', () => {
        if (typeof getPos !== 'function') return;
        const pos = getPos();
        if (pos == null) return;
        const cur = editor.state.doc.nodeAt(pos);
        if (!cur || cur.type.name !== this.name) return;
        editor.view.dispatch(
          editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, open: !cur.attrs['open'] })
        );
      });

      // contentDOM holds the summary + content children.
      const body = document.createElement('div');
      body.className = 'details-body';

      dom.appendChild(toggle);
      dom.appendChild(body);

      return {
        dom,
        contentDOM: body,
        update: (updated) => {
          if (updated.type.name !== this.name) return false;
          dom.setAttribute('data-open', updated.attrs['open'] ? 'true' : 'false');
          return true;
        },
      };
    };
  },

  addCommands() {
    return {
      insertDetails:
        () =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { open: true },
            content: [
              { type: 'detailsSummary', content: [{ type: 'text', text: 'Toggle' }] },
              { type: 'detailsContent', content: [{ type: 'paragraph' }] },
            ],
          }),
      toggleDetailsOpen:
        () =>
        ({ state, dispatch }) => {
          // Walk up from the selection to the enclosing details node.
          const { $from } = state.selection;
          for (let depth = $from.depth; depth > 0; depth--) {
            const node = $from.node(depth);
            if (node.type.name === this.name) {
              if (dispatch) {
                const pos = $from.before(depth);
                dispatch(state.tr.setNodeMarkup(pos, undefined, { ...node.attrs, open: !node.attrs['open'] }));
              }
              return true;
            }
          }
          return false;
        },
    };
  },
});
