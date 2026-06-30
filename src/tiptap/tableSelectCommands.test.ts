/**
 * Table select commands (JP-416): Select Row / Column / All produce the right
 * CellSelection. Headless `Editor` so the real schema + prosemirror-tables run.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { extensions } from '../ui/TiptapEditor';
import { selectRow, selectColumn, selectAllCells } from './tableSelectCommands';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function make(content: string): Editor {
  const element = document.createElement('div');
  document.body.appendChild(element);
  const ed = new Editor({ element, extensions, content });
  editor = ed;
  return ed;
}

function caretIn(ed: Editor, text: string): void {
  let pos = -1;
  ed.state.doc.descendants((node, p) => {
    if (node.isText && node.text === text) pos = p;
  });
  if (pos < 0) throw new Error(`no text ${text}`);
  ed.commands.setTextSelection(pos);
}

function cellCount(sel: CellSelection): number {
  let n = 0;
  sel.forEachCell(() => { n += 1; });
  return n;
}

// 3 cols × 2 rows.
const TABLE =
  '<table><tbody>' +
  '<tr><td>R0a</td><td>R0b</td><td>R0c</td></tr>' +
  '<tr><td>R1a</td><td>R1b</td><td>R1c</td></tr>' +
  '</tbody></table>';

describe('table select commands', () => {
  it('Select Row selects the current row full-width', () => {
    const ed = make(TABLE);
    caretIn(ed, 'R0b');
    expect(selectRow(ed)).toBe(true);
    const sel = ed.state.selection as CellSelection;
    expect(sel).toBeInstanceOf(CellSelection);
    expect(sel.isRowSelection()).toBe(true);
    expect(cellCount(sel)).toBe(3); // one row × 3 cols
  });

  it('Select Column selects the current column full-height', () => {
    const ed = make(TABLE);
    caretIn(ed, 'R0b'); // column 1
    expect(selectColumn(ed)).toBe(true);
    const sel = ed.state.selection as CellSelection;
    expect(sel.isColSelection()).toBe(true);
    expect(cellCount(sel)).toBe(2); // 2 rows × one col
  });

  it('Select All Cells selects the whole table', () => {
    const ed = make(TABLE);
    caretIn(ed, 'R0a');
    expect(selectAllCells(ed)).toBe(true);
    const sel = ed.state.selection as CellSelection;
    expect(sel.isRowSelection()).toBe(true);
    expect(sel.isColSelection()).toBe(true);
    expect(cellCount(sel)).toBe(6); // 2 × 3
  });

  it('returns false outside a table', () => {
    const ed = make('<p>nope</p>');
    caretIn(ed, 'nope');
    expect(selectRow(ed)).toBe(false);
    expect(selectColumn(ed)).toBe(false);
    expect(selectAllCells(ed)).toBe(false);
  });
});
