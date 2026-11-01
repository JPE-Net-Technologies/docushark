/**
 * The "Continue working" strip's documents (JP-444): the most recently edited.
 *
 * It took the first six of the list as currently sorted, so sorting by name
 * (or size) filled a strip promising recent work with whatever came first
 * alphabetically (DSK-196). The strip is about recency whatever the list's
 * order.
 */

import type { DocumentRecord } from '../../types/DocumentRegistry';

/** How many documents the strip shows. */
export const CONTINUE_WORKING_COUNT = 6;

export function pickContinueWorking(
  documents: readonly DocumentRecord[],
  count: number = CONTINUE_WORKING_COUNT,
): DocumentRecord[] {
  return [...documents].sort((a, b) => b.modifiedAt - a.modifiedAt).slice(0, count);
}
