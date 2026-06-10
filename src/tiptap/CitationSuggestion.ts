/**
 * CitationSuggestion — inline `@`-trigger autocomplete for citations (JP-89
 * delight slice).
 *
 * Typing `@` (at a word boundary) in prose opens a small dropdown of the
 * document's references, filtered live by what you type after the `@`; picking
 * one replaces the `@query` token with a `citationInline` node. It is the
 * pandoc-style `@citekey` affordance, the fast path next to the toolbar's
 * "Insert Citation" dialog.
 *
 * Implemented as a hand-rolled ProseMirror suggestion plugin (no
 * `@tiptap/suggestion` / tippy dependency — keeping the AGPL bundle lean, the
 * same reasoning as the relay hand-rolling SigV4 over the AWS SDK). The popup is
 * an imperative DOM element managed by the plugin's `view`, so it works
 * identically in both prose editors (local `TiptapEditor` and the relay
 * `CollaborativeProseEditor`) — they share this extension via
 * `sharedProseExtensions`. References are read live from `referenceStore`, the
 * same source the citation nodeViews render from.
 */

import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import type { CSLItem } from '../types/Citation';
import { useReferenceStore } from '../store/referenceStore';
import { referencePreview } from '../services/citations/preview';
import './CitationSuggestion.css';

/** Max rows shown in the dropdown (the filtered library can be large). */
const MAX_RESULTS = 8;

/** Plugin state. `from === null` means inactive. */
interface SuggestionState {
  /** Doc position of the trigger `@`, or `null` when inactive. */
  from: number | null;
  /** Doc position of the caret (end of the `@query` token). */
  to: number;
  /** The query typed after `@` (may be empty). */
  query: string;
  /** Highlighted row index into the filtered results. */
  index: number;
  /** True once the user dismissed (Escape) this token — stays closed until it changes. */
  closed: boolean;
}

type SuggestionMeta = { type: 'move'; dir: 1 | -1 } | { type: 'close' };

const INACTIVE: SuggestionState = { from: null, to: 0, query: '', index: 0, closed: false };

export const citationSuggestionKey = new PluginKey<SuggestionState>('citationSuggestion');

/**
 * Match a citation trigger at the end of the text preceding the caret. The
 * trigger is an `@` at a word boundary (start of block, or after whitespace /
 * an opening bracket), followed by the query (no whitespace, no second `@`).
 * Returns the query and the offset of the `@` within `textBefore`, or `null`.
 *
 * Exported for unit testing — the rest of the plugin is DOM/PM-coupled.
 */
export function matchCitationTrigger(textBefore: string): { query: string; from: number } | null {
  // `(?:^|[\s(\[])` — `@` must open a token, so it won't fire inside an email.
  const m = /(?:^|[\s([])@([^\s@]*)$/.exec(textBefore);
  if (!m) return null;
  const query = m[1] ?? '';
  // `m.index` points at the boundary char (or -1-ish at string start); the `@`
  // sits at the end of the matched prefix, i.e. matchEnd - query.length - 1.
  const from = m.index + m[0].length - query.length - 1;
  return { query, from };
}

/** Filter the library by `query` (matched against the shared preview label). */
export function filterReferences(items: CSLItem[], query: string, limit = MAX_RESULTS): CSLItem[] {
  const q = query.trim().toLowerCase();
  const matched = q
    ? items.filter((r) => referencePreview(r).toLowerCase().includes(q) || r.id.toLowerCase().includes(q))
    : items;
  return matched.slice(0, limit);
}

function listReferences(): CSLItem[] {
  return useReferenceStore.getState().listReferences();
}

/** The references currently offered for `state` (empty when inactive). */
function resultsFor(state: SuggestionState): CSLItem[] {
  if (state.from === null || state.closed) return [];
  return filterReferences(listReferences(), state.query);
}

/**
 * Commit the highlighted (or explicitly given) reference: replace the `@query`
 * token with a `citationInline` node. Returns true when a citation was
 * inserted. Shared by the Enter/Tab keybinding and the popup's click handler.
 */
export function commitActiveSuggestion(view: EditorView, refId?: string): boolean {
  const state = citationSuggestionKey.getState(view.state);
  if (!state || state.from === null) return false;
  const citation = view.state.schema.nodes['citationInline'];
  if (!citation) return false;

  const results = resultsFor(state);
  const chosen = refId ?? results[state.index]?.id;
  if (!chosen) return false;

  const node = citation.create({ refId: chosen, locator: null });
  const tr = view.state.tr.replaceWith(state.from, state.to, node);
  tr.setMeta(citationSuggestionKey, { type: 'close' } satisfies SuggestionMeta);
  view.dispatch(tr);
  view.focus();
  return true;
}

function citationSuggestionPlugin(): Plugin<SuggestionState> {
  return new Plugin<SuggestionState>({
    key: citationSuggestionKey,

    state: {
      init: () => INACTIVE,
      apply(tr, value, _old, newState): SuggestionState {
        const meta = tr.getMeta(citationSuggestionKey) as SuggestionMeta | undefined;
        if (meta?.type === 'move') {
          if (value.from === null) return value;
          const len = resultsFor(value).length;
          if (len === 0) return value;
          return { ...value, index: (value.index + meta.dir + len) % len };
        }
        if (meta?.type === 'close') {
          return value.from === null ? value : { ...value, closed: true };
        }

        // Recompute the active token from the caret position.
        const sel = newState.selection;
        if (!sel.empty || !sel.$from.parent.isTextblock) return INACTIVE;
        const $from = sel.$from;
        // Inline atoms (e.g. an existing citation) count as one placeholder char
        // so positions stay aligned with the text offsets we match against.
        const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '\uFFFC');
        const match = matchCitationTrigger(textBefore);
        if (!match) return INACTIVE;

        const from = $from.start() + match.from;
        const to = sel.from;
        // Same token as before → preserve the user's dismissal + highlight.
        if (value.from === from && value.query === match.query) {
          return { ...value, from, to };
        }
        return { from, to, query: match.query, index: 0, closed: false };
      },
    },

    props: {
      handleKeyDown(view, event) {
        const state = citationSuggestionKey.getState(view.state);
        if (!state || state.from === null || state.closed) return false;
        if (event.key === 'Escape') {
          view.dispatch(view.state.tr.setMeta(citationSuggestionKey, { type: 'close' } satisfies SuggestionMeta));
          return true;
        }
        // Only capture navigation/commit keys when there's something to pick.
        if (resultsFor(state).length === 0) return false;
        if (event.key === 'ArrowDown') {
          view.dispatch(view.state.tr.setMeta(citationSuggestionKey, { type: 'move', dir: 1 } satisfies SuggestionMeta));
          return true;
        }
        if (event.key === 'ArrowUp') {
          view.dispatch(view.state.tr.setMeta(citationSuggestionKey, { type: 'move', dir: -1 } satisfies SuggestionMeta));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          return commitActiveSuggestion(view);
        }
        return false;
      },
    },

    view: (editorView) => new SuggestionPopup(editorView),
  });
}

/** Imperative dropdown rendered next to the caret while a trigger is active. */
class SuggestionPopup {
  private readonly dom: HTMLDivElement;
  private rendered = '';

  constructor(private readonly view: EditorView) {
    this.dom = document.createElement('div');
    this.dom.className = 'citation-suggest';
    this.dom.style.display = 'none';
    // Keep the editor selection on mousedown so a click doesn't blur/collapse.
    this.dom.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.appendChild(this.dom);
    this.update();
  }

  update(): void {
    const state = citationSuggestionKey.getState(this.view.state);
    const results = state ? resultsFor(state) : [];
    if (!state || state.from === null || results.length === 0) {
      this.hide();
      return;
    }
    // Cheap render gate: rebuild only when the visible set/selection changes.
    const signature = `${state.index}|${results.map((r) => r.id).join(',')}`;
    if (signature !== this.rendered) {
      this.renderList(results, state.index);
      this.rendered = signature;
    }
    this.position(state.from);
  }

  private renderList(results: CSLItem[], index: number): void {
    this.dom.replaceChildren();
    results.forEach((ref, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = i === index ? 'citation-suggest-item is-active' : 'citation-suggest-item';
      row.textContent = referencePreview(ref);
      row.addEventListener('click', () => commitActiveSuggestion(this.view, ref.id));
      this.dom.appendChild(row);
    });
    this.dom.style.display = 'block';
  }

  private position(from: number): void {
    try {
      const coords = this.view.coordsAtPos(from);
      this.dom.style.left = `${Math.round(coords.left)}px`;
      this.dom.style.top = `${Math.round(coords.bottom + 4)}px`;
    } catch {
      // coordsAtPos can throw mid-transaction for a stale position; the next
      // update repositions, so just keep the popup where it is.
    }
  }

  private hide(): void {
    if (this.dom.style.display !== 'none') {
      this.dom.style.display = 'none';
      this.rendered = '';
    }
  }

  destroy(): void {
    this.dom.remove();
  }
}

/**
 * Tiptap extension wrapper. Added to `sharedProseExtensions` so both prose
 * editors get the `@` trigger; requires the `citationInline` node (also shared)
 * to be present in the schema.
 */
export const CitationSuggestion = Extension.create({
  name: 'citationSuggestion',
  addProseMirrorPlugins() {
    return [citationSuggestionPlugin()];
  },
});
