import { Extension } from '@tiptap/core';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { useUIPreferencesStore } from '../store/uiPreferencesStore';

/**
 * CaretExtension (JP-259) — a custom prose caret that **glides** between
 * positions instead of jumping, with selectable shapes (bar / block) from
 * Appearance settings.
 *
 * It draws a single overlay element positioned from `coordsAtPos(selection.head)`
 * and moves it with a CSS transform transition (the smooth/"smooth writing"
 * experience — opt-out, on by default). It does NOT touch the text DOM (unlike
 * the abandoned per-character decoration approach, which churned the document and
 * blinked the text). The native caret is hidden only when a custom caret is
 * active (block shape, or smooth on); a plain bar with smooth off keeps the
 * native caret untouched.
 *
 * The overlay lives in the editor's scroll container (`.tiptap-editor`), never
 * inside the contenteditable, so it can't pollute the document or selection.
 * Being an absolute child of the scroller, it scrolls with the content for free.
 */

const CARET_PLUGIN_KEY = new PluginKey('docusharkCaret');

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/** Resolve the app motion preference (system follows the OS setting). */
function motionReduced(): boolean {
  const m = useUIPreferencesStore.getState().appearancePrefs.motion;
  if (m === 'reduced') return true;
  if (m === 'full') return false;
  return prefersReducedMotion();
}

class CaretView {
  private caret: HTMLElement;
  private host: HTMLElement;
  private unsub: () => void;
  private onResize: () => void;

  constructor(view: EditorView) {
    this.caret = document.createElement('div');
    this.caret.className = 'ds-caret';
    this.caret.setAttribute('aria-hidden', 'true');

    this.host =
      (view.dom.closest('.tiptap-editor') as HTMLElement | null) ??
      view.dom.parentElement ??
      view.dom;
    this.host.classList.add('ds-caret-host');
    this.host.appendChild(this.caret);

    // Re-render the caret when caret prefs (or any appearance pref) change.
    this.unsub = useUIPreferencesStore.subscribe(() => this.render(view));
    this.onResize = () => this.render(view);
    window.addEventListener('resize', this.onResize);

    this.render(view);
  }

  update(view: EditorView): void {
    this.render(view);
  }

  private render(view: EditorView): void {
    const { caretStyle, smoothCaret } = useUIPreferencesStore.getState().appearancePrefs;

    // A custom caret is only needed for the block shape or the smooth glide; a
    // plain bar with smooth off is just the native caret.
    const custom = caretStyle === 'block' || smoothCaret;
    view.dom.classList.toggle('ds-caret-active', custom);
    if (!custom) {
      this.caret.style.display = 'none';
      return;
    }

    const sel = view.state.selection;
    // Only a collapsed selection in a focused editor gets a caret; a range shows
    // the native selection highlight instead.
    if (!view.hasFocus() || !sel.empty) {
      this.caret.style.display = 'none';
      return;
    }

    let coords: { left: number; right: number; top: number; bottom: number };
    try {
      coords = view.coordsAtPos(sel.head);
    } catch {
      this.caret.style.display = 'none';
      return;
    }

    const hostRect = this.host.getBoundingClientRect();
    const left = coords.left - hostRect.left + this.host.scrollLeft;
    const top = coords.top - hostRect.top + this.host.scrollTop;
    const height = Math.max(1, coords.bottom - coords.top);

    const isBlock = caretStyle === 'block';
    let width = 2;
    if (isBlock) {
      width = Math.max(4, Math.round(height * 0.55));
      // Prefer the width of the glyph the caret sits before, on the same line.
      try {
        const next = view.coordsAtPos(sel.head + 1);
        if (Math.abs(next.top - coords.top) < 1 && next.left > coords.left) {
          width = next.left - coords.left;
        }
      } catch {
        /* keep the fallback width */
      }
    }

    const smooth = smoothCaret && !motionReduced();
    this.caret.classList.toggle('ds-caret--block', isBlock);
    this.caret.classList.toggle('ds-caret--smooth', smooth);

    this.caret.style.display = 'block';
    this.caret.style.width = `${width}px`;
    this.caret.style.height = `${height}px`;
    this.caret.style.transform = `translate(${left}px, ${top}px)`;

    // Restart the blink so the caret is solid the instant it moves (feels
    // responsive while typing) and resumes blinking when idle.
    this.caret.style.animation = 'none';
    void this.caret.offsetWidth;
    this.caret.style.animation = '';
  }

  destroy(): void {
    this.unsub();
    window.removeEventListener('resize', this.onResize);
    this.caret.remove();
  }
}

export const CaretExtension = Extension.create({
  name: 'docusharkCaret',

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: CARET_PLUGIN_KEY,
        view: (view) => new CaretView(view),
      }),
    ];
  },
});

export default CaretExtension;
