/**
 * Write provenance — the single source of truth for *who* is writing to the
 * document right now, so every content producer is collab-safe by construction
 * instead of re-deriving ad-hoc guards (JP-184 / JP-192, Slice 1).
 *
 * It unifies flags that previously each encoded one slice of "is this a real
 * user delta the CRDT should propagate?":
 *   - `documentStore.lastChangeKind` (`'replace'` ⇒ a load) — now derived here.
 *   - `useCollaborationSync.isApplyingRemoteChanges` (the bridge re-applying an
 *     inbound CRDT change) — now `runWithProvenance('remote-apply', …)`.
 *   (`autoSaveGuard` stays an independent belt-and-suspenders flag for now;
 *    folded in by Slice 3 — JP-194.)
 *
 * Rule the collab bridge enforces: a `documentStore` mutation is diffed into the
 * CRDT only for `user-edit` and `programmatic` provenance. `load` and
 * `remote-apply` are NOT human-authored deltas and must never be diffed as
 * edits — that is the #59 mass-deletion class of bug.
 *
 * CONTRACT: the callbacks passed to `runWithProvenance`/`mutateDocument` MUST be
 * synchronous. Provenance is an ambient flag set only for the synchronous
 * duration of the call (it relies on Zustand notifying subscribers synchronously
 * inside `set()`). An `async` callback returns before its writes run, so those
 * writes land under the wrong provenance — the guard below throws on that misuse
 * (JP-197). Do async work *outside*, then write synchronously inside.
 */

export type Provenance =
  /** A live human edit — the default when nothing sets otherwise. */
  | 'user-edit'
  /** App/agent/import-generated content. Propagates to the CRDT, but is not a
   *  human edit (lets consumers treat it distinctly when they need to). */
  | 'programmatic'
  /** The bridge applying an inbound CRDT change to the local store. */
  | 'remote-apply'
  /** A programmatic whole-store load/replace: snapshot restore, page switch,
   *  `clear`. Never a per-shape user delta. */
  | 'load';

let current: Provenance = 'user-edit';

/** The active write provenance. Readers (e.g. the collab bridge) gate on this. */
export function getProvenance(): Provenance {
  return current;
}

/**
 * Run `fn` with the active write provenance set to `provenance`, restoring the
 * previous value on exit. Nestable — a `clear()` (`load`) invoked inside a
 * `remote-apply` block, or a load inside a load, unwinds to the right value.
 *
 * Zustand notifies subscribers **synchronously inside `set()`**, so any store
 * mutation dispatched within `fn` is observed by the collab bridge while this
 * provenance holds — no async bookkeeping needed.
 */
export function runWithProvenance<T>(provenance: Provenance, fn: () => T): T {
  const previous = current;
  current = provenance;
  let result: T;
  try {
    result = fn();
  } finally {
    // Restore BEFORE the async-misuse check, so a throw never leaks provenance.
    current = previous;
  }
  // A thenable return means the callback was async: its writes run after we've
  // already restored provenance, so they'd be mis-tagged. Surface it loudly — a
  // silent mis-tag (e.g. a programmatic bulk write read as a user edit) is far
  // worse than a crash. See the CONTRACT note above (JP-197).
  if (isThenable(result)) {
    throw new Error(
      '[writeProvenance] callback must be synchronous — provenance does not survive an ' +
        '`await` (the write would be mis-tagged). Do async work outside, then write ' +
        'synchronously inside runWithProvenance/mutateDocument.',
    );
  }
  return result;
}

function isThenable(value: unknown): boolean {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { then?: unknown }).then === 'function'
  );
}

/**
 * The canonical client write entrypoint (JP-184). Content producers — canvas
 * tools, importers, prose injectors (Slice 2), the dictionary update, auto-gen —
 * route writes through here so provenance is attached by construction rather
 * than re-derived per writer.
 *
 * In Slice 1 `mutate` performs the existing store/CRDT writes (no dataflow
 * inversion); the typed op-as-data stream that lets the bridge consume ops
 * instead of diffing the whole store layers on later (JP-195).
 */
export function mutateDocument<T>(
  provenance: 'user-edit' | 'programmatic',
  mutate: () => T,
): T {
  return runWithProvenance(provenance, mutate);
}
