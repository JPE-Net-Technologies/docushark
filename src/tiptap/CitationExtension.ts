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

/** Short hover-preview text for a reference (`Author (year). Title`). */
function previewText(item: CSLItem): string {
  const author = item.author?.[0];
  const name = author?.family ?? author?.literal ?? '';
  const year = item.issued?.['date-parts']?.[0]?.[0];
  const parts: string[] = [];
  if (name) parts.push(year ? `${name} (${year})` : name);
  if (item.title) parts.push(item.title);
  return parts.join('. ') || (item.id || 'Reference');
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
          };
        },
      },
    ];
  },

  renderHTML({ node, HTMLAttributes }) {
    const refId = node.attrs['refId'] as string;
    const locator = node.attrs['locator'] as string | null;
    const attrs: Record<string, string> = {
      'data-citation': '',
      'data-ref-id': refId,
      class: 'citation-inline',
    };
    if (locator) attrs['data-locator'] = locator;
    return ['span', mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, attrs)];
  },

  addNodeView() {
    return ({ node }) => {
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
        dom.title = previewText(item);
        const token = ++renderToken;
        if (!dom.textContent) dom.textContent = '…';
        void getFormat()
          .then(({ formatCitation }) => formatCitation([item], style, 'html'))
          .then((html) => {
            if (token !== renderToken) return; // a newer render superseded this
            dom.innerHTML = html || '[?]';
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

  parseHTML() {
    return [{ tag: 'div[data-bibliography]' }];
  },

  renderHTML({ HTMLAttributes }) {
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-bibliography': '',
        class: 'bibliography-block',
      }),
    ];
  },

  addNodeView() {
    return () => {
      const dom = document.createElement('div');
      dom.setAttribute('data-bibliography', '');
      dom.className = 'bibliography-block';
      dom.contentEditable = 'false';

      let renderToken = 0;
      let lastItems: Record<string, CSLItem> | undefined;
      let lastOrderKey = '';
      let lastStyle: CitationStyle | undefined;

      const render = () => {
        const state = useReferenceStore.getState();
        const items = state.listReferences();
        const style = state.activeStyle;
        lastItems = state.items;
        lastOrderKey = state.itemOrder.join(',');
        lastStyle = style;

        if (items.length === 0) {
          dom.innerHTML = '<p class="bibliography-empty">No references yet.</p>';
          return;
        }
        const token = ++renderToken;
        void getFormat()
          .then(({ formatBibliography }) => formatBibliography(items, style))
          .then((html) => {
            if (token !== renderToken) return;
            dom.innerHTML = html || '';
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
