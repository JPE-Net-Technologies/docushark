import { Extension } from '@tiptap/core';
import type { Editor } from '@tiptap/core';
import { addRowAfterKeepHeader } from './tableStructureCommands';

/**
 * TableKeymap (JP-416) — Word-like Tab navigation inside prose tables.
 *
 * Tab / Shift-Tab move to the next / previous cell, and Tab in the **last** cell
 * appends a new row and lands in its first cell (so you can fill a table without
 * reaching for the mouse). Outside a table the handlers return `false` so Tab
 * keeps its default behavior (e.g. list indent / focus move).
 */

/**
 * Tab handler, extracted so it's unit-testable without dispatching key events.
 * Returns true if it handled the key (advanced a cell or grew the table).
 */
export function handleTableTab(editor: Editor): boolean {
  if (!editor.isActive('table')) return false;
  if (editor.commands.goToNextCell()) return true;
  // At the last cell: add a row and step into it. Use the inheriting wrapper
  // (not the raw addRowAfter) so a Tab-created row keeps the header style and
  // the reference row's formatting (JP-416) — the same as a toolbar/menu insert.
  if (editor.can().addRowAfter()) {
    const added = addRowAfterKeepHeader(editor);
    if (added) editor.commands.goToNextCell();
    return added;
  }
  return false;
}

/** Shift-Tab handler — previous cell, or pass through outside a table. */
export function handleTableShiftTab(editor: Editor): boolean {
  if (!editor.isActive('table')) return false;
  return editor.commands.goToPreviousCell();
}

export const TableKeymap = Extension.create({
  name: 'docusharkTableKeymap',

  addKeyboardShortcuts() {
    return {
      Tab: () => handleTableTab(this.editor),
      'Shift-Tab': () => handleTableShiftTab(this.editor),
    };
  },
});

export default TableKeymap;
