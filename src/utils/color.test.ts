import { describe, it, expect } from 'vitest';
import { parseColorInput, isValidColorInput, NAMED_COLORS } from './color';
import { parseColor } from './pdfExportUtils';

describe('parseColorInput', () => {
  it('accepts 6-digit hex with and without the leading hash', () => {
    expect(parseColorInput('#ff6600')).toBe('#ff6600');
    expect(parseColorInput('ff6600')).toBe('#ff6600');
  });

  it('accepts 3-digit shorthand and expands it', () => {
    expect(parseColorInput('#f60')).toBe('#ff6600');
    expect(parseColorInput('f60')).toBe('#ff6600');
  });

  it('normalizes case and surrounding whitespace', () => {
    expect(parseColorInput('  #FF6600  ')).toBe('#ff6600');
    expect(parseColorInput('#AbCdEf')).toBe('#abcdef');
  });

  it('accepts rgb() and rgba() in comma or space form', () => {
    expect(parseColorInput('rgb(255, 102, 0)')).toBe('#ff6600');
    expect(parseColorInput('rgb(255 102 0)')).toBe('#ff6600');
    expect(parseColorInput('rgba(255, 102, 0, 0.5)')).toBe('#ff6600');
  });

  it('accepts named CSS colors', () => {
    expect(parseColorInput('red')).toBe('#ff0000');
    expect(parseColorInput('CRIMSON')).toBe('#dc143c');
  });

  it('drops alpha rather than emitting a form the PDF exporter cannot read', () => {
    // 8-digit hex is accepted as input for convenience (pasting from devtools)
    // but is never stored: pdfExportUtils.parseColor returns null for it, so a
    // stored 8-digit value would silently lose the color on export entirely.
    expect(parseColorInput('#ff6600aa')).toBe('#ff6600');
    expect(parseColorInput('#f60a')).toBe('#ff6600');
  });

  it('rejects text that is not a color', () => {
    expect(parseColorInput('')).toBeNull();
    expect(parseColorInput('   ')).toBeNull();
    expect(parseColorInput('nonsense')).toBeNull();
    expect(parseColorInput('#')).toBeNull();
    expect(parseColorInput('rgb(300, 0, 0)')).toBeNull();
  });

  it('rejects hex of a length that is not a CSS hex color', () => {
    // 5 and 7 digits are typos, not colors, and must not be coerced into one.
    expect(parseColorInput('#ff660')).toBeNull();
    expect(parseColorInput('#ff6600a')).toBeNull();
  });

  it('is idempotent — canonical output re-parses to itself', () => {
    for (const input of ['#f60', 'rgb(1,2,3)', 'teal', '#ABCDEF', '#12345678']) {
      const once = parseColorInput(input)!;
      expect(parseColorInput(once)).toBe(once);
    }
  });
});

describe('isValidColorInput', () => {
  it('agrees with parseColorInput', () => {
    expect(isValidColorInput('#f60')).toBe(true);
    expect(isValidColorInput('nope')).toBe(false);
  });
});

describe('editor/PDF colour grammar parity', () => {
  // The anti-drift guard. The editor may accept liberally, but whatever it
  // *stores* has to be renderable by the PDF exporter — otherwise a colour the
  // user picked silently disappears from the export. Since parseColorInput
  // always emits #rrggbb, this holds by construction; the test pins it so a
  // future change to either grammar cannot quietly break it.
  const inputs = [
    '#f60',
    'ff6600',
    '#FF6600',
    'rgb(255, 102, 0)',
    'rgb(255 102 0)',
    'rgba(255, 102, 0, 0.5)',
    '#ff6600aa',
    ...Object.keys(NAMED_COLORS),
  ];

  it.each(inputs)('everything accepted from %s stays PDF-renderable', (input) => {
    const stored = parseColorInput(input);
    expect(stored).not.toBeNull();
    expect(parseColor(stored!)).not.toBeNull();
  });

  it('agrees with the PDF exporter on the actual RGB values', () => {
    for (const [name, rgb] of Object.entries(NAMED_COLORS)) {
      expect(parseColor(parseColorInput(name)!)).toEqual([rgb.r, rgb.g, rgb.b]);
    }
  });
});
