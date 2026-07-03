import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { ResolvedPos } from '@tiptap/pm/model';
import { cellAround, inSameTable, CellSelection } from '@tiptap/pm/tables';

/**
 * TableCellSelect (JP-416) — make a drag that crosses table cells reliably
 * become a multi-cell `CellSelection`, even when the drag STARTS inside a cell's
 * text.
 *
 * prosemirror-tables' own drag handler decides "the pointer moved to another
 * cell" from `event.target`. When a drag begins on text, the browser runs a
 * native text-selection drag that keeps `event.target` pinned to the start cell,
 * so that cross-cell trigger never fires and the selection is clamped to the
 * first cell (`normalizeSelection`). The `createSelectionBetween` prop instead
 * works off the resolved anchor/head POSITIONS, so it's immune to the pinned
 * target: if the two ends are in different cells of the same table, select the
 * cells. (prosemirror-tables' own `createSelectionBetween` returns null unless
 * its drag is active, so this composes — no conflict.)
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

export const TableCellSelect = Extension.create({
  name: 'docusharkTableCellSelect',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('docusharkTableCellSelect'),
        props: {
          createSelectionBetween: (_view, $anchor, $head) =>
            cellSelectionBetween($anchor, $head),
        },
      }),
    ];
  },
});

export default TableCellSelect;
