/**
 * Which document the editor has open, as seen by the collab sync layer
 * (DSK-192).
 *
 * The persistence store owns `currentDocumentId` and registers a reader here.
 * The collaboration store checks every store→CRDT write against it, so a
 * session left bound to a previously open document can no longer receive the
 * new document's writes.
 *
 * This module deliberately imports nothing. The two stores sit in an import
 * cycle (collaborationStore → … → persistenceStore → collaboration), so a
 * registration call that crossed that cycle could run before its target module
 * had finished evaluating. A leaf module is always fully evaluated when either
 * store reaches it.
 */

let source: (() => string | null) | null = null;

/** Register (or, with `null`, clear) the open-document reader. */
export function registerOpenDocumentIdSource(next: (() => string | null) | null): void {
  source = next;
}

/** Whether a reader is registered. Without one, the sync guard stands aside. */
export function hasOpenDocumentIdSource(): boolean {
  return source !== null;
}

/** The open document's id: `null` for an unsaved document, `undefined` with no reader. */
export function readOpenDocumentId(): string | null | undefined {
  return source?.();
}
