/**
 * Suggested names for new documents (DSK-209).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { leadingHeadingName, nameFromText, namingMemory, suggestDocumentName, wordCount } from './documentNaming';

const schema = getSchema([StarterKit]);
const doc = (html: string) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parse(div);
};

describe('suggested names (DSK-209)', () => {
  it('takes the first heading, wherever it is', () => {
    expect(suggestDocumentName(doc('<p>Draft notes</p><h2>Quarterly Report</h2>'))).toBe('Quarterly Report');
  });

  it('falls back to the first line of text', () => {
    expect(suggestDocumentName(doc('<p></p><p>  Meeting   with legal </p>'))).toBe('Meeting with legal');
  });

  it('has nothing to suggest for an empty document', () => {
    expect(suggestDocumentName(doc('<p></p>'))).toBeNull();
  });

  it('cuts a long line at a word boundary', () => {
    const name = nameFromText('An unusually long first line that keeps going well past what fits in a title bar, really');
    expect(name).toBe('An unusually long first line that keeps going well past what…');
    expect(name!.length).toBeLessThanOrEqual(61);
  });

  it('knows a leading heading from a heading further down', () => {
    expect(leadingHeadingName(doc('<h1>Title</h1><p>Body</p>'))).toBe('Title');
    expect(leadingHeadingName(doc('<p>Body</p><h1>Title</h1>'))).toBeNull();
  });

  it('counts words', () => {
    expect(wordCount(doc('<p>one two</p><p>three</p>'))).toBe(3);
  });
});

describe('what the browser remembers (DSK-209)', () => {
  beforeEach(() => localStorage.clear());

  it('remembers prompted and declined documents', () => {
    expect(namingMemory.wasPrompted('a')).toBe(false);
    namingMemory.markPrompted('a');
    namingMemory.markDeclined('b');
    expect(namingMemory.wasPrompted('a')).toBe(true);
    expect(namingMemory.wasDeclined('b')).toBe(true);
    expect(namingMemory.wasDeclined('a')).toBe(false);
  });

  it('keeps the most recent 200', () => {
    for (let i = 0; i < 205; i++) namingMemory.markPrompted(`doc-${i}`);
    expect(namingMemory.wasPrompted('doc-0')).toBe(false);
    expect(namingMemory.wasPrompted('doc-204')).toBe(true);
  });
});
