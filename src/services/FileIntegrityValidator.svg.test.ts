/**
 * SVG integrity check — SVGs are images that `createImageBitmap` can't decode,
 * so they were silently rejected as "corrupt". They now validate by detecting an
 * `<svg>` root instead, so any file (incl. SVG) imports. The pure detector is
 * unit-tested here; the blob read + routing are exercised in the browser (jsdom's
 * `Blob` lacks `arrayBuffer`/`createImageBitmap`, so neither image path runs here).
 */
import { describe, it, expect } from 'vitest';
import { isLikelySvg } from './FileIntegrityValidator';

describe('isLikelySvg', () => {
  it('accepts a well-formed SVG (with attributes, self-closing, or bare)', () => {
    expect(isLikelySvg('<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>')).toBe(true);
    expect(isLikelySvg('<?xml version="1.0"?>\n<!-- c -->\n<svg viewBox="0 0 1 1">')).toBe(true);
    expect(isLikelySvg('<SVG>')).toBe(true); // case-insensitive
    expect(isLikelySvg('<svg/>')).toBe(true);
  });

  it('rejects content with no <svg> root', () => {
    expect(isLikelySvg('<note>not an svg</note>')).toBe(false);
    expect(isLikelySvg('just some text mentioning svg')).toBe(false);
    expect(isLikelySvg('')).toBe(false);
    expect(isLikelySvg('<svganimate>')).toBe(false); // not an <svg> element
  });
});
