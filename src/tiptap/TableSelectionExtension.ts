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
 * one `pointer-events:none` overlay sized to the union rectangle of the selected
 * cells — a crisp outline around the whole block.
 *
 * The overlay lives in the editor's scroll container (`.tiptap-editor`), **never
 * inside the contenteditable** — exactly like `CaretExtension`. An earlier
 * version appended it inside the table's `.tableWrapper`; that's a `childList`
 * mutation the Tiptap `TableView.ignoreMutation` does NOT ignore (it only
 * ignores `attributes` on the table/colgroup), so ProseMirror's DOM observer
 * tried to reconcile the foreign node and desynced — breaking selection and
 * crashing the editor. Being an absolute child of the scroll container, the
 * marquee is positioned from viewport coords and tracks scroll via a listener,
 * so it can't pollute the document or selection.
 */

const TABLE_SELECTION_PLUGIN_KEY = new PluginKey('docusharkTableSelection');

/**
 * Gated drag diagnostic (JP-416): set `localStorage.dsTableDebug = '1'` and
 * reload, then drag across cells — the console shows whether each mousemove sees
 * a different cell and what selection forms, so we can pin why a cross-cell drag
 * stays a TextSelection (prosemirror-tables clamps cross-cell text to one cell;
 * only `handleMouseDown`'s drag detection upgrades to a CellSelection). Inert
 * unless the flag is set.
 */
function tableDebugOn(): boolean {
  try {
    return typeof localStorage !== 'undefined' && localStorage.getItem('dsTableDebug') === '1';
  } catch {
    return false;
  }
}

function cellOf(node: EventTarget | null): HTMLElement | null {
  let el = node as HTMLElement | null;
  for (; el; el = el.parentElement) {
    if (el.nodeName === 'TD' || el.nodeName === 'TH') return el;
  }
  return null;
}

class TableSelectionView {
  private marquee: HTMLDivElement;
  private host: HTMLElement;
  private onScroll: () => void;
  private onResize: () => void;
  private rafId = 0;

  constructor(view: EditorView) {
    this.marquee = document.createElement('div');
    this.marquee.className = 'table-selection-marquee';
    this.marquee.setAttribute('aria-hidden', 'true');
    this.marquee.style.display = 'none';

    this.host =
      (view.dom.closest('.tiptap-editor') as HTMLElement | null) ??
      view.dom.parentElement ??
      view.dom;
    this.host.appendChild(this.marquee);

    // Reposition on scroll (capture phase: inner scrollers — the editor's own
    // vertical scroll and a table wrapper's horizontal scroll — don't bubble)
    // and on resize, rAF-throttled.
    this.onScroll = () => {
      if (this.rafId) return;
      this.rafId = requestAnimationFrame(() => {
        this.rafId = 0;
        this.render(view);
      });
    };
    this.onResize = () => this.render(view);
    window.addEventListener('scroll', this.onScroll, { capture: true, passive: true });
    window.addEventListener('resize', this.onResize);

    this.attachDebug(view);
    this.render(view);
  }

  /** Drag diagnostic — only active behind the `dsTableDebug` flag. */
  private attachDebug(view: EditorView): void {
    view.dom.addEventListener('mousedown', (e) => {
      if (!tableDebugOn() || (e as MouseEvent).button !== 0) return;
      const startCell = cellOf(e.target);
      // eslint-disable-next-line no-console
      console.log('[dsTable] mousedown', { target: (e.target as HTMLElement)?.nodeName, inCell: !!startCell });
      const move = (me: MouseEvent) => {
        const c = cellOf(me.target);
        const pc = view.posAtCoords({ left: me.clientX, top: me.clientY });
        // eslint-disable-next-line no-console
        console.log('[dsTable] move', {
          target: (me.target as HTMLElement)?.nodeName,
          inCell: !!c,
          differentCell: !!c && c !== startCell,
          posAtCoords: pc?.pos ?? null,
          selection: view.state.selection.constructor.name,
        });
      };
      const up = () => {
        document.removeEventListener('mousemove', move);
        document.removeEventListener('mouseup', up);
        // eslint-disable-next-line no-console
        console.log('[dsTable] mouseup → selection', view.state.selection.constructor.name);
      };
      document.addEventListener('mousemove', move);
      document.addEventListener('mouseup', up);
    });
  }

  update(view: EditorView): void {
    this.render(view);
  }

  private render(view: EditorView): void {
    // A marquee glitch must never crash the editor — fail closed (hidden).
    try {
      const sel = view.state.selection;
      if (!(sel instanceof CellSelection)) {
        this.marquee.style.display = 'none';
        return;
      }

      // Union the viewport rects of every selected cell.
      let top = Infinity;
      let left = Infinity;
      let right = -Infinity;
      let bottom = -Infinity;
      sel.forEachCell((_node, pos) => {
        const dom = view.nodeDOM(pos) as HTMLElement | null;
        if (!dom || typeof dom.getBoundingClientRect !== 'function') return;
        const r = dom.getBoundingClientRect();
        top = Math.min(top, r.top);
        left = Math.min(left, r.left);
        right = Math.max(right, r.right);
        bottom = Math.max(bottom, r.bottom);
      });
      if (!Number.isFinite(top)) {
        this.marquee.style.display = 'none';
        return;
      }

      // Position against the marquee's actual offset parent (resolved only once
      // it's displayed), converting viewport coords to the scroller's content
      // coords so it stays glued as the editor / table wrapper scrolls.
      this.marquee.style.display = 'block';
      const offsetParent = (this.marquee.offsetParent as HTMLElement | null) ?? this.host;
      const op = offsetParent.getBoundingClientRect();
      const x = left - op.left + offsetParent.scrollLeft;
      const y = top - op.top + offsetParent.scrollTop;
      this.marquee.style.transform = `translate(${x}px, ${y}px)`;
      this.marquee.style.width = `${Math.max(0, right - left)}px`;
      this.marquee.style.height = `${Math.max(0, bottom - top)}px`;
    } catch {
      this.marquee.style.display = 'none';
    }
  }

  destroy(): void {
    window.removeEventListener('scroll', this.onScroll, true);
    window.removeEventListener('resize', this.onResize);
    if (this.rafId) cancelAnimationFrame(this.rafId);
    this.marquee.remove();
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
