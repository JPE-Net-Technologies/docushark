/**
 * Citation extensions for Tiptap (JP-89 slice 4).
 *
 * Two nodes that render live from the per-document reference library
 * (`referenceStore`) in the document's active style:
 *   - `CitationInline` — an inline atom holding a `refId` (+ optional locator),
 *     rendered as the formatted in-text citation, e.g. `(Smith, 2020)`.
 *   - `Bibliography` — a block atom rendering the full reference list.
 *
 * Modelled on `LatexExtension.ts` (atom node + `nodeView`), but the render is
 * **async** (the CSL engine in `services/citations/format.ts` is lazy-loaded)
 * and **reactive** to `referenceStore` (a store subscription re-renders the
 * node's DOM when its data or the active style changes). The formatter is
 * dynamically imported inside the nodeView so citation-js + the vendored CSL
 * XML only load when a citation actually renders — never just from opening the
 * editor.
 *
 * Note (see plan "Known limitation"): `renderHTML` is synchronous, so the
 * persisted HTML (`getHTML()` → richTextPages / PDF / MCP reads) carries the
 * `refId` structurally but not the formatted text; the nodeView recomputes that
 * on open. The reference library is the single source of truth — no data loss.
 */

import { Node, mergeAttributes } from '@tiptap/core';
import type { CSLItem, CitationStyle } from '../types/Citation';
import { useReferenceStore } from '../store/referenceStore';
import { referencePreview } from '../services/citations/preview';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    citation: {
      /** Insert an inline citation referencing `refId` (optional page/locator). */
      setCitation: (refId: string, locator?: string) => ReturnType;
    };
    bibliography: {
      /** Insert a bibliography block (renders the whole reference list). */
      insertBibliography: () => ReturnType;
    };
  }
}

export interface CitationOptions {
  HTMLAttributes: Record<string, unknown>;
}

/** Lazy-load the formatter (citation-js + vendored CSL XML) on first render. */
type FormatModule = typeof import('../services/citations/format');
let formatModule: Promise<FormatModule> | null = null;
function getFormat(): Promise<FormatModule> {
  if (!formatModule) {
    formatModule = import('../services/citations/format');
  }
  return formatModule;
}

/**
 * Inline citation node — `[refId]` rendered as the formatted in-text citation.
 */
export const CitationInline = Node.create<CitationOptions>({
  name: 'citationInline',
  group: 'inline',
  inline: true,
  atom: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      refId: { default: '' },
      locator: { default: null },
      // Cached formatted in-text citation (the "projection"): renderHTML is sync
      // but formatting is async, so the nodeView writes the formatted text back
      // here (JP-89 slice 5.5) — making getHTML()/PDF/MCP/offline self-contained.
      label: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'span[data-citation]',
        getAttrs: (el) => {
          const node = el as HTMLElement;
          return {
            refId: node.getAttribute('data-ref-id') ?? '',
            locator: node.getAttribute('data-locator') ?? null,
            label: node.getAttribute('data-label') ?? '',
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const refId = node.attrs['refId'] as string;
    const locator = node.attrs['locator'] as string | null;
    const label = (node.attrs['label'] as string) ?? '';
    const attrs: Record<string, string> = {
      'data-citation': '',
      'data-ref-id': refId,
      class: 'citation-inline',
    };
    if (locator) attrs['data-locator'] = locator;
    if (label) attrs['data-label'] = label;
    // Emit the cached label as the text child so non-editor consumers
    // (PDF / MCP / offline) are self-contained; the editor re-derives it live.
    return ['span', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, attrs), label];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('span');
      dom.setAttribute('data-citation', '');
      dom.className = 'citation-inline';
      dom.contentEditable = 'false';

      let refId = node.attrs['refId'] as string;
      let locator = node.attrs['locator'] as string | null;
      let renderToken = 0;
      let lastItem: CSLItem | undefined;
      let lastStyle: CitationStyle | undefined;

      const applyAttrs = () => {
        dom.setAttribute('data-ref-id', refId);
        if (locator) dom.setAttribute('data-locator', locator);
        else dom.removeAttribute('data-locator');
      };

      // Persist the formatted text into the node's `label` attr so the HTML
      // projection (getHTML → PDF / MCP / offline) is self-contained. Runs in an
      // async microtask after the PM update (never "dispatch during dispatch").
      const writeBackLabel = (label: string) => {
        if (!editor.isEditable) return; // view-only clients never dirty the doc
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos == null) return;
        const cur = editor.state.doc.nodeAt(pos);
        // type AND refId match → never write a label onto a different citation
        // if `pos` went stale between format start and this resolve.
        if (!cur || cur.type.name !== this.name || cur.attrs['refId'] !== refId) return;
        if (cur.attrs['label'] === label) return; // idempotent → loop-safe
        const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, label });
        tr.setMeta('addToHistory', false); // keep label-sync out of undo
        editor.view.dispatch(tr);
      };

      const render = () => {
        const state = useReferenceStore.getState();
        const item = state.getReference(refId);
        const style = state.activeStyle;
        lastItem = item;
        lastStyle = style;

        if (!item) {
          dom.textContent = '[?]';
          dom.title = 'Missing reference';
          return;
        }
        dom.title = referencePreview(item);
        const token = ++renderToken;
        if (!dom.textContent) dom.textContent = '…';
        void getFormat()
          .then(({ formatCitation }) => formatCitation([item], style, 'html'))
          .then((html) => {
            if (token !== renderToken) return; // a newer render superseded this
            dom.innerHTML = html || '[?]';
            writeBackLabel(dom.textContent ?? '');
          });
      };

      applyAttrs();
      render();

      const unsubscribe = useReferenceStore.subscribe((state) => {
        if (state.getReference(refId) !== lastItem || state.activeStyle !== lastStyle) {
          render();
        }
      });

      return {
        dom,
        update: (updatedNode) => {
          if (updatedNode.type.name !== this.name) return false;
          const newRefId = updatedNode.attrs['refId'] as string;
          const newLocator = updatedNode.attrs['locator'] as string | null;
          if (newRefId !== refId || newLocator !== locator) {
            refId = newRefId;
            locator = newLocator;
            applyAttrs();
            render();
          }
          return true;
        },
        destroy: () => unsubscribe(),
      };
    };
  },

  addCommands() {
    return {
      setCitation:
        (refId: string, locator?: string) =>
        ({ commands }) =>
          commands.insertContent({
            type: this.name,
            attrs: { refId, locator: locator ?? null },
          }),
    };
  },
});

/**
 * Bibliography block — renders the document's full reference list in the active
 * style. Reads everything from the store (no node attributes).
 */
export const Bibliography = Node.create<CitationOptions>({
  name: 'bibliography',
  group: 'block',
  atom: true,

  addOptions() {
    return { HTMLAttributes: {} };
  },

  addAttributes() {
    return {
      // Cached rendered bibliography HTML (the "projection") so getHTML() / PDF /
      // MCP / offline are self-contained — see CitationInline.label (JP-89 5.5).
      content: { default: '' },
    };
  },

  parseHTML() {
    return [
      {
        tag: 'div[data-bibliography]',
        getAttrs: (el) => ({ content: (el as HTMLElement).innerHTML }),
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    // Return a real DOM element so the cached HTML serializes as child markup
    // (the array form would escape it). getHTML/generateJSON always run with a
    // DOM present (browser/jsdom); the relay is Rust and never runs this.
    const div = document.createElement('div');
    const attrs = mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
      'data-bibliography': '',
      class: 'bibliography-block',
    });
    for (const [k, v] of Object.entries(attrs)) {
      if (v != null) div.setAttribute(k, String(v));
    }
    div.innerHTML = (node.attrs['content'] as string) ?? '';
    return div;
  },

  addNodeView() {
    return ({ getPos, editor }) => {
      const dom = document.createElement('div');
      dom.setAttribute('data-bibliography', '');
      dom.className = 'bibliography-block';
      dom.contentEditable = 'false';

      let renderToken = 0;
      let lastItems: Record<string, CSLItem> | undefined;
      let lastOrderKey = '';
      let lastStyle: CitationStyle | undefined;

      // Persist the rendered bibliography HTML into the node's `content` attr so
      // non-editor consumers are self-contained. Same safety as CitationInline:
      // idempotent, editable-only, out of undo, runs post-update.
      const writeBackContent = (content: string) => {
        if (!editor.isEditable) return;
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos == null) return;
        const cur = editor.state.doc.nodeAt(pos);
        if (!cur || cur.type.name !== this.name) return;
        if (cur.attrs['content'] === content) return;
        const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, content });
        tr.setMeta('addToHistory', false);
        editor.view.dispatch(tr);
      };

      const render = () => {
        const state = useReferenceStore.getState();
        const items = state.listReferences();
        const style = state.activeStyle;
        lastItems = state.items;
        lastOrderKey = state.itemOrder.join(',');
        lastStyle = style;

        if (items.length === 0) {
          const empty = '<p class="bibliography-empty">No references yet.</p>';
          dom.innerHTML = empty;
          writeBackContent(empty);
          return;
        }
        const token = ++renderToken;
        void getFormat()
          .then(({ formatBibliography }) => formatBibliography(items, style))
          .then((html) => {
            if (token !== renderToken) return;
            dom.innerHTML = html || '';
            writeBackContent(dom.innerHTML);
          });
      };

      render();

      const unsubscribe = useReferenceStore.subscribe((state) => {
        if (
          state.items !== lastItems ||
          state.activeStyle !== lastStyle ||
          state.itemOrder.join(',') !== lastOrderKey
        ) {
          render();
        }
      });

      return {
        dom,
        update: (updatedNode) => updatedNode.type.name === this.name,
        destroy: () => unsubscribe(),
      };
    };
  },

  addCommands() {
    return {
      insertBibliography:
        () =>
        ({ commands }) =>
          commands.insertContent({ type: this.name }),
    };
  },
});
