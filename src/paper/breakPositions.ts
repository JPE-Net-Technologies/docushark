/**
 * Where the PDF's page breaks fall in the editor's document (DSK-48).
 *
 * The paginator (`src/utils/pdfExport/paginate.ts`) names each break by an
 * index path from the prose page's root and, inside a block, the line's inline
 * child and character offset, the table row, or the code offset. Those map
 * straight to ProseMirror positions in the same page's document.
 */

import type { Node as PMNode } from '@tiptap/pm/model';
import type { BreakAt } from '../utils/pdfExport/paginate';

/** Where a break goes: before a block, inside text, or on a table row. */
export type BreakPosition =
  | { kind: 'block'; pos: number }
  | { kind: 'inline'; pos: number }
  | { kind: 'row'; pos: number; end: number };

/** The node an index path leads to from `doc`, and the position before it. */
function nodeAtPath(doc: PMNode, path: number[]): { node: PMNode; pos: number } | null {
  if (path.length === 0) return null;
  let parent = doc;
  let contentStart = 0;
  for (let depth = 0; depth < path.length; depth++) {
    const index = path[depth]!;
    if (index < 0 || index >= parent.childCount) return null;
    let pos = contentStart;
    for (let i = 0; i < index; i++) pos += parent.child(i).nodeSize;
    const node = parent.child(index);
    if (depth === path.length - 1) return { node, pos };
    parent = node;
    contentStart = pos + 1;
  }
  return null;
}

/** The position `offset` characters into a block's text, from inline child `child`. */
function inlinePosition(block: PMNode, blockPos: number, child: number, offset: number): number {
  let pos = blockPos + 1;
  const index = Math.min(child, block.childCount);
  for (let i = 0; i < index; i++) pos += block.child(i).nodeSize;
  const target = block.maybeChild(index);
  // Inside a text node by its offset; an atom (a citation, a field) can't be split.
  if (target?.isText) pos += Math.max(0, Math.min(offset, target.text!.length));
  return pos;
}

/** The position in a code block's text `offset` characters in. */
function textPosition(block: PMNode, blockPos: number, offset: number): number {
  return blockPos + 1 + Math.max(0, Math.min(offset, block.content.size));
}

/**
 * Where a break falls in `doc`, the prose page it was laid out from; null for
 * breaks that don't fall inside it (the start of another prose page, a
 * diagram page) or that no longer resolve.
 */
export function positionOfBreak(doc: PMNode, at: BreakAt): BreakPosition | null {
  if (at.kind === 'section') return null;
  const found = nodeAtPath(doc, at.path);
  if (!found) return null;
  const { node, pos } = found;
  switch (at.kind) {
    case 'block':
      return { kind: 'block', pos };
    case 'line':
      if (!node.inlineContent) return { kind: 'block', pos };
      return at.inline ? { kind: 'inline', pos: inlinePosition(node, pos, at.inline.child, at.inline.offset) } : { kind: 'block', pos };
    case 'codeLine':
      return { kind: 'inline', pos: textPosition(node, pos, at.offset) };
    case 'row': {
      const row = node.type.name === 'table' ? node.maybeChild(at.row) : null;
      if (!row) return null;
      let rowPos = pos + 1;
      for (let i = 0; i < at.row; i++) rowPos += node.child(i).nodeSize;
      return { kind: 'row', pos: rowPos, end: rowPos + row.nodeSize };
    }
  }
}
