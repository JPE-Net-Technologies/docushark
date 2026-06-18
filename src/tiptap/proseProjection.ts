/**
 * Prose "projection" transactions (JP-89 foundation for prose helpers).
 *
 * A *prose-helper* node (citations are the first; more will follow) caches
 * derived content on itself — e.g. an inline citation's formatted label, or a
 * bibliography's rendered HTML — by writing it back into the node's attributes
 * via a ProseMirror transaction. That write is **derived data, not a user
 * edit**: it must update the node (so the cached value persists on the next
 * genuine save) but must NEVER mark the document dirty, schedule an autosave, or
 * mint a document id.
 *
 * The mechanism: the write-back tags its transaction with
 * {@link PROSE_PROJECTION_META}; the editor's prose mirror (`onUpdate`) routes
 * such transactions through a **non-dirtying** content update
 * (`richTextStore.setContentSilently`) instead of the normal dirtying one. This
 * is generic — any future prose helper reuses it, no per-node special-casing.
 *
 * ## The invariant — never dispatch a projection synchronously from a node view
 *
 * Node views render **during** ProseMirror's view reconciliation. A *synchronous*
 * `editor.view.dispatch` from inside a node view's `render`/`update` re-enters the
 * view tree while it is still being built and crashes with
 * `Cannot read properties of undefined (reading 'children')`. So projection
 * write-backs MUST be deferred to a microtask. Do not hand-roll that — always go
 * through {@link scheduleProjectionWriteBack}, which is deferred by construction.
 */

import type { Editor } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { Transaction } from '@tiptap/pm/state';
import { isAutoSaveSuppressed } from '../store/autoSaveGuard';

/** Transaction meta key marking a derived/projection write (not a user edit). */
export const PROSE_PROJECTION_META = 'proseProjection';

/** True if `tr` is a projection write-back (derived cache, not a user edit). */
export function isProjectionTransaction(tr: Transaction): boolean {
  return tr.getMeta(PROSE_PROJECTION_META) === true;
}

export interface ProjectionWriteBackOptions {
  /** The editor the node view belongs to. */
  editor: Editor;
  /** Tiptap's node-view `getPos` (a function, or `boolean` when unavailable). */
  getPos: (() => number | undefined) | boolean;
  /** The node's type name (`this.name` inside the extension). */
  nodeName: string;
  /**
   * Extra identity guard so a stale `pos` can never write onto a *different*
   * node of the same type (e.g. match on `name`/`refId`). Defaults to "match".
   */
  identity?: (node: PMNode) => boolean;
  /** The derived attrs to merge into the node. Skipped if already equal. */
  attrs: Record<string, unknown>;
}

/**
 * Persist derived attrs back onto a node from inside its node view — **safely**.
 *
 * The dispatch is always deferred to a microtask (so it runs *after* the current
 * view reconciliation, never re-entrantly — see the invariant above), tagged as a
 * projection (`addToHistory:false` + {@link PROSE_PROJECTION_META}, so it never
 * dirties the doc or enters undo), and re-validated at execution time (position,
 * type, and `identity` may have changed since it was queued). Idempotent: if every
 * target attr already equals the node's, nothing is dispatched — so a page of
 * many such nodes converges instead of looping.
 *
 * Only for **derived/projection** writes. A genuine *user edit* (a layout toggle,
 * a float choice) must keep history and dirty the doc, so it dispatches directly
 * from its event handler — not through here.
 */
export function scheduleProjectionWriteBack(opts: ProjectionWriteBackOptions): void {
  const { editor, getPos, nodeName, identity, attrs } = opts;
  queueMicrotask(() => {
    if (!editor.isEditable) return; // view-only clients never dirty the doc
    if (isAutoSaveSuppressed()) return; // never dispatch during load/new/switch
    const pos = typeof getPos === 'function' ? getPos() : undefined;
    if (pos == null) return;
    const cur = editor.state.doc.nodeAt(pos);
    if (!cur || cur.type.name !== nodeName) return;
    if (identity && !identity(cur)) return; // pos went stale → wrong node, skip
    // Idempotent → loop-safe: skip when the node already carries these values.
    if (Object.entries(attrs).every(([k, v]) => cur.attrs[k] === v)) return;
    const tr = editor.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, ...attrs });
    tr.setMeta('addToHistory', false); // derived cache → out of undo
    tr.setMeta(PROSE_PROJECTION_META, true); // derived write → mirror silently, no autosave
    editor.view.dispatch(tr);
  });
}
