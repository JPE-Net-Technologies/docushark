/**
 * Paper Mode's page breaks in the editor (DSK-48).
 *
 * The breaks are decorations, never changes to the document: an empty widget
 * where each page ends, holding the room for the rest of the page, its bottom
 * margin, the gap between the sheets and the next page's top margin; a mark on
 * a table row that opens a page, whose cells make the same room; and a widget
 * after the last page for its bottom margin. Each says which page it ends and
 * that page's footer. `fitPages` (`src/paper/paperLayout.ts`) sizes the room
 * and draws the gaps and footers over it. The breaks are set from the
 * paginator's layout (`usePaperLayout`) and mapped through edits until the
 * next layout replaces them, a moment after typing pauses.
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

/** The CSS variable holding the room left at the end of page end `index` (`fitPages` sets it). */
export function paperSpaceVariable(index: number | 'last'): string {
  return `--paper-space-${index}`;
}

/**
 * The room where a page ends: what's left of the page, then (`--paper-gap`) its
 * bottom margin, the gap between the sheets and the next page's top margin. The
 * last page's has only its bottom margin (`--paper-foot`).
 */
function gapElement(index: number | 'last', footer: string): HTMLElement {
  const gap = document.createElement('span');
  gap.className = index === 'last' ? 'paper-gap paper-gap-last' : 'paper-gap';
  gap.setAttribute('contenteditable', 'false');
  gap.setAttribute('aria-hidden', 'true');
  gap.dataset['paperIndex'] = String(index);
  gap.dataset['paperFoot'] = footer;
  gap.style.height = `calc(var(${paperSpaceVariable(index)}, 0px) + var(${index === 'last' ? '--paper-foot' : '--paper-gap'}))`;
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
      decorations.push(Decoration.node(end.at.pos, end.at.end, {
        class: 'paper-row-break',
        'data-paper-index': String(index),
        'data-paper-foot': end.footer,
        style: `--paper-row-space: var(${paperSpaceVariable(index)}, 0px)`,
      }));
    } else {
      decorations.push(Decoration.widget(end.at.pos, () => gapElement(index, end.footer), {
        side: -1,
        key: `paper-gap-${index}-${end.footer}`,
        ignoreSelection: true,
      }));
    }
  });
  if (lastFooter !== null) {
    decorations.push(Decoration.widget(doc.content.size, () => gapElement('last', lastFooter), {
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
