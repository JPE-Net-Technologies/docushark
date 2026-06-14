/**
 * triggerPlugin — a reusable inline character-trigger autocomplete for prose.
 *
 * This is the generalized core of `CitationSuggestion.ts` (the `@`-cite popup):
 * a hand-rolled ProseMirror suggestion plugin (no `@tiptap/suggestion` / tippy
 * dependency — keeping the AGPL bundle lean) that watches the text before the
 * caret, and when a configured trigger token is present, shows an imperative
 * dropdown of items with keyboard nav, committing the highlighted item back into
 * the document. The popup is a plain DOM element managed by the plugin's `view`,
 * so it works identically in both prose editors (local `TiptapEditor` and the
 * relay `CollaborativeProseEditor`) when shared via `sharedProseExtensions`.
 *
 * Everything trigger-specific (the match regex, the item source, how a row
 * renders, and how a chosen item is inserted) is injected via `TriggerPluginConfig`
 * so a single, tested mechanism backs the `/` slash menu and the Fields `{{`
 * trigger without copy-paste. `CitationSuggestion` predates this and keeps its own
 * copy for now; it can migrate onto this factory later.
 */

import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';

/** A trigger match: the query typed after the trigger char + the char's offset. */
export interface TriggerMatch {
  query: string;
  /** Offset of the trigger char within the matched `textBefore`. */
  from: number;
}

/** Document range of the active trigger token (the char + its query). */
export interface TriggerRange {
  from: number;
  to: number;
}

/** Plugin state. `from === null` means inactive. */
export interface TriggerState {
  /** Doc position of the trigger char, or `null` when inactive. */
  from: number | null;
  /** Doc position of the caret (end of the trigger token). */
  to: number;
  /** The query typed after the trigger char (may be empty). */
  query: string;
  /** Highlighted row index into the current results. */
  index: number;
  /** True once the user dismissed (Escape) this token — stays closed until it changes. */
  closed: boolean;
}

type TriggerMeta = { type: 'move'; dir: 1 | -1 } | { type: 'close' };

const INACTIVE: TriggerState = { from: null, to: 0, query: '', index: 0, closed: false };

/** Default number of rows shown in the dropdown. */
const DEFAULT_MAX_RESULTS = 8;

export interface TriggerPluginConfig<T> {
  /** Unique plugin key — one per trigger (so multiple triggers can coexist). */
  pluginKey: PluginKey<TriggerState>;
  /** CSS class applied to the popup container. */
  popupClass: string;
  /** Max rows shown (defaults to 8). */
  maxResults?: number;
  /**
   * Match the trigger token at the END of the text preceding the caret. Return
   * the query and the trigger char's offset within `textBefore`, or `null` when
   * no trigger is active. Pure + exported per-trigger for unit testing.
   */
  match(textBefore: string): TriggerMatch | null;
  /** The items offered for `query` (the factory also slices to `maxResults`). */
  getItems(query: string): T[];
  /** Stable key per item — used to cheaply gate popup re-renders. */
  rowKey(item: T): string;
  /** Build a row's inner content element (factory wraps it in the button + click). */
  renderRow(item: T): HTMLElement;
  /**
   * Insert the chosen `item`, replacing `range` (the trigger token). The consumer
   * dispatches its own transaction(s); removing the token text resets the trigger
   * state on the next `apply`, so no explicit close is required.
   */
  commit(view: EditorView, item: T, range: TriggerRange): void;
}

/** The items currently offered for `state` (empty when inactive/dismissed). */
function resultsFor<T>(state: TriggerState, config: TriggerPluginConfig<T>): T[] {
  if (state.from === null || state.closed) return [];
  return config.getItems(state.query).slice(0, config.maxResults ?? DEFAULT_MAX_RESULTS);
}

/**
 * Commit the highlighted (or explicitly given) item. Returns true when something
 * was inserted. Shared by the Enter/Tab keybinding and the popup's click handler.
 */
function commitActive<T>(view: EditorView, config: TriggerPluginConfig<T>, item?: T): boolean {
  const state = config.pluginKey.getState(view.state);
  if (!state || state.from === null) return false;
  const results = resultsFor(state, config);
  const chosen = item ?? results[state.index];
  if (!chosen) return false;
  config.commit(view, chosen, { from: state.from, to: state.to });
  view.focus();
  return true;
}

/**
 * Build a ProseMirror plugin for the given trigger config. Add it to a Tiptap
 * `Extension`'s `addProseMirrorPlugins()`.
 */
export function createTriggerPlugin<T>(config: TriggerPluginConfig<T>): Plugin<TriggerState> {
  const { pluginKey } = config;

  return new Plugin<TriggerState>({
    key: pluginKey,

    state: {
      init: () => INACTIVE,
      apply(tr, value, _old, newState): TriggerState {
        const meta = tr.getMeta(pluginKey) as TriggerMeta | undefined;
        if (meta?.type === 'move') {
          if (value.from === null) return value;
          const len = resultsFor(value, config).length;
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
        const textBefore = $from.parent.textBetween(0, $from.parentOffset, undefined, '￼');
        const match = config.match(textBefore);
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
        const state = pluginKey.getState(view.state);
        if (!state || state.from === null || state.closed) return false;
        if (event.key === 'Escape') {
          view.dispatch(view.state.tr.setMeta(pluginKey, { type: 'close' } satisfies TriggerMeta));
          return true;
        }
        // Only capture navigation/commit keys when there's something to pick.
        if (resultsFor(state, config).length === 0) return false;
        if (event.key === 'ArrowDown') {
          view.dispatch(view.state.tr.setMeta(pluginKey, { type: 'move', dir: 1 } satisfies TriggerMeta));
          return true;
        }
        if (event.key === 'ArrowUp') {
          view.dispatch(view.state.tr.setMeta(pluginKey, { type: 'move', dir: -1 } satisfies TriggerMeta));
          return true;
        }
        if (event.key === 'Enter' || event.key === 'Tab') {
          return commitActive(view, config);
        }
        return false;
      },
    },

    view: (editorView) => new TriggerPopup<T>(editorView, config),
  });
}

/** Imperative dropdown rendered next to the caret while a trigger is active. */
class TriggerPopup<T> {
  private readonly dom: HTMLDivElement;
  private rendered = '';

  constructor(
    private readonly view: EditorView,
    private readonly config: TriggerPluginConfig<T>
  ) {
    this.dom = document.createElement('div');
    this.dom.className = config.popupClass;
    this.dom.style.display = 'none';
    // Keep the editor selection on mousedown so a click doesn't blur/collapse.
    this.dom.addEventListener('mousedown', (e) => e.preventDefault());
    document.body.appendChild(this.dom);
    this.update();
  }

  update(): void {
    const state = this.config.pluginKey.getState(this.view.state);
    const results = state ? resultsFor(state, this.config) : [];
    if (!state || state.from === null || results.length === 0) {
      this.hide();
      return;
    }
    // Cheap render gate: rebuild only when the visible set/selection changes.
    const signature = `${state.index}|${results.map((r) => this.config.rowKey(r)).join(',')}`;
    if (signature !== this.rendered) {
      this.renderList(results, state.index);
      this.rendered = signature;
    }
    this.position(state.from);
  }

  private renderList(results: T[], index: number): void {
    this.dom.replaceChildren();
    results.forEach((item, i) => {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = i === index ? `${this.config.popupClass}-item is-active` : `${this.config.popupClass}-item`;
      row.appendChild(this.config.renderRow(item));
      row.addEventListener('click', () => commitActive(this.view, this.config, item));
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
