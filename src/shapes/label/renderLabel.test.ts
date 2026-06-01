import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderLabel } from './renderLabel';
import { RECT_LABEL_SPEC, CONNECTOR_LABEL_SPEC, GROUP_LABEL_SPEC } from './specs';
import { clearMeasureCache } from './measureCache';

type SpyCtx = CanvasRenderingContext2D & {
  fillText: ReturnType<typeof vi.fn>;
  fillRect: ReturnType<typeof vi.fn>;
  strokeRect: ReturnType<typeof vi.fn>;
  roundRect: ReturnType<typeof vi.fn>;
};

/**
 * Mock canvas context whose `measureText` is font-driven (`chars * fontPx * 0.5`)
 * so wrapping is deterministic; draw methods are spies for asserting output.
 */
function makeCtx(): SpyCtx {
  const ctx = {
    font: '',
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    textAlign: '',
    textBaseline: '',
    save: vi.fn(),
    restore: vi.fn(),
    translate: vi.fn(),
    beginPath: vi.fn(),
    fill: vi.fn(),
    stroke: vi.fn(),
    fillRect: vi.fn(),
    strokeRect: vi.fn(),
    roundRect: vi.fn(),
    fillText: vi.fn(),
    measureText(text: string) {
      const px = parseInt(ctx.font, 10) || 0;
      return { width: text.length * px * 0.5 } as TextMetrics;
    },
  };
  return ctx as unknown as SpyCtx;
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
    const ctx = makeCtx();
    renderLabel(ctx, { ...baseInput, text: 'hi', background: '#ffffff' });
    expect(ctx.fillRect).toHaveBeenCalled();
  });

  describe('point-anchored mode', () => {
    it('connector: draws text at the anchor with a square pill + border', () => {
      const ctx = makeCtx();
      renderLabel(ctx, {
        spec: CONNECTOR_LABEL_SPEC,
        boxWidth: 1000,
        boxHeight: 24,
        fontSize: 12,
        color: '#000000',
        background: 'rgba(255,255,255,0.9)',
        backgroundBorder: true,
        backgroundPadX: 8,
        backgroundPadY: 8,
        anchor: { textAlign: 'center', textBaseline: 'middle' },
        offsetX: 0,
        offsetY: 0,
        text: 'edge',
      });
      expect(ctx.textAlign).toBe('center');
      expect(ctx.textBaseline).toBe('middle');
      expect(ctx.fillRect).toHaveBeenCalled(); // square pill
      expect(ctx.strokeRect).toHaveBeenCalled(); // default-pill border
      expect(ctx.fillText.mock.calls.map((c) => c[0])).toEqual(['edge']);
      // single line drawn at the anchor origin
      expect(ctx.fillText.mock.calls[0]![1]).toBe(0);
      expect(ctx.fillText.mock.calls[0]![2]).toBe(0);
    });

    it('group: rounded pill, honoring the 9-grid baseline', () => {
      const ctx = makeCtx();
      renderLabel(ctx, {
        spec: GROUP_LABEL_SPEC,
        boxWidth: 1000,
        boxHeight: 28,
        fontSize: 14,
        color: '#000000',
        background: '#222222',
        backgroundRound: true,
        backgroundRadius: 4,
        anchor: { textAlign: 'left', textBaseline: 'bottom' },
        offsetX: 0,
        offsetY: 0,
        text: 'Group A',
      });
      expect(ctx.roundRect).toHaveBeenCalled();
      expect(ctx.textAlign).toBe('left');
      expect(ctx.textBaseline).toBe('bottom');
      expect(ctx.fillText.mock.calls.map((c) => c[0])).toEqual(['Group A']);
    });

    it('no pill when background is undefined (No Fill)', () => {
      const ctx = makeCtx();
      renderLabel(ctx, {
        spec: CONNECTOR_LABEL_SPEC,
        boxWidth: 1000,
        boxHeight: 24,
        fontSize: 12,
        color: '#000000',
        background: undefined,
        anchor: { textAlign: 'center', textBaseline: 'middle' },
        offsetX: 0,
        offsetY: 0,
        text: 'x',
      });
      expect(ctx.fillRect).not.toHaveBeenCalled();
      expect(ctx.strokeRect).not.toHaveBeenCalled();
    });
  });
});
