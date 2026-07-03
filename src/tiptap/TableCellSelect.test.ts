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
import { cellSelectionBetween } from './TableCellSelect';

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
