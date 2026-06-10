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
import { PROSE_PROJECTION_META } from './proseProjection';
import { isAutoSaveSuppressed } from '../store/autoSaveGuard';
import { showCitationCard, hideCitationCard } from './citationHoverCard';

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

  // Each attribute owns its `data-*` serialization (parse + render) so getHTML
  // emits ONLY clean `data-*` attributes — no bare `refid`/`label` leak from
  // Tiptap's default attribute rendering, and no reserved attribute names. This
  // is the robust round-trip shape for custom prose nodes ("prose helpers").
  addAttributes() {
    return {
      refId: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-ref-id') ?? '',
        renderHTML: (attrs) => (attrs['refId'] ? { 'data-ref-id': String(attrs['refId']) } : {}),
      },
      locator: {
        default: null,
        parseHTML: (el: HTMLElement) => el.getAttribute('data-locator'),
        renderHTML: (attrs) => (attrs['locator'] ? { 'data-locator': String(attrs['locator']) } : {}),
      },
      // Cached formatted in-text citation (the "projection"): renderHTML is sync
      // but formatting is async, so the nodeView writes the formatted text back
      // here (JP-89 slice 5.5) — making getHTML()/PDF/MCP/offline self-contained.
      label: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-label') ?? '',
        renderHTML: (attrs) => (attrs['label'] ? { 'data-label': String(attrs['label']) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-citation]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const label = (node.attrs['label'] as string) ?? '';
    // Emit the cached label as the text child too, so static HTML consumers show
    // it; the editor re-derives it live. `data-*` attrs come from addAttributes.
    return [
      'span',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-citation': '',
        class: 'citation-inline',
      }),
      label,
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('span');
      dom.setAttribute('data-citation', '');
      dom.className = 'citation-inline';
      dom.contentEditable = 'false';
      // Paint the cached label immediately (JP-89 5.5) so an already-formatted
      // citation shows instantly on reload — no dependence on the async format
      // chunk loading every time (resilient to offline / a stale service worker).
      if (node.attrs['label']) dom.textContent = node.attrs['label'] as string;

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
        if (isAutoSaveSuppressed()) return; // never dispatch during load/new/switch
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos == null) return;
        const cur = editor.state.doc.nodeAt(pos);
        // type AND refId match → never write a label onto a different citation
        // if `pos` went stale between format start and this resolve.
        if (!cur || cur.type.name !== this.name || cur.attrs['refId'] !== refId) return;
        if (cur.attrs['label'] === label) return; // idempotent → loop-safe
        const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, label });
        tr.setMeta('addToHistory', false); // keep label-sync out of undo
        tr.setMeta(PROSE_PROJECTION_META, true); // derived write → mirror silently, no autosave
        editor.view.dispatch(tr);
      };

      const render = () => {
        const state = useReferenceStore.getState();
        const item = state.getReference(refId);
        const style = state.activeStyle;
        lastItem = item;
        lastStyle = style;

        if (!item) {
          dom.title = 'Missing reference';
          // Keep an already-painted cached label as a fallback (ref not loaded
          // yet, or offline); only show [?] when we have nothing to show.
          if (!dom.textContent || dom.textContent === '…') dom.textContent = '[?]';
          return;
        }
        dom.title = referencePreview(item);
        const token = ++renderToken;
        if (!dom.textContent || dom.textContent === '[?]') dom.textContent = '…';
        void getFormat()
          .then(({ formatCitation }) => formatCitation([item], style, 'html'))
          .then((html) => {
            if (token !== renderToken) return; // a newer render superseded this
            dom.innerHTML = html || '[?]';
            writeBackLabel(dom.textContent ?? '');
          })
          .catch((err) => {
            if (token !== renderToken) return;
            // Don't hang on the loading placeholder — surface the failure and
            // degrade to a readable fallback (the cite key in brackets).
            console.error('[citations] inline citation render failed:', err);
            dom.textContent = `[${refId}]`;
          });
      };

      applyAttrs();
      render();

      // Hover preview: after a short dwell, show a card with the full formatted
      // reference (the bibliography-style entry). A small delay avoids flashing
      // it while the pointer just passes over the citation.
      let hoverTimer: number | undefined;
      const onEnter = () => {
        window.clearTimeout(hoverTimer);
        hoverTimer = window.setTimeout(() => {
          const state = useReferenceStore.getState();
          const item = state.getReference(refId);
          if (item) showCitationCard(dom, item, state.activeStyle);
        }, 220);
      };
      const onLeave = () => {
        window.clearTimeout(hoverTimer);
        hideCitationCard();
      };
      dom.addEventListener('mouseenter', onEnter);
      dom.addEventListener('mouseleave', onLeave);

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
        destroy: () => {
          window.clearTimeout(hoverTimer);
          hideCitationCard();
          dom.removeEventListener('mouseenter', onEnter);
          dom.removeEventListener('mouseleave', onLeave);
          unsubscribe();
        },
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

  // Cached rendered bibliography HTML lives in a self-describing `data-bib-html`
  // attribute (NOT a node named `content` — that's a reserved ProseMirror schema
  // keyword — and NOT child markup, which forced a fragile DOM-node renderHTML).
  // The node serializes as a clean, childless `<div data-bibliography
  // data-bib-html="…">` that round-trips losslessly everywhere (JP-89 5.5).
  addAttributes() {
    return {
      bibHtml: {
        default: '',
        parseHTML: (el: HTMLElement) => el.getAttribute('data-bib-html') ?? '',
        renderHTML: (attrs) => (attrs['bibHtml'] ? { 'data-bib-html': String(attrs['bibHtml']) } : {}),
      },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-bibliography]' }];
  },

  renderHTML({ HTMLAttributes }) {
    // Childless, array-form — robust serialization. The cached HTML rides the
    // `data-bib-html` attribute (from addAttributes); the nodeView / preview /
    // PDF read it to render the visible reference list.
    return [
      'div',
      mergeAttributes(this.options.HTMLAttributes, HTMLAttributes, {
        'data-bibliography': '',
        class: 'bibliography-block',
      }),
    ];
  },

  addNodeView() {
    return ({ node, getPos, editor }) => {
      const dom = document.createElement('div');
      dom.setAttribute('data-bibliography', '');
      dom.className = 'bibliography-block';
      dom.contentEditable = 'false';
      // Paint the cached bibliography HTML immediately (JP-89 5.5) so it shows on
      // reload without waiting on the async format chunk (offline-safe).
      if (node.attrs['bibHtml']) dom.innerHTML = node.attrs['bibHtml'] as string;

      let renderToken = 0;
      let lastItems: Record<string, CSLItem> | undefined;
      let lastOrderKey = '';
      let lastStyle: CitationStyle | undefined;

      // Persist the rendered bibliography HTML into the node's `bibHtml` attr so
      // non-editor consumers are self-contained. Same safety as CitationInline:
      // idempotent, editable-only, out of undo, runs post-update.
      const writeBackContent = (rawHtml: string) => {
        if (!editor.isEditable) return;
        if (isAutoSaveSuppressed()) return; // never dispatch during load/new/switch
        // Newlines → spaces: keep the persisted attribute value single-line and
        // robust across serializers (citeproc emits newlines between entries).
        const bibHtml = rawHtml.replace(/[\r\n]+/g, ' ');
        const pos = typeof getPos === 'function' ? getPos() : undefined;
        if (pos == null) return;
        const cur = editor.state.doc.nodeAt(pos);
        if (!cur || cur.type.name !== this.name) return;
        if (cur.attrs['bibHtml'] === bibHtml) return;
        const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, bibHtml });
        tr.setMeta('addToHistory', false);
        tr.setMeta(PROSE_PROJECTION_META, true); // derived write → mirror silently, no autosave
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
          })
          .catch((err) => {
            if (token !== renderToken) return;
            console.error('[citations] bibliography render failed:', err);
            // Keep any cached content already painted; only show a notice if blank.
            if (!dom.innerHTML) {
              dom.innerHTML = '<p class="bibliography-empty">Could not render bibliography.</p>';
            }
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
