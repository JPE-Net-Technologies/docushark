import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { CellSelection } from '@tiptap/pm/tables';
import type { EditorView } from '@tiptap/pm/view';

/**
 * TableSelection (JP-416) — draws a single stroked **marquee** around the active
 * multi-cell selection instead of the flat per-cell fill, which reads as
 * unrefined.
 *
 * Tiptap/prosemirror-tables marks each selected cell with a `.selectedCell`
 * class; the app styles that with a faint tint (see TiptapEditor.css). On top of
 * that, when the current selection is a `CellSelection`, this plugin positions
 * one `pointer-events:none` overlay div sized to the union rectangle of the
 * selected cells, giving a crisp 2px outline around the whole block.
 *
 * The overlay lives inside the table's `.tableWrapper` (which is
 * `position: relative` and the horizontal-scroll container), so it scrolls with
 * the table content for free — no scroll listener needed. It is never inside the
 * contenteditable's content DOM, so it can't pollute the document or selection.
 * Inert outside a CellSelection (so read-only `ProsePreview`, where no
 * CellSelection forms, never shows it).
 */

const TABLE_SELECTION_PLUGIN_KEY = new PluginKey('docusharkTableSelection');

class TableSelectionView {
  private marquee: HTMLDivElement | null = null;

  constructor(view: EditorView) {
    this.render(view);
  }

  update(view: EditorView): void {
    this.render(view);
  }

  private render(view: EditorView): void {
    const sel = view.state.selection;
    if (!(sel instanceof CellSelection)) {
      this.hide();
      return;
    }

    const anchorDOM = view.nodeDOM(sel.$anchorCell.pos) as HTMLElement | null;
    const wrapper = anchorDOM?.closest('.tableWrapper') as HTMLElement | null;
    if (!wrapper) {
      this.hide();
      return;
    }

    // Union the viewport rects of every selected cell.
    let top = Infinity;
    let left = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    sel.forEachCell((_node, pos) => {
      const dom = view.nodeDOM(pos) as HTMLElement | null;
      if (!dom) return;
      const r = dom.getBoundingClientRect();
      top = Math.min(top, r.top);
      left = Math.min(left, r.left);
      right = Math.max(right, r.right);
      bottom = Math.max(bottom, r.bottom);
    });
    if (!Number.isFinite(top)) {
      this.hide();
      return;
    }

    // Convert to the wrapper's scrolled-content coordinates. Because the marquee
    // is a child of the wrapper, these stay correct as the wrapper scrolls.
    const wr = wrapper.getBoundingClientRect();
    const m = this.ensure(wrapper);
    m.style.top = `${top - wr.top + wrapper.scrollTop}px`;
    m.style.left = `${left - wr.left + wrapper.scrollLeft}px`;
    m.style.width = `${right - left}px`;
    m.style.height = `${bottom - top}px`;
    m.style.display = 'block';
  }

  /** Ensure the marquee element exists and is parented to `wrapper`. */
  private ensure(wrapper: HTMLElement): HTMLDivElement {
    if (this.marquee && this.marquee.parentElement === wrapper) return this.marquee;
    this.hide();
    const m = document.createElement('div');
    m.className = 'table-selection-marquee';
    m.setAttribute('aria-hidden', 'true');
    wrapper.appendChild(m);
    this.marquee = m;
    return m;
  }

  private hide(): void {
    if (this.marquee) {
      this.marquee.remove();
      this.marquee = null;
    }
  }

  destroy(): void {
    this.hide();
  }
}

export const TableSelection = Extension.create({
  name: 'docusharkTableSelection',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: TABLE_SELECTION_PLUGIN_KEY,
        view: (view) => new TableSelectionView(view),
      }),
    ];
  },
});

export default TableSelection;
