/**
 * A text shape draws in the document font unless it has its own (DSK-246).
 */
import { afterEach, expect, it, vi } from 'vitest';
import { textHandler } from './Text';
import { DEFAULT_TEXT, type TextShape } from './Shape';
import { setCurrentDocumentFont } from '../fonts/currentDocumentFont';
import { DEFAULT_DOCUMENT_FONT } from '../fonts/catalogue';

function drawnFont(fontFamily: string): string {
  const fonts: string[] = [];
  const ctx = {
    save: vi.fn(), restore: vi.fn(), translate: vi.fn(), rotate: vi.fn(), fillText: vi.fn(),
    measureText: (text: string) => ({ width: text.length * 8 }) as TextMetrics,
    set font(value: string) { fonts.push(value); },
    get font() { return fonts[fonts.length - 1] ?? ''; },
  } as unknown as CanvasRenderingContext2D;
  const shape = { ...DEFAULT_TEXT, id: 't', type: 'text', x: 0, y: 0, rotation: 0, locked: false, visible: true, text: 'Hello', fontFamily, fill: '#000' } as unknown as TextShape;
  textHandler.render(ctx, shape);
  return fonts[fonts.length - 1] ?? '';
}

afterEach(() => {
  setCurrentDocumentFont(DEFAULT_DOCUMENT_FONT.css);
});

it('draws in the document font, or the shape’s own', () => {
  setCurrentDocumentFont("'Source Serif 4', serif");
  expect(drawnFont('sans-serif')).toBe("16px 'Source Serif 4', serif");
  expect(drawnFont('Caveat, cursive')).toBe('16px Caveat, cursive');
});
