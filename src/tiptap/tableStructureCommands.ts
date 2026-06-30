/**
 * Table structure operations for JP-416 that aren't surfaced as Tiptap editor
 * commands: moving a column/row, and — when a column/row is inserted — keeping
 * the header style AND inheriting the reference column/row's formatting (cell
 * alignment, background, and block-level text formatting such as paragraph
 * alignment) so a new column/row matches its neighbor instead of coming in
 * blank.
 *
 * These build on prosemirror-tables' own primitives (`moveTableColumn`,
 * `moveTableRow`, `selectedRect`, `rowIsHeader`, `columnIsHeader`,
 * `tableNodeTypes`) rather than hand-rolling table rebuilds, so colspan/rowspan
 * and column-width handling stay correct. Each takes the Tiptap `Editor` and
 * returns whether it changed anything (so the toolbar/menu can disable a no-op).
 */

import type { Editor } from '@tiptap/core';
import type { EditorState, Transaction } from '@tiptap/pm/state';
import type { NodeType } from '@tiptap/pm/model';
import {
  isInTable,
  selectedRect,
  moveTableColumn,
  moveTableRow,
  rowIsHeader,
  columnIsHeader,
  tableNodeTypes,
  type TableMap,
  type TableRect,
} from '@tiptap/pm/tables';

/**
 * A clean (no rowspan/colspan) table has each cell appear exactly once in the
 * map. A merged cell appears multiple times, shrinking the unique set. Move +
 * formatting inheritance are disabled on merged tables to avoid corrupting spans
 * / mis-indexing (clean case first).
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

/**
 * The inheritable formatting of a cell: its own attrs (alignment + background)
 * plus its first block's type+attrs, which carry text formatting like paragraph
 * `textAlign` (JP-416). Inline marks (bold/color) aren't captured — a new cell
 * is empty, so there's no text to carry them on.
 */
interface CellFormat {
  align: unknown;
  backgroundColor: unknown;
  blockType: NodeType | null;
  blockAttrs: Record<string, unknown> | null;
}

function cellFormatAt(state: EditorState, rect: TableRect, row: number, col: number): CellFormat {
  const offset = rect.map.map[row * rect.map.width + col];
  const node = offset === undefined ? null : state.doc.nodeAt(rect.tableStart + offset);
  const firstBlock = node?.firstChild ?? null;
  return {
    align: node?.attrs['align'] ?? null,
    backgroundColor: node?.attrs['backgroundColor'] ?? null,
    blockType: firstBlock?.type ?? null,
    blockAttrs: firstBlock ? { ...firstBlock.attrs } : null,
  };
}

/** Copy `fmt` onto the cell at (row, col) of the current rect (keeping its type). */
function applyCellFormat(
  tr: Transaction,
  state: EditorState,
  rect: TableRect,
  row: number,
  col: number,
  fmt: CellFormat | undefined,
): void {
  if (!fmt) return;
  const offset = rect.map.map[row * rect.map.width + col];
  if (offset === undefined) return;
  const pos = rect.tableStart + offset;
  const node = state.doc.nodeAt(pos);
  if (!node) return;

  // Cell-level attrs: alignment + background.
  if (fmt.align != null || fmt.backgroundColor != null) {
    tr.setNodeMarkup(pos, undefined, {
      ...node.attrs,
      align: fmt.align,
      backgroundColor: fmt.backgroundColor,
    });
  }

  // First-block text formatting (paragraph `textAlign`, etc.). Only when the new
  // cell's first block is the same node type, so we never restructure the cell —
  // and only when the attrs actually differ, to avoid a no-op transaction.
  const inner = node.firstChild;
  if (
    fmt.blockType &&
    fmt.blockAttrs &&
    inner &&
    inner.type === fmt.blockType &&
    JSON.stringify(inner.attrs) !== JSON.stringify(fmt.blockAttrs)
  ) {
    tr.setNodeMarkup(pos + 1, undefined, fmt.blockAttrs);
  }
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

function insertColumn(editor: Editor, dir: 'after' | 'before'): boolean {
  const command = dir === 'after' ? 'addColumnAfter' : 'addColumnBefore';
  const { state } = editor;
  if (!isInTable(state)) return editor.chain().focus()[command]().run();

  const before = selectedRect(state);
  const flags: HeaderFlags = {
    headerRow: rowIsHeader(before.map, before.table, 0),
    headerColumn: columnIsHeader(before.map, before.table, 0),
  };
  const refCol = before.left;
  // Reference column's per-row formatting (skip on merged tables — the map index
  // isn't 1:1 there).
  const colFmt = tableHasMergedCells(before.map)
    ? null
    : Array.from({ length: before.map.height }, (_, r) => cellFormatAt(state, before, r, refCol));

  const ok = editor.chain().focus()[command]().run();
  if (!ok) return false;

  // Copy the reference column's formatting into the freshly inserted column.
  if (colFmt) {
    const after = selectedRect(editor.state);
    const newCol = dir === 'after' ? refCol + 1 : refCol;
    const tr = editor.state.tr;
    for (let r = 0; r < after.map.height; r++) {
      applyCellFormat(tr, editor.state, after, r, newCol, colFmt[r]);
    }
    if (tr.docChanged) editor.view.dispatch(tr);
  }
  applyHeaderFlags(editor, flags);
  return true;
}

function insertRow(editor: Editor, dir: 'after' | 'before'): boolean {
  const command = dir === 'after' ? 'addRowAfter' : 'addRowBefore';
  const { state } = editor;
  if (!isInTable(state)) return editor.chain().focus()[command]().run();

  const before = selectedRect(state);
  const flags: HeaderFlags = {
    headerRow: rowIsHeader(before.map, before.table, 0),
    headerColumn: columnIsHeader(before.map, before.table, 0),
  };
  const refRow = before.top;
  const rowFmt = tableHasMergedCells(before.map)
    ? null
    : Array.from({ length: before.map.width }, (_, c) => cellFormatAt(state, before, refRow, c));

  const ok = editor.chain().focus()[command]().run();
  if (!ok) return false;

  if (rowFmt) {
    const after = selectedRect(editor.state);
    const newRow = dir === 'after' ? refRow + 1 : refRow;
    const tr = editor.state.tr;
    for (let c = 0; c < after.map.width; c++) {
      applyCellFormat(tr, editor.state, after, newRow, c, rowFmt[c]);
    }
    if (tr.docChanged) editor.view.dispatch(tr);
  }
  applyHeaderFlags(editor, flags);
  return true;
}

export const addColumnAfterKeepHeader = (editor: Editor) => insertColumn(editor, 'after');
export const addColumnBeforeKeepHeader = (editor: Editor) => insertColumn(editor, 'before');
export const addRowAfterKeepHeader = (editor: Editor) => insertRow(editor, 'after');
export const addRowBeforeKeepHeader = (editor: Editor) => insertRow(editor, 'before');
