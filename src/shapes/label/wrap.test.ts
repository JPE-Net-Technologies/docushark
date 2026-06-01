import { describe, it, expect } from 'vitest';
import { wrapWord, wrapBreakWord, squeezeToFit } from './wrap';
import type { Measurer } from './LabelSpec';

/**
 * Deterministic measurer: each glyph is `fontPx * 0.5` wide, so a string of `n`
 * chars at font `f` measures `n * f * 0.5`. Makes layout math exact in jsdom.
 */
const fakeMeasure: Measurer = (text, fontPx) => text.length * fontPx * 0.5;

describe('wrapWord', () => {
  it('packs words greedily and wraps when the line overflows', () => {
    // font 10 → 5px/char. "hello world" = 11 chars = 55px (fits 60).
    // adding " foo" → 15 chars = 75px (> 60) → wrap.
    const lines = wrapWord('hello world foo', 60, 10, 'sans-serif', fakeMeasure);
    expect(lines).toEqual(['hello world', 'foo']);
  });

  it('preserves explicit newlines as paragraph breaks', () => {
    expect(wrapWord('a\nb', 1000, 10, 'sans-serif', fakeMeasure)).toEqual(['a', 'b']);
  });

  it('returns a single empty line for empty text', () => {
    expect(wrapWord('', 100, 10, 'sans-serif', fakeMeasure)).toEqual(['']);
  });

  it('leaves an oversized single word on its own line (overflowing width)', () => {
    const lines = wrapWord('supercalifragilistic', 20, 10, 'sans-serif', fakeMeasure);
    expect(lines).toEqual(['supercalifragilistic']);
  });
});

describe('wrapBreakWord', () => {
  it('breaks an oversized token character-by-character to fit width', () => {
    // 10 chars at font 10 = 50px; maxWidth 20 fits 4 chars (20px).
    const lines = wrapBreakWord('aaaaaaaaaa', 20, 10, 'sans-serif', fakeMeasure);
    expect(lines).toEqual(['aaaa', 'aaaa', 'aa']);
  });

  it('still wraps at word boundaries when words fit', () => {
    const lines = wrapBreakWord('hello world foo', 60, 10, 'sans-serif', fakeMeasure);
    expect(lines).toEqual(['hello world', 'foo']);
  });
});

describe('squeezeToFit', () => {
  it('shrinks the font to the largest size that fits the width', () => {
    // "hello" (5 chars) at font f = 2.5f px. maxWidth 10 → f <= 4.
    const { fontSize, lines } = squeezeToFit('hello', 10, 100, 14, 2, 'sans-serif', fakeMeasure);
    expect(fontSize).toBe(4);
    expect(lines).toEqual(['hello']);
  });

  it('does not shrink below minFontSize even if it still does not fit', () => {
    const { fontSize } = squeezeToFit('hello', 1, 100, 14, 6, 'sans-serif', fakeMeasure);
    expect(fontSize).toBe(6);
  });

  it('keeps the default size when everything already fits', () => {
    const { fontSize } = squeezeToFit('hi', 1000, 1000, 14, 6, 'sans-serif', fakeMeasure);
    expect(fontSize).toBe(14);
  });
});
