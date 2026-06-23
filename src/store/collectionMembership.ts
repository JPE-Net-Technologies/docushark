import type { DiagramDocument } from '../types/Document';

/**
 * Reconcile a relay-save body's `collectionId` to the canonical client store
 * assignment, so a content-save can't erase the relay's membership (the relay
 * derives metadata wholesale from the body) (JP-159). Pure + import-free so it's
 * trivially unit-testable and carries no module-cycle risk.
 *
 * - assigned → stamp `collectionId` onto the body.
 * - unassigned → strip a stale `collectionId` **only when `isListed`** (the doc
 *   has appeared in a relay list, i.e. reconcile has run), so a save right after
 *   connect can't drop membership the store hasn't hydrated yet.
 */
export function stampCollectionMembership(
  doc: DiagramDocument,
  assignment: string | undefined,
  isListed: boolean,
): DiagramDocument {
  if (assignment) {
    return doc.collectionId === assignment ? doc : { ...doc, collectionId: assignment };
  }
  if (doc.collectionId !== undefined && isListed) {
    const { collectionId: _unassigned, ...rest } = doc;
    return rest;
  }
  return doc;
}
