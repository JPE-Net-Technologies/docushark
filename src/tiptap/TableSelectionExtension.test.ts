/**
 * TableSelection (JP-416) — the stroke-marquee overlay for a multi-cell
 * selection. This verifies the plugin wiring: a `.table-selection-marquee`
 * element is created inside the table wrapper exactly when the selection is a
 * `CellSelection`, and removed when it collapses. (Pixel positioning is
 * jsdom-untestable — `getBoundingClientRect` returns zeros — so we assert
 * presence/absence, not geometry.)
 */

import { describe, it, expect, afterEach } from 'vitest';
import { Editor } from '@tiptap/core';
import { CellSelection } from '@tiptap/pm/tables';
import { extensions } from '../ui/TiptapEditor';

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function cellPositions(ed: Editor): number[] {
  const out: number[] = [];
  ed.state.doc.descendants((node, pos) => {
    if (node.type.name === 'tableCell' || node.type.name === 'tableHeader') out.push(pos);
  });
  return out;
}

describe('TableSelection marquee', () => {
  it('adds a marquee on a CellSelection and removes it when collapsed', () => {
    const element = document.createElement('div');
    document.body.appendChild(element);
    editor = new Editor({
      element,
      extensions,
      content:
        '<table><tbody><tr><th>a</th><th>b</th></tr><tr><td>c</td><td>d</td></tr></tbody></table>',
    });

    const cells = cellPositions(editor);
    expect(cells.length).toBe(4);

    // Select the two header cells → a CellSelection spanning the top row.
    editor.commands.setCellSelection({ anchorCell: cells[0]!, headCell: cells[1]! });
    expect(editor.state.selection).toBeInstanceOf(CellSelection);

    const wrapper = editor.view.dom.querySelector('.tableWrapper');
    expect(wrapper).not.toBeNull();
    expect(wrapper!.querySelector('.table-selection-marquee')).not.toBeNull();

    // Collapse to a plain caret → marquee gone.
    editor.commands.setTextSelection(cells[0]! + 1);
    expect(editor.state.selection).not.toBeInstanceOf(CellSelection);
    expect(wrapper!.querySelector('.table-selection-marquee')).toBeNull();
  });
});
