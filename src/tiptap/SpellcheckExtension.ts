import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { SpellcheckService } from '../services/SpellcheckService';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';
import type { Node as PMNode } from '@tiptap/pm/model';

export const SPELLCHECK_PLUGIN_KEY = new PluginKey<DecorationSet>('spellcheck');
const WORD_RE = /\p{L}[\p{L}\p{M}'’-]*/gu;
const RECHECK_DEBOUNCE_MS = 500;

function buildDecorations(doc: PMNode): DecorationSet {
  // Only the built-in checker draws decorations. In `system` mode the native
  // browser spellcheck does the work; `off` disables spelling entirely. (Gating
  // here — not in SpellcheckService — keeps the service pure for the popover.)
  if (useUIPreferencesStore.getState().appearancePrefs.spellcheck !== 'custom') {
    return DecorationSet.empty;
  }
  if (!SpellcheckService.isReady()) return DecorationSet.empty;
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || typeof node.text !== 'string') return;
    const parent = doc.resolve(pos).parent;
    if (parent.type.name === 'codeBlock') return;
    if (node.marks.some((m) => m.type.name === 'code' || m.type.name === 'link')) return;

    const text = node.text;
    WORD_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = WORD_RE.exec(text)) !== null) {
      const word = match[0];
      if (word.length < 3) continue;
      if (/\d/.test(word)) continue;
      if (/^[A-Z]+$/.test(word)) continue;
      if (!SpellcheckService.isMisspelled(word)) continue;
      const from = pos + match.index;
      const to = from + word.length;
      decorations.push(
        Decoration.inline(from, to, {
          class: 'spellcheck-error',
          nodeName: 'span',
        }),
      );
    }
  });
  return DecorationSet.create(doc, decorations);
}

export const SpellcheckExtension = Extension.create({
  name: 'spellcheck',

  onCreate() {
    void SpellcheckService.prepare().then(() => {
      const view = this.editor.view;
      const decorations = buildDecorations(view.state.doc);
      view.dispatch(view.state.tr.setMeta(SPELLCHECK_PLUGIN_KEY, decorations));
    });
  },

  addProseMirrorPlugins() {
    let timer: ReturnType<typeof setTimeout> | null = null;

    return [
      new Plugin<DecorationSet>({
        key: SPELLCHECK_PLUGIN_KEY,
        state: {
          init: (_config, state) => buildDecorations(state.doc),
          apply: (tr, value) => {
            const meta = tr.getMeta(SPELLCHECK_PLUGIN_KEY) as DecorationSet | undefined;
            if (meta) return meta;
            if (tr.docChanged) return value.map(tr.mapping, tr.doc);
            return value;
          },
        },
        view: (view) => {
          const schedule = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => {
              const decorations = buildDecorations(view.state.doc);
              view.dispatch(view.state.tr.setMeta(SPELLCHECK_PLUGIN_KEY, decorations));
            }, RECHECK_DEBOUNCE_MS);
          };
          return {
            update: (_v, prevState) => {
              if (prevState.doc !== view.state.doc) schedule();
            },
            destroy: () => {
              if (timer) clearTimeout(timer);
            },
          };
        },
        props: {
          decorations(state) {
            return SPELLCHECK_PLUGIN_KEY.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

/**
 * Force a fresh spellcheck pass — call after the document's custom dictionary changes.
 */
export function rebuildSpellcheck(view: import('@tiptap/pm/view').EditorView): void {
  const decorations = buildDecorations(view.state.doc);
  view.dispatch(view.state.tr.setMeta(SPELLCHECK_PLUGIN_KEY, decorations));
}
