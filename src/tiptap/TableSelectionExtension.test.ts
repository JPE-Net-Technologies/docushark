/**
 * TableSelection (JP-416) — the stroke-marquee overlay for a multi-cell
 * selection. Verifies the plugin wiring: the `.table-selection-marquee` overlay
 * shows when the selection is a `CellSelection` and hides when it collapses, and
 * — critically — that it lives OUTSIDE the contenteditable. Appending it inside
 * the table wrapper tripped ProseMirror's DOM observer (TableView.ignoreMutation
 * only ignores `attributes`, not `childList`) and crashed the editor; this test
 * guards against that regression. (Pixel geometry is jsdom-untestable —
 * getBoundingClientRect returns zeros — so we assert visibility + placement.)
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
  it('shows on a CellSelection, hides when collapsed, and stays outside the contenteditable', () => {
    const host = document.createElement('div');
    host.className = 'tiptap-editor';
    document.body.appendChild(host);
    const element = document.createElement('div');
    host.appendChild(element);
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

    const marquee = host.querySelector('.table-selection-marquee') as HTMLElement | null;
    expect(marquee).not.toBeNull();
    expect(marquee!.style.display).toBe('block');
    // The crash regression guard: never inside the editable content DOM.
    expect(editor.view.dom.contains(marquee)).toBe(false);

    // Collapse to a plain caret → marquee hidden (element stays, just display:none).
    editor.commands.setTextSelection(cells[0]! + 1);
    expect(editor.state.selection).not.toBeInstanceOf(CellSelection);
    expect(marquee!.style.display).toBe('none');
  });
});
