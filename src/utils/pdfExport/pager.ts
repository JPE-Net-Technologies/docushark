/**
 * Page breaks (DSK-252).
 *
 * Every page the layout starts goes through the pager, which records where it
 * fell: the prose page, the block's index path from that page's root (and its
 * durable id, where it has one) and, inside a block, the line, table row or
 * code line that opens the new page. The PDF and a measure-only layout record
 * the same list, which is how Paper Mode can show the PDF's pages without
 * writing one.
 */

import type { JSONContent } from '@tiptap/core';

/** A text position inside a block: its inline child, and a character offset into it. */
export interface InlinePosition {
  child: number;
  offset: number;
}

/** What opens a page. */
export type BreakAt =
  /** A whole block. */
  | { kind: 'block'; path: number[]; blockId?: string }
  /** A line inside a paragraph or heading, from its first character. */
  | { kind: 'line'; path: number[]; blockId?: string; line: number; inline?: InlinePosition }
  /** A table row. */
  | { kind: 'row'; path: number[]; row: number }
  /** A line inside a code block. */
  | { kind: 'codeLine'; path: number[]; blockId?: string; line: number }
  /** The start of a prose page, a diagram page, or the first page after the cover. */
  | { kind: 'section'; section: 'prose' | 'diagram' | 'afterCover'; index: number };

export interface PageBreak {
  /** The page that starts here: 1-based, counting the cover, before contents pages are added. */
  page: number;
  /** The prose page being laid out when the break fell, if any. */
  pageId: string | undefined;
  at: BreakAt;
}

/** Collects the breaks of one layout, in order. */
export class Pager {
  readonly breaks: PageBreak[] = [];

  record(page: number, pageId: string | undefined, at: BreakAt): void {
    this.breaks.push({ page, pageId, at });
  }
}

/** A block's durable id (headings, paragraphs and code blocks carry one), if it has one. */
export function blockIdOf(node: JSONContent | undefined): string | undefined {
  const id = node?.attrs?.['id'];
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/** `{ blockId }` when there is one, else nothing (optional properties stay absent). */
export function withBlockId(node: JSONContent | undefined): { blockId?: string } {
  const blockId = blockIdOf(node);
  return blockId === undefined ? {} : { blockId };
}
