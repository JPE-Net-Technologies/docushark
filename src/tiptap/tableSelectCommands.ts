/**
 * Excel-like "select" commands for prose tables (JP-416): select the current
 * row(s), column(s), or the whole table as a `CellSelection`. Surfaced in the
 * right-click table menu + the toolbar so a range is easy to grab for a move /
 * delete / format. Built on prosemirror-tables' `CellSelection` helpers.
 *
 * Each works off the current selection: a plain cursor selects its own
 * row/column; an existing multi-cell selection selects every row/column it
 * spans (so Select Row on a 3-row cell selection grabs all three full rows).
 */

import type { Editor } from '@tiptap/core';
import type { EditorState } from '@tiptap/pm/state';
import type { ResolvedPos } from '@tiptap/pm/model';
import { CellSelection, cellAround, isInTable, selectedRect } from '@tiptap/pm/tables';

/** The anchor/head cells of the current selection (a cursor's own cell, or a
 *  CellSelection's two ends). Null when the selection isn't in a table cell. */
function selectionCells(state: EditorState): { anchor: ResolvedPos; head: ResolvedPos } | null {
  const sel = state.selection;
  if (sel instanceof CellSelection) return { anchor: sel.$anchorCell, head: sel.$headCell };
  const $cell = cellAround(sel.$anchor);
  return $cell ? { anchor: $cell, head: $cell } : null;
}

export function selectRow(editor: Editor): boolean {
  const { state, view } = editor;
  if (!isInTable(state)) return false;
  const cells = selectionCells(state);
  if (!cells) return false;
  view.dispatch(state.tr.setSelection(CellSelection.rowSelection(cells.anchor, cells.head)));
  view.focus();
  return true;
}

export function selectColumn(editor: Editor): boolean {
  const { state, view } = editor;
  if (!isInTable(state)) return false;
  const cells = selectionCells(state);
  if (!cells) return false;
  view.dispatch(state.tr.setSelection(CellSelection.colSelection(cells.anchor, cells.head)));
  view.focus();
  return true;
}

export function selectAllCells(editor: Editor): boolean {
  const { state, view } = editor;
  if (!isInTable(state)) return false;
  const { map, tableStart } = selectedRect(state);
  const firstOffset = map.map[0];
  const lastOffset = map.map[map.width * map.height - 1];
  if (firstOffset === undefined || lastOffset === undefined) return false;
  const sel = new CellSelection(
    state.doc.resolve(tableStart + firstOffset),
    state.doc.resolve(tableStart + lastOffset),
  );
  view.dispatch(state.tr.setSelection(sel));
  view.focus();
  return true;
}
