/**
 * TableCellSelect (JP-416) — a pointer selection spanning two cells of the same
 * table becomes a CellSelection, regardless of where the drag started. We test
 * the extracted rule with resolved positions from a real table doc (simulating
 * the createSelectionBetween call).
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { extensions } from '../ui/TiptapEditor';
import { cellSelectionBetween, rowRangeSelection } from './TableCellSelect';

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

/** Resolve a position inside the cell whose text is `text`. */
function posIn(ed: Editor, text: string): number {
  let pos = -1;
  ed.state.doc.descendants((node, p) => {
    if (node.isText && node.text === text) pos = p;
  });
  if (pos < 0) throw new Error(`no text ${text}`);
  return pos;
}

const TABLE = '<table><tbody><tr><td>AA</td><td>BB</td></tr><tr><td>CC</td><td>DD</td></tr></tbody></table>';

describe('cellSelectionBetween', () => {
  it('returns a CellSelection for two different cells in the same table', () => {
    const ed = make(TABLE);
    const $a = ed.state.doc.resolve(posIn(ed, 'AA'));
    const $b = ed.state.doc.resolve(posIn(ed, 'DD'));
    const sel = cellSelectionBetween($a, $b);
    expect(sel).toBeInstanceOf(CellSelection);
  });

  it('returns null for anchor and head within the same cell', () => {
    const ed = make(TABLE);
    const $a = ed.state.doc.resolve(posIn(ed, 'AA'));
    expect(cellSelectionBetween($a, $a)).toBeNull();
  });

  it('returns null when an endpoint is outside any table', () => {
    const ed = make('<p>OUT</p>' + TABLE);
    const $out = ed.state.doc.resolve(posIn(ed, 'OUT'));
    const $cell = ed.state.doc.resolve(posIn(ed, 'AA'));
    expect(cellSelectionBetween($out, $cell)).toBeNull();
  });
});

const TABLE_3R =
  '<table><tbody>' +
  '<tr><td>R0a</td><td>R0b</td></tr>' +
  '<tr><td>R1a</td><td>R1b</td></tr>' +
  '<tr><td>R2a</td><td>R2b</td></tr>' +
  '</tbody></table>';

function cellCount(sel: CellSelection): number {
  let n = 0;
  sel.forEachCell(() => { n += 1; });
  return n;
}

describe('rowRangeSelection (Ctrl/Cmd+Shift+click)', () => {
  it('selects every full row from the anchor row to the head row', () => {
    const ed = make(TABLE_3R);
    ed.commands.setTextSelection(posIn(ed, 'R0a')); // anchor in row 0
    const sel = rowRangeSelection(ed.state, ed.state.doc.resolve(posIn(ed, 'R2a')));
    expect(sel).toBeInstanceOf(CellSelection);
    expect(sel!.isRowSelection()).toBe(true);
    expect(cellCount(sel!)).toBe(6); // 3 rows × 2 cols
  });

  it('covers only the rows in range', () => {
    const ed = make(TABLE_3R);
    ed.commands.setTextSelection(posIn(ed, 'R0a'));
    const sel = rowRangeSelection(ed.state, ed.state.doc.resolve(posIn(ed, 'R1b')));
    expect(cellCount(sel!)).toBe(4); // rows 0–1 × 2 cols
  });

  it('returns null when the head is outside any table', () => {
    const ed = make('<p>OUT</p>' + TABLE_3R);
    ed.commands.setTextSelection(posIn(ed, 'R0a'));
    expect(rowRangeSelection(ed.state, ed.state.doc.resolve(posIn(ed, 'OUT')))).toBeNull();
  });
});
