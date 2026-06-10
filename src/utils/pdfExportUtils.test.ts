import { describe, it, expect, vi } from 'vitest';
import { parseColor, warnUnhandledNodes, breakOversizedWord, extractSegments, extractBibliographyEntries } from './pdfExportUtils';

describe('parseColor', () => {
  // ── Hex colors ──────────────────────────────────────────────────────────────
  it('parses 6-digit hex', () => {
    expect(parseColor('#ff0000')).toEqual([255, 0, 0]);
    expect(parseColor('#00ff00')).toEqual([0, 255, 0]);
    expect(parseColor('#0000ff')).toEqual([0, 0, 255]);
    expect(parseColor('#1a2b3c')).toEqual([26, 43, 60]);
  });

  it('parses 3-digit hex shorthand', () => {
    expect(parseColor('#f00')).toEqual([255, 0, 0]);
    expect(parseColor('#0f0')).toEqual([0, 255, 0]);
    expect(parseColor('#abc')).toEqual([170, 187, 204]);
  });

  // ── RGB / RGBA ──────────────────────────────────────────────────────────────
  it('parses rgb()', () => {
    expect(parseColor('rgb(255, 0, 0)')).toEqual([255, 0, 0]);
    expect(parseColor('rgb(0,128,255)')).toEqual([0, 128, 255]);
    expect(parseColor('rgb( 10 , 20 , 30 )')).toEqual([10, 20, 30]);
  });

  it('parses rgba()', () => {
    expect(parseColor('rgba(255, 0, 0, 0.5)')).toEqual([255, 0, 0]);
    expect(parseColor('rgba(100,200,50,1)')).toEqual([100, 200, 50]);
  });

  it('clamps rgb values to 255', () => {
    expect(parseColor('rgb(300, 0, 0)')).toEqual([255, 0, 0]);
  });

  // ── Named colors ────────────────────────────────────────────────────────────
  it('parses named colors', () => {
    expect(parseColor('red')).toEqual([255, 0, 0]);
    expect(parseColor('blue')).toEqual([0, 0, 255]);
    expect(parseColor('green')).toEqual([0, 128, 0]);
    expect(parseColor('black')).toEqual([0, 0, 0]);
    expect(parseColor('white')).toEqual([255, 255, 255]);
  });

  it('is case-insensitive for named colors', () => {
    expect(parseColor('Red')).toEqual([255, 0, 0]);
    expect(parseColor('BLUE')).toEqual([0, 0, 255]);
  });

  // ── Edge cases ──────────────────────────────────────────────────────────────
  it('handles whitespace', () => {
    expect(parseColor('  #ff0000  ')).toEqual([255, 0, 0]);
    expect(parseColor(' rgb(1,2,3) ')).toEqual([1, 2, 3]);
  });

  it('returns null for unparseable values', () => {
    expect(parseColor('')).toBeNull();
    expect(parseColor('not-a-color')).toBeNull();
    expect(parseColor('#gg0000')).toBeNull();
    expect(parseColor('hsl(0, 100%, 50%)')).toBeNull();
  });
});

describe('warnUnhandledNodes', () => {
  it('does not warn for registered types', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // These are all registered in the node renderer registry
    warnUnhandledNodes([
      'doc', 'text', 'heading', 'paragraph', 'bulletList', 'orderedList',
      'listItem', 'codeBlock', 'blockquote', 'image', 'horizontalRule',
      'embeddedGroup', 'taskList', 'taskItem', 'table', 'tableRow',
      'tableCell', 'tableHeader', 'mathInline', 'mathBlock', 'hardBreak',
    ]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it('warns for unregistered types', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnUnhandledNodes(['heading', 'paragraph', 'myCustomNode']);
    expect(spy).toHaveBeenCalledWith(
      expect.stringContaining('myCustomNode')
    );
    spy.mockRestore();
  });
});

describe('breakOversizedWord', () => {
  // Treat each character as exactly 1 width unit for predictable assertions.
  const oneCharPerUnit = (s: string) => s.length;

  it('returns empty array for empty input', () => {
    expect(breakOversizedWord('', 10, oneCharPerUnit)).toEqual([]);
  });

  it('breaks a long token into pieces that each fit within availableWidth', () => {
    const text = 'supercalifragilisticexpialidocious'; // 34 chars
    const pieces = breakOversizedWord(text, 10, oneCharPerUnit);
    expect(pieces.join('')).toBe(text);
    for (const p of pieces) {
      expect(oneCharPerUnit(p)).toBeLessThanOrEqual(10);
    }
  });

  it('packs each line to the largest prefix that fits (greedy)', () => {
    const pieces = breakOversizedWord('abcdefghij', 4, oneCharPerUnit);
    expect(pieces).toEqual(['abcd', 'efgh', 'ij']);
  });

  it('handles a token narrower than availableWidth as a single piece', () => {
    expect(breakOversizedWord('hi', 100, oneCharPerUnit)).toEqual(['hi']);
  });

  it('degrades to 1-char chunks when availableWidth is smaller than any character', () => {
    // Defensive: binary search defaults to a minimum of 1 char to guarantee progress.
    const pieces = breakOversizedWord('abc', 0, oneCharPerUnit);
    expect(pieces).toEqual(['a', 'b', 'c']);
  });

  it('uses the measure callback for variable-width characters', () => {
    // "W" costs 3, others cost 1 — simulates proportional fonts.
    const measure = (s: string) =>
      s.split('').reduce((sum, ch) => sum + (ch === 'W' ? 3 : 1), 0);
    const pieces = breakOversizedWord('aaWaa', 4, measure);
    // Greedy: "aa" (2), then "Wa" (4), then "a" (1).
    expect(pieces.join('')).toBe('aaWaa');
    for (const p of pieces) {
      expect(measure(p)).toBeLessThanOrEqual(4);
    }
  });
});

describe('citations PDF rendering (JP-89 slice 5.5)', () => {
  it('renders an inline citation as a text segment from its cached label', () => {
    const para = {
      type: 'paragraph',
      content: [
        { type: 'text', text: 'See ' },
        { type: 'citationInline', attrs: { refId: 'smith2020', label: '(Smith, 2020)' } },
        { type: 'text', text: ' for details.' },
      ],
    };
    const text = extractSegments(para).map((s) => s.text).join('');
    expect(text).toBe('See (Smith, 2020) for details.');
  });

  it('skips an inline citation with no cached label', () => {
    const para = {
      type: 'paragraph',
      content: [{ type: 'citationInline', attrs: { refId: 'x', label: '' } }],
    };
    expect(extractSegments(para)).toHaveLength(0);
  });

  it('extracts bibliography entries from cached citeproc HTML', () => {
    const html =
      '<div class="csl-bib-body">' +
      '<div class="csl-entry">Smith, J. (2020). On Things.</div>' +
      '<div class="csl-entry">Doe, J. (2019). A Book.</div>' +
      '</div>';
    expect(extractBibliographyEntries(html)).toEqual([
      'Smith, J. (2020). On Things.',
      'Doe, J. (2019). A Book.',
    ]);
  });

  it('falls back to whole text when there are no .csl-entry nodes', () => {
    expect(extractBibliographyEntries('<p class="bibliography-empty">No references yet.</p>')).toEqual([
      'No references yet.',
    ]);
    expect(extractBibliographyEntries('')).toEqual([]);
  });

  it('has PDF renderers registered for citation node types (no unhandled warning)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    warnUnhandledNodes(['paragraph', 'citationInline', 'bibliography']);
    const warned = warn.mock.calls.flat().join(' ');
    expect(warned).not.toContain('citationInline');
    expect(warned).not.toContain('bibliography');
    warn.mockRestore();
  });
});
