/**
 * Pre-save flushes (DSK-199): live editors copy what they hold into the stores
 * a save serializes, immediately before it serializes them.
 *
 * The local prose editor mirrors its content into `richTextPagesStore` (the
 * copy a reload reads back) on page switch, on unmount and every five seconds,
 * and a save serialized that store as it stood. Text typed since the last copy
 * missed every save, including the unload and app-switch flushes, so a reload
 * or a killed background app lost it, and the stale copy was saved back. A
 * flush registered here runs inside every document build, so no save path can
 * miss the editor's latest content.
 *
 * A leaf module, so the persistence store and the editor panel can both import
 * it without importing each other.
 */

type PreSaveFlush = () => void;

const flushes = new Set<PreSaveFlush>();

/** Register a flush; returns its unregister function (an effect's cleanup). */
export function registerPreSaveFlush(fn: PreSaveFlush): () => void {
  flushes.add(fn);
  return () => {
    flushes.delete(fn);
  };
}

/**
 * Run every registered flush. A failing flush is reported and skipped: the save
 * still goes ahead with what the stores hold, which is never worse than not
 * flushing.
 */
export function runPreSaveFlushes(): void {
  for (const fn of flushes) {
    try {
      fn();
    } catch (err) {
      console.error('[preSaveFlush] a flush failed; saving what the stores hold:', err);
    }
  }
}
