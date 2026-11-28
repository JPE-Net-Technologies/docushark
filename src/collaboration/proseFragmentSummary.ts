/**
 * A writing page's first heading and word count, read from its shared content
 * (DSK-260).
 *
 * In a shared document a page's text lives in its `prose:<id>` fragment. The
 * page store's HTML is current only for the page being edited on this screen,
 * so names and counts for the other pages come from here.
 */

import * as Y from 'yjs';

export interface ProsePageSummary {
  /** The first heading's text, or null when the page has none (or it's empty). */
  heading: string | null;
  /** Words, counted as `countWordsInHtml` counts them: runs of non-space. */
  words: number;
}

type XmlNode = Y.XmlElement | Y.XmlText | Y.XmlHook;

/** A node's text. A block's runs join with nothing between them; blocks end with a space. */
function textOf(node: XmlNode): string {
  if (node instanceof Y.XmlText) {
    return node
      .toDelta()
      .map((op: { insert?: unknown }) => (typeof op.insert === 'string' ? op.insert : ' '))
      .join('');
  }
  if (node instanceof Y.XmlElement) {
    return `${node.toArray().map((child) => textOf(child as XmlNode)).join('')} `;
  }
  return '';
}

function firstHeading(nodes: XmlNode[]): Y.XmlElement | null {
  for (const node of nodes) {
    if (!(node instanceof Y.XmlElement)) continue;
    if (node.nodeName === 'heading') return node;
    const inner = firstHeading(node.toArray() as XmlNode[]);
    if (inner) return inner;
  }
  return null;
}

/** Just the first heading's text: what a page's label needs, without reading the rest. */
export function proseFragmentHeading(fragment: Y.XmlFragment): string | null {
  const node = firstHeading(fragment.toArray() as XmlNode[]);
  const text = node ? textOf(node).replace(/\s+/g, ' ').trim() : '';
  return text === '' ? null : text;
}

export function summarizeProseFragment(fragment: Y.XmlFragment): ProsePageSummary {
  const nodes = fragment.toArray() as XmlNode[];
  const headingNode = firstHeading(nodes);
  const headingText = headingNode ? textOf(headingNode).replace(/\s+/g, ' ').trim() : '';
  const text = nodes.map(textOf).join(' ').trim();
  return {
    heading: headingText === '' ? null : headingText,
    words: text === '' ? 0 : text.split(/\s+/).length,
  };
}
