/**
 * Where pasted image files will land while they upload (DSK-208).
 *
 * A screenshot can't be inserted until it has been processed and stored, which
 * takes a moment. Rather than block the editor, the paste leaves an "Adding
 * image…" marker at the caret: a widget decoration, not document content, so
 * nothing is saved, synced or undone for it. It moves with any edits made in
 * the meantime, and the images are inserted wherever it has ended up.
 */
import { Extension } from '@tiptap/core';
import { Plugin, PluginKey, type EditorState } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

interface PlaceholderAction {
  add?: { id: object; pos: number };
  remove?: { id: object };
}

export const pastePlaceholderKey = new PluginKey<DecorationSet>('pastePlaceholder');

function placeholderWidget(): HTMLElement {
  const el = document.createElement('span');
  el.className = 'prose-paste-placeholder';
  el.setAttribute('role', 'status');
  el.textContent = 'Adding image…';
  return el;
}

export const PastePlaceholder = Extension.create({
  name: 'pastePlaceholder',

  addProseMirrorPlugins() {
    return [
      new Plugin<DecorationSet>({
        key: pastePlaceholderKey,
        state: {
          init: () => DecorationSet.empty,
          apply(tr, set) {
            let next = set.map(tr.mapping, tr.doc);
            const action = tr.getMeta(pastePlaceholderKey) as PlaceholderAction | undefined;
            if (action?.add) {
              const { id, pos } = action.add;
              next = next.add(tr.doc, [Decoration.widget(pos, placeholderWidget, { id, side: -1 })]);
            }
            if (action?.remove) {
              const { id } = action.remove;
              next = next.remove(next.find(undefined, undefined, (spec) => spec['id'] === id));
            }
            return next;
          },
        },
        props: {
          decorations(state) {
            return pastePlaceholderKey.getState(state);
          },
        },
      }),
    ];
  },
});

/** Whether the editor has the placeholder plugin (the read-only preview doesn't). */
export function hasPastePlaceholder(state: EditorState): boolean {
  return pastePlaceholderKey.getState(state) !== undefined;
}

/** The placeholder's current position, or null once it's gone (its text was deleted). */
export function findPastePlaceholder(state: EditorState, id: object): number | null {
  const found = pastePlaceholderKey.getState(state)?.find(undefined, undefined, (spec) => spec['id'] === id);
  return found && found.length > 0 ? found[0]!.from : null;
}

export function addPastePlaceholder(id: object, pos: number): PlaceholderAction {
  return { add: { id, pos } };
}

export function removePastePlaceholder(id: object): PlaceholderAction {
  return { remove: { id } };
}
