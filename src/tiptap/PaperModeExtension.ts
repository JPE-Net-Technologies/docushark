/**
 * Paper Mode's page breaks in the editor (DSK-48).
 *
 * The breaks are decorations, never changes to the document: a widget where
 * each page ends (its footer, the gap between pages and the next page's top
 * margin), a class on a table row that opens a page, and a footer after the
 * last page. They're set from the paginator's layout (`usePaperLayout`) and
 * mapped through edits until the next layout replaces them, a moment after
 * typing pauses.
 */

import { Extension } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { Mappable } from '@tiptap/pm/transform';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import type { BreakPosition } from '../paper/breakPositions';

export const paperModeKey = new PluginKey<PaperState>('paperMode');

/** Where a page ends, and the footer that page prints. */
export interface PageEnd {
  at: BreakPosition;
  footer: string;
}

function part(className: string): HTMLSpanElement {
  const element = document.createElement('span');
  element.className = className;
  return element;
}

/**
 * The gap where a page ends: a spacer that tops the page up to its height,
 * the bottom margin with the footer, then (between pages) the band between
 * the sheets and the next page's top margin.
 */
function gapElement(footer: string, last: boolean): HTMLElement {
  const gap = part(last ? 'paper-gap paper-gap-last' : 'paper-gap');
  gap.setAttribute('contenteditable', 'false');
  gap.setAttribute('aria-hidden', 'true');
  const foot = part('paper-gap-foot');
  const number = part('paper-gap-number');
  number.textContent = footer;
  foot.append(number);
  gap.append(part('paper-gap-spacer'), foot);
  if (!last) gap.append(part('paper-gap-band'), part('paper-gap-head'));
  return gap;
}

/** The page ends Paper Mode shows, and the last page's footer. */
export interface PaperPages {
  ends: PageEnd[];
  lastFooter: string | null;
}

const NO_PAGES: PaperPages = { ends: [], lastFooter: null };

/** The decorations for a layout's page ends in `doc`, and the last page's footer. */
export function paperDecorations(doc: PMNode, ends: PageEnd[], lastFooter: string | null): DecorationSet {
  const decorations: Decoration[] = [];
  ends.forEach((end, index) => {
    if (end.at.kind === 'row') {
      decorations.push(Decoration.node(end.at.pos, end.at.end, { class: 'paper-row-break', 'data-paper-foot': end.footer }));
    } else {
      decorations.push(Decoration.widget(end.at.pos, () => gapElement(end.footer, false), {
        side: -1,
        key: `paper-gap-${index}-${end.footer}`,
        ignoreSelection: true,
      }));
    }
  });
  if (lastFooter !== null) {
    decorations.push(Decoration.widget(doc.content.size, () => gapElement(lastFooter, true), {
      side: 1,
      key: `paper-last-${lastFooter}`,
      ignoreSelection: true,
    }));
  }
  return DecorationSet.create(doc, decorations);
}

/**
 * A page end carried through an edit. A position always maps somewhere (a
 * decoration set would drop a widget whose neighbouring node was replaced,
 * as a block id stamped on an edited paragraph does), so the breaks don't
 * flicker off while typing. A row end stays only while its row does.
 */
function mapEnd(end: PageEnd, mapping: Mappable, doc: PMNode): PageEnd | null {
  if (end.at.kind !== 'row') return { ...end, at: { ...end.at, pos: mapping.map(end.at.pos, -1) } };
  const pos = mapping.map(end.at.pos, 1);
  const row = doc.nodeAt(pos);
  if (!row || row.type.name !== 'tableRow') return null;
  return { ...end, at: { kind: 'row', pos, end: pos + row.nodeSize } };
}

interface PaperState {
  pages: PaperPages;
  decorations: DecorationSet;
}

/** Show these page ends (no ends and no footer clears them). */
export function setPaperPages(view: EditorView, pages: PaperPages): void {
  view.dispatch(view.state.tr.setMeta(paperModeKey, pages).setMeta('addToHistory', false));
}

export const PaperModeExtension = Extension.create({
  name: 'paperMode',

  addProseMirrorPlugins() {
    return [
      new Plugin<PaperState>({
        key: paperModeKey,
        state: {
          init: () => ({ pages: NO_PAGES, decorations: DecorationSet.empty }),
          apply(tr, current) {
            const next = tr.getMeta(paperModeKey) as PaperPages | undefined;
            if (next) return { pages: next, decorations: paperDecorations(tr.doc, next.ends, next.lastFooter) };
            if (!tr.docChanged || (current.pages.ends.length === 0 && current.pages.lastFooter === null)) return current;
            const ends = current.pages.ends
              .map((end) => mapEnd(end, tr.mapping, tr.doc))
              .filter((end): end is PageEnd => end !== null);
            const pages = { ends, lastFooter: current.pages.lastFooter };
            return { pages, decorations: paperDecorations(tr.doc, ends, pages.lastFooter) };
          },
        },
        props: {
          decorations: (state) => paperModeKey.getState(state)?.decorations ?? DecorationSet.empty,
        },
      }),
    ];
  },
});
