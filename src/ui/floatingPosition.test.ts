import { describe, it, expect } from 'vitest';
import {
  clampToViewport,
  clampPanelBounds,
  resolveIndicatorPosition,
  resolveViewerPanelBounds,
  MIN_PANEL_SIZE,
  VIEWPORT_MARGIN,
  DEFAULT_TOP,
} from './floatingPosition';

const SIZE = { w: 120, h: 40 };
const VP = { w: 1000, h: 800 };

describe('clampToViewport', () => {
  it('leaves an in-bounds point untouched', () => {
    expect(clampToViewport({ x: 300, y: 200 }, SIZE, VP)).toEqual({ x: 300, y: 200 });
  });

  it('pins to the margin when past the left/top edges', () => {
    expect(clampToViewport({ x: -50, y: -50 }, SIZE, VP)).toEqual({
      x: VIEWPORT_MARGIN,
      y: VIEWPORT_MARGIN,
    });
  });

  it('pulls back from the right edge by element width + margin', () => {
    const { x } = clampToViewport({ x: 5000, y: 100 }, SIZE, VP);
    expect(x).toBe(VP.w - SIZE.w - VIEWPORT_MARGIN); // 1000 - 120 - 16 = 864
  });

  it('pulls back from the bottom edge by element height + margin', () => {
    const { y } = clampToViewport({ x: 100, y: 5000 }, SIZE, VP);
    expect(y).toBe(VP.h - SIZE.h - VIEWPORT_MARGIN); // 800 - 40 - 16 = 744
  });

  it('pins to the top-left margin when the element is larger than the room', () => {
    const tiny = { w: 50, h: 50 };
    expect(clampToViewport({ x: 10, y: 10 }, { w: 200, h: 200 }, tiny)).toEqual({
      x: VIEWPORT_MARGIN,
      y: VIEWPORT_MARGIN,
    });
  });
});

describe('resolveIndicatorPosition', () => {
  it('defaults a null position to the top-right anchor', () => {
    expect(resolveIndicatorPosition(null, SIZE, VP)).toEqual({
      x: VP.w - SIZE.w - VIEWPORT_MARGIN, // 864
      y: DEFAULT_TOP, // 64
    });
  });

  it('clamps a stored position that is now off-screen after a resize', () => {
    const stored = { x: 980, y: 790 }; // valid on a big screen, off a small one
    const small = { w: 600, h: 400 };
    expect(resolveIndicatorPosition(stored, SIZE, small)).toEqual({
      x: small.w - SIZE.w - VIEWPORT_MARGIN, // 464
      y: small.h - SIZE.h - VIEWPORT_MARGIN, // 344
    });
  });

  it('keeps an in-bounds stored position', () => {
    expect(resolveIndicatorPosition({ x: 200, y: 150 }, SIZE, VP)).toEqual({
      x: 200,
      y: 150,
    });
  });
});

describe('clampPanelBounds', () => {
  const VIEWPORT = { w: 1400, h: 900 };

  it('passes through in-range bounds', () => {
    const b = { x: 100, y: 100, w: 500, h: 600 };
    expect(clampPanelBounds(b, VIEWPORT)).toEqual(b);
  });

  it('enforces the minimum size', () => {
    const out = clampPanelBounds({ x: 50, y: 50, w: 100, h: 100 }, VIEWPORT);
    expect(out.w).toBe(MIN_PANEL_SIZE.w);
    expect(out.h).toBe(MIN_PANEL_SIZE.h);
  });

  it('caps size to the viewport minus margins', () => {
    const out = clampPanelBounds({ x: 0, y: 0, w: 5000, h: 5000 }, VIEWPORT);
    expect(out.w).toBe(VIEWPORT.w - 2 * VIEWPORT_MARGIN);
    expect(out.h).toBe(VIEWPORT.h - 2 * VIEWPORT_MARGIN);
    expect(out.x).toBe(VIEWPORT_MARGIN);
    expect(out.y).toBe(VIEWPORT_MARGIN);
  });

  it('pulls an off-screen panel back into view', () => {
    const out = clampPanelBounds({ x: 2000, y: -50, w: 400, h: 500 }, VIEWPORT);
    expect(out.x).toBe(VIEWPORT.w - 400 - VIEWPORT_MARGIN);
    expect(out.y).toBe(VIEWPORT_MARGIN);
  });
});

describe('resolveViewerPanelBounds', () => {
  const VIEWPORT = { w: 1400, h: 900 };

  it('defaults to a right-side panel below the toolbar', () => {
    const out = resolveViewerPanelBounds(null, VIEWPORT);
    expect(out.y).toBe(DEFAULT_TOP);
    expect(out.x + out.w).toBe(VIEWPORT.w - VIEWPORT_MARGIN);
    expect(out.w).toBeGreaterThanOrEqual(MIN_PANEL_SIZE.w);
    expect(out.h).toBeGreaterThanOrEqual(MIN_PANEL_SIZE.h);
  });

  it('clamps stored bounds after a window shrink', () => {
    const stored = { x: 1200, y: 700, w: 560, h: 720 };
    const small = { w: 800, h: 600 };
    const out = resolveViewerPanelBounds(stored, small);
    expect(out.x + out.w).toBeLessThanOrEqual(small.w - VIEWPORT_MARGIN);
    expect(out.y + out.h).toBeLessThanOrEqual(small.h - VIEWPORT_MARGIN);
  });

  it('respects stored in-range bounds', () => {
    const stored = { x: 100, y: 120, w: 480, h: 560 };
    expect(resolveViewerPanelBounds(stored, VIEWPORT)).toEqual(stored);
  });
});
