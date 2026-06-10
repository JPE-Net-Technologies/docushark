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
 */

import type { Transaction } from '@tiptap/pm/state';

/** Transaction meta key marking a derived/projection write (not a user edit). */
export const PROSE_PROJECTION_META = 'proseProjection';

/** True if `tr` is a projection write-back (derived cache, not a user edit). */
export function isProjectionTransaction(tr: Transaction): boolean {
  return tr.getMeta(PROSE_PROJECTION_META) === true;
}
