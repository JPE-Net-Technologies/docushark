import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

/**
 * SmoothWriteExtension — SPIKE (JP-259).
 *
 * An opt-in "smooth writing" effect: freshly typed characters glide/fade in
 * instead of being plucked in. **View-only and zero-data:** it adds ephemeral
 * ProseMirror inline decorations over just-inserted text and lets CSS
 * (`.ds-write-in` keyframes in TiptapEditor.css) do the animation. It never
 * mutates the document or the CRDT — decorations are pure view state, so this is
 * safe to run alongside Yjs sync. The animation is honored down to a no-op under
 * `prefers-reduced-motion` (handled in CSS).
 *
 * Very safely targeted: only **small inline insertions** (typing, ≤ MAX_RUN
 * chars) are decorated — large pastes / structural edits are ignored, so we
 * never animate a wall of text or fight a bulk operation. Decorations are
 * cleared shortly after typing pauses to keep the set tiny.
 *
 * Spike scope: wired into the local-only `TiptapEditor` only (not the collab
 * editor) to keep the blast radius minimal while we evaluate feel + perf.
 */

export const SMOOTH_WRITE_PLUGIN_KEY = new PluginKey<DecorationSet>('smoothWrite');

/** Longest inserted run we treat as "typing" (chars). Bigger = a paste; skip. */
const MAX_RUN = 4;
/** Clear decorations this long after the last insertion (≥ the CSS duration). */
const CLEAR_DELAY_MS = 240;

export const SmoothWriteExtension = Extension.create({
  name: 'smoothWrite',

  addProseMirrorPlugins() {
    let clearTimer: ReturnType<typeof setTimeout> | null = null;

    return [
      new Plugin<DecorationSet>({
        key: SMOOTH_WRITE_PLUGIN_KEY,
        state: {
          init: () => DecorationSet.empty,
          apply: (tr, set) => {
            if (tr.getMeta(SMOOTH_WRITE_PLUGIN_KEY) === 'clear') {
              return DecorationSet.empty;
            }

            let next = set.map(tr.mapping, tr.doc);
            if (!tr.docChanged) return next;

            const added: Decoration[] = [];
            for (const step of tr.steps) {
              step.getMap().forEach((_fromA, _toA, fromB, toB) => {
                const len = toB - fromB;
                if (len > 0 && len <= MAX_RUN) {
                  added.push(
                    Decoration.inline(fromB, toB, { class: 'ds-write-in', nodeName: 'span' }),
                  );
                }
              });
            }
            if (added.length > 0) next = next.add(tr.doc, added);
            return next;
          },
        },
        view: (view) => ({
          update: (_v, prevState) => {
            if (prevState.doc === view.state.doc) return;
            if (clearTimer) clearTimeout(clearTimer);
            clearTimer = setTimeout(() => {
              if (view.isDestroyed) return;
              view.dispatch(view.state.tr.setMeta(SMOOTH_WRITE_PLUGIN_KEY, 'clear'));
            }, CLEAR_DELAY_MS);
          },
          destroy: () => {
            if (clearTimer) clearTimeout(clearTimer);
          },
        }),
        props: {
          decorations(state) {
            return SMOOTH_WRITE_PLUGIN_KEY.getState(state) ?? DecorationSet.empty;
          },
        },
      }),
    ];
  },
});

export default SmoothWriteExtension;
