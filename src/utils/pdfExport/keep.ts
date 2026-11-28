/**
 * Keeping a heading with what follows it (DSK-252).
 *
 * A heading shouldn't end a page: it moves to the next page unless this one
 * also holds the start of what follows. That start is measured by laying the
 * following blocks out on a scratch context: the same renderers, on a
 * `MeasureDoc`, with a pager that only notes where things end and never
 * breaks. So the rule can't drift from the layout it predicts.
 */

import type { PDFRenderContext } from './context';
import { MeasureDoc } from './doc';
import { type LeadLog, Pager } from './pager';
import { renderNode } from './registry';

/** How many lines of what follows a heading stay with it. */
export const KEEP_WITH_NEXT_LINES = 2;

/**
 * Blocks whose start is their first lines of text. Any other block (a table, a
 * code block, an image, a rule) starts with the room it asks for at its top: a
 * table's first rows, a code block whole or its first lines, an image whole.
 */
const STARTS_WITH_TEXT = new Set([
  'paragraph', 'bulletList', 'orderedList', 'taskList', 'listItem', 'taskItem',
  'blockquote', 'callout', 'bibliography',
]);

/**
 * How far below `startY` the start of what follows the node being laid out
 * ends: the height a heading must share its page with. A run of headings
 * counts whole, with the start of the block after it. Zero when nothing
 * follows, and while measuring (a scratch layout doesn't look ahead).
 */
export async function leadAfter(ctx: PDFRenderContext, startY: number, listLevel: number): Promise<number> {
  if (ctx.pager.lead) return 0;
  const following = ctx.following[ctx.following.length - 1] ?? [];
  if (following.length === 0) return 0;

  const log: LeadLog = { lines: [] };
  const scratch: PDFRenderContext = {
    ...ctx,
    doc: new MeasureDoc(ctx.doc),
    pager: new Pager(log),
    path: [...ctx.path],
    blocks: [...ctx.blocks],
    following: [],
    y: startY,
    pageIdToPdfPage: { ...ctx.pageIdToPdfPage },
    collectedHeadings: [],
    deferredHeadingLinks: [],
  };

  for (const next of following) {
    const heading = next.type === 'heading';
    if (!heading) {
      // Measure the block after the headings from its own start.
      delete log.first;
      log.lines.length = 0;
    }
    await renderNode(scratch, next, listLevel);
    if (!heading) {
      // The block's own first requirement (the room it asks for before it
      // draws anything), and for text, its first two lines: whichever ends lower.
      const asked = log.first ?? scratch.y;
      const end = STARTS_WITH_TEXT.has(next.type ?? '')
        ? Math.max(asked, log.lines[KEEP_WITH_NEXT_LINES - 1] ?? log.lines[log.lines.length - 1] ?? scratch.y)
        : asked;
      return end - startY;
    }
  }
  // Only headings follow: they all stay together.
  return scratch.y - startY;
}
