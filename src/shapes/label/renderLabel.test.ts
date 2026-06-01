import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderLabel } from './renderLabel';
import { RECT_LABEL_SPEC } from './specs';
import { clearMeasureCache } from './measureCache';

/**
 * Mock canvas context whose `measureText` is font-driven (`chars * fontPx * 0.5`)
 * so wrapping is deterministic; `fillText` is a spy for asserting drawn lines.
 */
function makeCtx() {
  const ctx = {
    font: '',
    fillStyle: '',
    textAlign: '',
    textBaseline: '',
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn(),
    measureText(text: string) {
      const px = parseInt(ctx.font, 10) || 0;
      return { width: text.length * px * 0.5 } as TextMetrics;
    },
  };
  return ctx as unknown as CanvasRenderingContext2D & { fillText: ReturnType<typeof vi.fn> };
}

const baseInput = {
  spec: RECT_LABEL_SPEC,
  // maxWidth = 60 (boxWidth * 0.85), maxHeight large.
  boxWidth: 60 / 0.85,
  boxHeight: 1000,
  fontSize: 10,
  color: '#000000',
  offsetX: 0,
  offsetY: 0,
} as const;

describe('renderLabel', () => {
  beforeEach(() => clearMeasureCache());

  it('wraps at word boundaries and draws one fillText per visible line', () => {
    const ctx = makeCtx() as CanvasRenderingContext2D & { fillText: ReturnType<typeof vi.fn> };
    renderLabel(ctx, { ...baseInput, text: 'hello world foo' });

    const drawn = ctx.fillText.mock.calls.map((c) => c[0]);
    expect(drawn).toEqual(['hello world', 'foo']);
  });

  it('is a no-op for empty text', () => {
    const ctx = makeCtx() as CanvasRenderingContext2D & { fillText: ReturnType<typeof vi.fn> };
    renderLabel(ctx, { ...baseInput, text: '' });
    expect(ctx.fillText).not.toHaveBeenCalled();
  });

  it('honors a per-instance overflow override (break-word) over the spec', () => {
    const ctx = makeCtx() as CanvasRenderingContext2D & { fillText: ReturnType<typeof vi.fn> };
    // RECT_LABEL_SPEC defaults to 'overflow'; override to 'break-word' so the
    // oversized token is split to fit. maxWidth = 20 (boxWidth*0.85), font 10.
    renderLabel(ctx, {
      ...baseInput,
      boxWidth: 20 / 0.85,
      text: 'aaaaaaaaaa',
      overflow: 'break-word',
    });
    const drawn = ctx.fillText.mock.calls.map((c) => c[0]);
    expect(drawn).toEqual(['aaaa', 'aaaa', 'aa']);
  });

  it('paints a background pill when a background color is supplied', () => {
    const ctx = makeCtx() as CanvasRenderingContext2D & {
      fillText: ReturnType<typeof vi.fn>;
      fillRect: ReturnType<typeof vi.fn>;
    };
    renderLabel(ctx, { ...baseInput, text: 'hi', background: '#ffffff' });
    expect(ctx.fillRect).toHaveBeenCalled();
  });
});
