/**
 * Counts for the open prose page (DSK-211).
 */
import { describe, it, expect } from 'vitest';
import { getSchema } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import { DOMParser as PMDOMParser } from '@tiptap/pm/model';
import { countProse, countWordsBetween, readingMinutes } from './proseStats';

const schema = getSchema([StarterKit]);
const doc = (html: string) => {
  const div = document.createElement('div');
  div.innerHTML = html;
  return PMDOMParser.fromSchema(schema).parse(div);
};

describe('prose counts (DSK-211)', () => {
  it('counts words across blocks, characters, and paragraphs with text in them', () => {
    const page = doc('<h1>Quarterly report</h1><p>Revenue grew</p><p></p><ul><li><p>one</p></li></ul>');
    expect(countProse(page)).toEqual({
      words: 5,
      characters: 'Quarterly report'.length + 'Revenue grew'.length + 'one'.length,
      paragraphs: 3,
    });
  });

  it('counts the words in a range, and none in a collapsed one', () => {
    const page = doc('<p>one two three</p>');
    expect(countWordsBetween(page, 1, 8)).toBe(2);
    expect(countWordsBetween(page, 3, 3)).toBe(0);
  });

  it('rounds reading time, with at least a minute for any text', () => {
    expect(readingMinutes(0)).toBe(0);
    expect(readingMinutes(10)).toBe(1);
    expect(readingMinutes(460)).toBe(2);
  });
});
