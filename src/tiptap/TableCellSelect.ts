import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorState } from '@tiptap/pm/state';
import type { ResolvedPos } from '@tiptap/pm/model';
import type { EditorView } from '@tiptap/pm/view';
import { cellAround, inSameTable, CellSelection } from '@tiptap/pm/tables';

/**
 * TableCellSelect (JP-416) — table selection ergonomics:
 *
 * 1. A drag that crosses cells becomes a multi-cell `CellSelection`, even when
 *    the drag STARTS inside a cell's text. prosemirror-tables' own drag handler
 *    decides "moved to another cell" from `event.target`, which a native
 *    text-selection drag pins to the start cell — so the cross-cell trigger never
 *    fires and the selection is clamped to one cell. `createSelectionBetween`
 *    works off the resolved anchor/head POSITIONS instead, immune to the pinned
 *    target. (prosemirror-tables' own `createSelectionBetween` returns null
 *    unless its drag is active, so this composes — no conflict.)
 *
 * 2. **Ctrl/Cmd+Shift+click** selects all rows in range — a full-width row
 *    selection from the anchor cell's row to the clicked cell's row, for quickly
 *    grabbing a band of rows.
 */

/** The cross-cell rule, extracted so it's unit-testable from resolved positions. */
export function cellSelectionBetween(
  $anchor: ResolvedPos,
  $head: ResolvedPos,
): CellSelection | null {
  const anchorCell = cellAround($anchor);
  const headCell = cellAround($head);
  if (anchorCell && headCell && anchorCell.pos !== headCell.pos && inSameTable(anchorCell, headCell)) {
    return new CellSelection(anchorCell, headCell);
  }
  return null;
}

/**
 * Full-row selection covering the rows between the current selection's anchor
 * cell and `$head`'s cell (same table). Extracted for unit testing. Returns null
 * when `$head` isn't in a table cell, or it's a different table than the anchor.
 */
export function rowRangeSelection(state: EditorState, $head: ResolvedPos): CellSelection | null {
  const headCell = cellAround($head);
  if (!headCell) return null;
  const sel = state.selection;
  const anchorCell =
    sel instanceof CellSelection ? sel.$anchorCell : cellAround(sel.$anchor) ?? headCell;
  if (!inSameTable(anchorCell, headCell)) return null;
  return CellSelection.rowSelection(anchorCell, headCell);
}

export const TableCellSelect = Extension.create({
  name: 'docusharkTableCellSelect',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('docusharkTableCellSelect'),
        props: {
          createSelectionBetween: (_view, $anchor, $head) =>
            cellSelectionBetween($anchor, $head),
          handleDOMEvents: {
            mousedown: (view: EditorView, event: MouseEvent) => {
              // Ctrl/Cmd+Shift+click → select every row in the range. (Cmd is the
              // Mac modifier; Ctrl+click there is a context-menu chord.)
              if (event.button !== 0 || !event.shiftKey || !(event.ctrlKey || event.metaKey)) {
                return false;
              }
              const at = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!at) return false;
              const sel = rowRangeSelection(view.state, view.state.doc.resolve(at.pos));
              if (!sel) return false;
              view.dispatch(view.state.tr.setSelection(sel));
              event.preventDefault();
              return true;
            },
          },
        },
      }),
    ];
  },
});

export default TableCellSelect;
