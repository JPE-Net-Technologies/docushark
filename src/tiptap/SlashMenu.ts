/**
 * SlashMenu — the `/` command palette for prose.
 *
 * Typing `/` at a word boundary opens a dropdown of insert commands
 * (`slashCommands.ts`), filtered live by what you type; picking one removes the
 * `/query` token and runs the command. It's the fast path next to the toolbar's
 * Insert tab, and the discovery surface every later prose feature plugs into
 * (each new node registers a `SlashCommand`).
 *
 * Built on the shared `createTriggerPlugin` factory (the generalized
 * `CitationSuggestion` mechanism), so it works identically in both prose editors
 * when shared via `sharedProseExtensions`. It owns no nodes/marks, so the headless
 * schema (`registerProseSchema`) and collab are unaffected.
 */

import { Extension } from '@tiptap/core';
import { PluginKey } from '@tiptap/pm/state';
import { createTriggerPlugin, type TriggerState } from './triggerPlugin';
import { matchSlashTrigger, filterCommands, type SlashCommand } from './slashCommands';
import './SlashMenu.css';

const slashMenuKey = new PluginKey<TriggerState>('slashMenu');

/** Build a row: command title with a muted group label on the right. */
function renderSlashRow(command: SlashCommand): HTMLElement {
  const row = document.createElement('span');
  row.className = 'slash-menu-row';

  const title = document.createElement('span');
  title.className = 'slash-menu-title';
  title.textContent = command.title;
  row.appendChild(title);

  const group = document.createElement('span');
  group.className = 'slash-menu-group';
  group.textContent = command.group;
  row.appendChild(group);

  return row;
}

export const SlashMenu = Extension.create({
  name: 'slashMenu',

  addProseMirrorPlugins() {
    const editor = this.editor;
    return [
      createTriggerPlugin<SlashCommand>({
        pluginKey: slashMenuKey,
        popupClass: 'slash-menu',
        match: matchSlashTrigger,
        getItems: (query) => filterCommands(query),
        rowKey: (command) => command.id,
        renderRow: renderSlashRow,
        commit: (view, command, range) => {
          // Remove the `/query` token first, then run the command so the insert
          // lands at a clean caret (and the trigger state resets on the delete).
          view.dispatch(view.state.tr.delete(range.from, range.to));
          command.run(editor);
        },
      }),
    ];
  },
});
