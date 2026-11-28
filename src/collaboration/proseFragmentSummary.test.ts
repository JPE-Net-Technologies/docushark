/**
 * A writing page's first heading and word count from its shared content
 * (DSK-260): what names and counts read in a shared document.
 */
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { summarizeProseFragment } from './proseFragmentSummary';
import { YjsDocument } from './YjsDocument';

function block(name: string, ...runs: (string | [string, Record<string, unknown>])[]): Y.XmlElement {
  const el = new Y.XmlElement(name);
  const text = new Y.XmlText();
  el.insert(0, [text]);
  let at = 0;
  for (const run of runs) {
    const [s, attrs] = typeof run === 'string' ? [run, undefined] : run;
    text.insert(at, s, attrs);
    at += s.length;
  }
  return el;
}

function fragmentOf(...blocks: Y.XmlElement[]): Y.XmlFragment {
  const doc = new Y.Doc();
  const fragment = doc.getXmlFragment('prose:p1');
  fragment.insert(0, blocks);
  return fragment;
}

describe('summarizeProseFragment', () => {
  it('reads the first heading, keeping formatted runs together', () => {
    const summary = summarizeProseFragment(
      fragmentOf(block('paragraph', 'Intro text'), block('heading', 'Sync ', ['protocol', { bold: true }]), block('heading', 'Later')),
    );
    expect(summary.heading).toBe('Sync protocol');
  });

  it('finds a heading inside another block', () => {
    const quote = new Y.XmlElement('blockquote');
    quote.insert(0, [block('heading', 'Quoted title')]);
    expect(summarizeProseFragment(fragmentOf(quote)).heading).toBe('Quoted title');
  });

  it('counts words across blocks, not across a formatted run', () => {
    const summary = summarizeProseFragment(
      fragmentOf(block('heading', 'Two words'), block('paragraph', 'one', ['two', { italic: true }], ' three')),
    );
    // "onetwo" is one word: the italic run continues it.
    expect(summary.words).toBe(4);
  });

  it('is empty for an empty page, and has no heading without one', () => {
    expect(summarizeProseFragment(fragmentOf())).toEqual({ heading: null, words: 0 });
    expect(summarizeProseFragment(fragmentOf(block('paragraph', 'text'))).heading).toBeNull();
    expect(summarizeProseFragment(fragmentOf(block('heading', '   '))).heading).toBeNull();
  });

  it('is what YjsDocument reports for a page', () => {
    const doc = new YjsDocument();
    doc.getDoc().getXmlFragment('prose:p1').insert(0, [block('heading', 'Overview'), block('paragraph', 'a b c')]);
    expect(doc.getProsePageSummary('p1')).toEqual({ heading: 'Overview', words: 4 });
  });
});
