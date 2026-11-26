/**
 * Font values (DSK-246): what is safe to use, what follows the document, and
 * what each value draws with.
 */
import { describe, expect, it } from 'vitest';
import { CAVEAT, DEFAULT_DOCUMENT_FONT, INTER, JETBRAINS_MONO, SOURCE_SERIF } from './catalogue';
import {
  catalogueFontFor,
  firstFamily,
  FOLLOW_DOCUMENT_FONT,
  resolveDocumentFont,
  resolveShapeFont,
  sanitizeFontFamily,
} from './fontFamily';

describe('sanitizeFontFamily', () => {
  it('keeps a CSS font-family list, trimmed', () => {
    expect(sanitizeFontFamily("  'Source Serif 4', serif ")).toBe("'Source Serif 4', serif");
    expect(sanitizeFontFamily('"Comic Sans MS", cursive')).toBe('"Comic Sans MS", cursive');
    expect(sanitizeFontFamily('Noto_Sans-JP.v2, sans-serif')).toBe('Noto_Sans-JP.v2, sans-serif');
  });

  it('refuses anything that could end the value or break a canvas font', () => {
    for (const value of [
      'Inter; color: red',
      'Inter} body {',
      'url(evil.woff)',
      '<script>',
      'Inter\nserif',
      "'Source Serif 4, serif",
      '"Inter',
      '',
      '   ',
      'x'.repeat(201),
      42,
      null,
      undefined,
    ]) {
      expect(sanitizeFontFamily(value), String(value)).toBeNull();
    }
  });
});

describe('firstFamily', () => {
  it('is the first family, unquoted and lower-cased', () => {
    expect(firstFamily("'Source Serif 4', serif")).toBe('source serif 4');
    expect(firstFamily('Inter')).toBe('inter');
  });
});

describe('catalogueFontFor', () => {
  it('finds a bundled family by its first name, however it is written', () => {
    expect(catalogueFontFor('Inter, sans-serif')).toBe(INTER);
    expect(catalogueFontFor('"source serif 4"')).toBe(SOURCE_SERIF);
    expect(catalogueFontFor("'JetBrains Mono', Menlo, monospace")).toBe(JETBRAINS_MONO);
  });

  it('gives a generic family its bundled stand-in, except sans-serif', () => {
    expect(catalogueFontFor('serif')).toBe(SOURCE_SERIF);
    expect(catalogueFontFor('monospace')).toBe(JETBRAINS_MONO);
    expect(catalogueFontFor('cursive')).toBe(CAVEAT);
    expect(catalogueFontFor('sans-serif')).toBeNull();
  });

  it('finds nothing for a font that is not bundled, or an unsafe value', () => {
    expect(catalogueFontFor("'Comic Sans MS', cursive")).toBeNull();
    expect(catalogueFontFor('Inter; x')).toBeNull();
  });
});

describe('resolveDocumentFont', () => {
  it('is the default when unset, unsafe or the old default', () => {
    for (const value of [undefined, null, 3, 'Inter}', FOLLOW_DOCUMENT_FONT]) {
      expect(resolveDocumentFont(value), String(value)).toBe(DEFAULT_DOCUMENT_FONT.css);
    }
  });

  it('is a bundled family’s canonical list', () => {
    expect(resolveDocumentFont('"Source Serif 4"')).toBe(SOURCE_SERIF.css);
  });

  it('keeps a safe font it does not bundle, so it still draws in its generic family', () => {
    expect(resolveDocumentFont("'Atkinson Hyperlegible', sans-serif")).toBe("'Atkinson Hyperlegible', sans-serif");
  });
});

describe('resolveShapeFont', () => {
  const documentFont = SOURCE_SERIF.css;

  it('follows the document font when absent, unsafe or sans-serif', () => {
    for (const value of [undefined, FOLLOW_DOCUMENT_FONT, 'x;y', '']) {
      expect(resolveShapeFont(value, documentFont), String(value)).toBe(documentFont);
    }
  });

  it('draws a shape’s own font: bundled, a stand-in, or as written', () => {
    expect(resolveShapeFont('Caveat, cursive', documentFont)).toBe(CAVEAT.css);
    expect(resolveShapeFont('monospace', documentFont)).toBe(JETBRAINS_MONO.css);
    expect(resolveShapeFont("'Comic Sans MS', cursive", documentFont)).toBe("'Comic Sans MS', cursive");
  });
});
