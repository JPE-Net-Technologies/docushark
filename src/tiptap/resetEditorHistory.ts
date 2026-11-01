/**
 * resetEditorHistory — empty a prose editor's undo stack, keeping its document
 * and every other plugin's state (DSK-201).
 *
 * After a page or document is loaded into the editor, undo must have nothing to
 * revert: otherwise the first undo blanks a freshly opened page, or, after a
 * page switch, writes the previous page's content into this one, and autosave
 * keeps it.
 *
 * `EditorState.reconfigure` carries plugin state over by field name, and
 * prosemirror-history keys every history plugin with one fixed PluginKey. So
 * swapping in a fresh `history()` — what this replaced — kept the old stack:
 * the reset never cleared anything. Reconfiguring without the history plugin
 * drops its field; reconfiguring with it again initializes the field empty.
 * Every other field is carried over both times, so node views and the
 * remaining plugins keep their state (a wholesale `EditorState.create` would
 * reinitialize them all and crash ReactNodeView mid-render).
 *
 * The collaborative editor's undo is Yjs's, not prosemirror-history; with no
 * history plugin installed this does nothing.
 */

import type { Editor } from '@tiptap/core';
import type { Plugin } from '@tiptap/pm/state';

function isHistoryPlugin(plugin: Plugin): boolean {
  const key = (plugin as unknown as { key?: string }).key;
  return typeof key === 'string' && key.startsWith('history$');
}

export function resetEditorHistory(editor: Editor): void {
  if (editor.isDestroyed) return;
  const { state, view } = editor;
  const plugins = state.plugins;
  if (!plugins.some(isHistoryPlugin)) return;
  const withoutHistory = state.reconfigure({ plugins: plugins.filter((p) => !isHistoryPlugin(p)) });
  view.updateState(withoutHistory.reconfigure({ plugins }));
}
