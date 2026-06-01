import { describe, it, expect } from 'vitest';
import { layoutLabel } from './layoutLabel';
import type { Measurer } from './LabelSpec';

const fakeMeasure: Measurer = (text, fontPx) => text.length * fontPx * 0.5;

const base = {
  fontSize: 10,
  fontFamily: 'sans-serif',
  minFontSize: 4,
} as const;

describe('layoutLabel — overflow', () => {
  it('word-wraps and clips lines past the box height', () => {
    // font 10 → lineHeight 12. maxHeight 13 → only 1 line fits.
    const layout = layoutLabel(
      { ...base, text: 'hello world foo', overflow: 'overflow', maxWidth: 60, maxHeight: 13 },
      fakeMeasure
    );
    expect(layout.lines).toEqual(['hello world']);
    expect(layout.clipped).toBe(true);
    expect(layout.fontSize).toBe(10);
  });

  it('keeps all lines when they fit', () => {
    const layout = layoutLabel(
      { ...base, text: 'hello world foo', overflow: 'overflow', maxWidth: 60, maxHeight: 1000 },
      fakeMeasure
    );
    expect(layout.lines).toEqual(['hello world', 'foo']);
    expect(layout.clipped).toBe(false);
  });
});

describe('layoutLabel — break-word', () => {
  it('breaks an oversized token to fit width', () => {
    const layout = layoutLabel(
      { ...base, text: 'aaaaaaaaaa', overflow: 'break-word', maxWidth: 20, maxHeight: 1000 },
      fakeMeasure
    );
    expect(layout.lines).toEqual(['aaaa', 'aaaa', 'aa']);
  });
});

describe('layoutLabel — squeeze-into', () => {
  it('reduces the font size until the text fits', () => {
    const layout = layoutLabel(
      { ...base, fontSize: 14, text: 'hello', overflow: 'squeeze-into', maxWidth: 10, maxHeight: 1000 },
      fakeMeasure
    );
    expect(layout.fontSize).toBe(4);
    expect(layout.lines).toEqual(['hello']);
    expect(layout.clipped).toBe(false);
  });
});

describe('layoutLabel — singleLine', () => {
  it('collapses newlines to a single line and flags width overflow', () => {
    const layout = layoutLabel(
      {
        ...base,
        text: 'a\nb\nc',
        overflow: 'overflow',
        maxWidth: 5,
        maxHeight: 1000,
        singleLine: true,
      },
      fakeMeasure
    );
    expect(layout.lines).toEqual(['a b c']);
    expect(layout.clipped).toBe(true); // 5 chars * 10 * 0.5 = 25 > 5
  });
});
