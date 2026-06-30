/**
 * Table structure operations for JP-416 that aren't surfaced as Tiptap editor
 * commands: moving a column/row, and keeping header cells when a column/row is
 * inserted.
 *
 * These build on prosemirror-tables' own primitives (`moveTableColumn`,
 * `moveTableRow`, `selectedRect`, `rowIsHeader`, `columnIsHeader`,
 * `tableNodeTypes`) rather than hand-rolling table rebuilds, so colspan/rowspan
 * and column-width handling stay correct. Each takes the Tiptap `Editor` and
 * returns whether it changed anything (so the toolbar/menu can disable a no-op).
 */

import type { Editor } from '@tiptap/core';
import {
  isInTable,
  selectedRect,
  moveTableColumn,
  moveTableRow,
  rowIsHeader,
  columnIsHeader,
  tableNodeTypes,
  type TableMap,
} from '@tiptap/pm/tables';

/**
 * A clean (no rowspan/colspan) table has each cell appear exactly once in the
 * map. A merged cell appears multiple times, shrinking the unique set. Move is
 * disabled on merged tables to avoid corrupting spans (clean case first).
 */
export function tableHasMergedCells(map: TableMap): boolean {
  return new Set(map.map).size !== map.map.length;
}

function moveCol(editor: Editor, dir: -1 | 1): boolean {
  const { state, view } = editor;
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  if (tableHasMergedCells(rect.map)) return false;
  const from = rect.left;
  const to = from + dir;
  if (to < 0 || to > rect.map.width - 1) return false;
  const ok = moveTableColumn({ from, to })(state, view.dispatch);
  if (ok) view.focus();
  return ok;
}

function moveRowFn(editor: Editor, dir: -1 | 1): boolean {
  const { state, view } = editor;
  if (!isInTable(state)) return false;
  const rect = selectedRect(state);
  if (tableHasMergedCells(rect.map)) return false;
  const from = rect.top;
  const to = from + dir;
  if (to < 0 || to > rect.map.height - 1) return false;
  const ok = moveTableRow({ from, to })(state, view.dispatch);
  if (ok) view.focus();
  return ok;
}

export const moveColumnLeft = (editor: Editor) => moveCol(editor, -1);
export const moveColumnRight = (editor: Editor) => moveCol(editor, 1);
export const moveRowUp = (editor: Editor) => moveRowFn(editor, -1);
export const moveRowDown = (editor: Editor) => moveRowFn(editor, 1);

interface HeaderFlags {
  headerRow: boolean;
  headerColumn: boolean;
}

/** Whether the current table's first row / first column are header cells. */
function captureHeaderFlags(editor: Editor): HeaderFlags {
  const { state } = editor;
  if (!isInTable(state)) return { headerRow: false, headerColumn: false };
  const rect = selectedRect(state);
  return {
    headerRow: rowIsHeader(rect.map, rect.table, 0),
    headerColumn: columnIsHeader(rect.map, rect.table, 0),
  };
}

/**
 * Force the header cells of the current table to match the captured flags: a
 * cell becomes `tableHeader` iff it's in row 0 (when the table had a header row)
 * or col 0 (header column). Only upgrades — never demotes — so it's idempotent
 * and safe to run after every insert. Fixes "new column/row loses header style".
 */
function applyHeaderFlags(editor: Editor, flags: HeaderFlags): void {
  if (!flags.headerRow && !flags.headerColumn) return;
  const { state, view } = editor;
  if (!isInTable(state)) return;
  const rect = selectedRect(state);
  const headerType = tableNodeTypes(state.schema)['header_cell'];
  if (!headerType) return;

  const { map, tableStart } = rect;
  const tr = state.tr;
  const seen = new Set<number>();
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const shouldHeader = (row === 0 && flags.headerRow) || (col === 0 && flags.headerColumn);
      if (!shouldHeader) continue;
      const offset = map.map[row * map.width + col];
      if (offset === undefined || seen.has(offset)) continue;
      seen.add(offset);
      const pos = tableStart + offset;
      const node = state.doc.nodeAt(pos);
      if (node && node.type !== headerType) {
        tr.setNodeMarkup(pos, headerType, node.attrs);
      }
    }
  }
  if (tr.docChanged) view.dispatch(tr);
}

function insertKeepingHeader(editor: Editor, command: 'addColumnAfter' | 'addColumnBefore' | 'addRowAfter' | 'addRowBefore'): boolean {
  const flags = captureHeaderFlags(editor);
  const ok = editor.chain().focus()[command]().run();
  if (ok) applyHeaderFlags(editor, flags);
  return ok;
}

export const addColumnAfterKeepHeader = (editor: Editor) => insertKeepingHeader(editor, 'addColumnAfter');
export const addColumnBeforeKeepHeader = (editor: Editor) => insertKeepingHeader(editor, 'addColumnBefore');
export const addRowAfterKeepHeader = (editor: Editor) => insertKeepingHeader(editor, 'addRowAfter');
export const addRowBeforeKeepHeader = (editor: Editor) => insertKeepingHeader(editor, 'addRowBefore');
