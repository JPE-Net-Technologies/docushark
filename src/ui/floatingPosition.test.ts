import { describe, it, expect } from 'vitest';
import {
  clampToViewport,
  clampPanelBounds,
  resolveIndicatorPosition,
  resolveViewerPanelBounds,
  resolveMenuPlacement,
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

describe('resolveMenuPlacement (anchored menu / popover)', () => {
  // A toolbar chip near the right edge of a roomy window.
  const TRIGGER = { top: 8, bottom: 40, right: 1044 };
  const ROOMY = { w: 1280, h: 860 };
  const base = {
    trigger: TRIGGER,
    viewport: ROOMY,
    preferredWidth: 340,
    narrow: false,
    contentHeight: 560,
  };

  it('opens below the trigger, right-aligned to it', () => {
    const out = resolveMenuPlacement(base);
    expect(out.flipped).toBe(false);
    expect(out.top).toBe(TRIGGER.bottom + 6);
    expect(out.left + out.width).toBe(TRIGGER.right);
    expect(out.width).toBe(340);
  });

  it('keeps its full width on a roomy viewport', () => {
    expect(resolveMenuPlacement(base).width).toBe(340);
  });

  it('shrinks to fit rather than running off a narrow viewport', () => {
    // The reported bug: a 340px panel on a 320px window used to overflow,
    // because the compact variant was gated on a coarse pointer.
    const viewport = { w: 320, h: 640 };
    const out = resolveMenuPlacement({
      ...base,
      viewport,
      narrow: true,
      trigger: { top: 8, bottom: 40, right: 300 },
    });
    expect(out.width).toBe(320 - VIEWPORT_MARGIN * 2);
    expect(out.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
    expect(out.left + out.width).toBeLessThanOrEqual(viewport.w - VIEWPORT_MARGIN);
  });

  it('never pushes off the left edge when the trigger sits near it', () => {
    const out = resolveMenuPlacement({
      ...base,
      trigger: { top: 8, bottom: 40, right: 120 },
    });
    expect(out.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
  });

  it('caps its height on a short viewport so it scrolls instead of truncating', () => {
    const viewport = { w: 1100, h: 400 };
    const out = resolveMenuPlacement({ ...base, viewport });
    expect(out.maxHeight).toBeLessThan(base.contentHeight);
    expect(out.top + out.maxHeight).toBeLessThanOrEqual(viewport.h);
  });

  it('flips above the trigger when below is cramped and above is roomier', () => {
    // A trigger low in the window: 60px underneath, ~700 above.
    const out = resolveMenuPlacement({
      ...base,
      viewport: { w: 1280, h: 860 },
      trigger: { top: 760, bottom: 790, right: 1044 },
    });
    expect(out.flipped).toBe(true);
    expect(out.top + Math.min(base.contentHeight, out.maxHeight)).toBeLessThanOrEqual(790);
  });

  it('does not flip when below is cramped but above is worse', () => {
    // Trigger near the top of a short window: little room either way, but more
    // below than above — flipping would make it worse, not better.
    const out = resolveMenuPlacement({
      ...base,
      viewport: { w: 1280, h: 300 },
      trigger: { top: 8, bottom: 40, right: 1044 },
    });
    expect(out.flipped).toBe(false);
  });

  it('stays on screen in every combination of the above', () => {
    for (const viewport of [{ w: 320, h: 480 }, { w: 768, h: 400 }, { w: 1280, h: 860 }]) {
      for (const trigger of [
        { top: 8, bottom: 40, right: 100 },
        { top: 8, bottom: 40, right: viewport.w - 8 },
        { top: viewport.h - 60, bottom: viewport.h - 28, right: viewport.w - 8 },
      ]) {
        const out = resolveMenuPlacement({
          ...base,
          viewport,
          trigger,
          narrow: viewport.w < 640,
        });
        expect(out.left).toBeGreaterThanOrEqual(VIEWPORT_MARGIN);
        expect(out.left + out.width).toBeLessThanOrEqual(viewport.w - VIEWPORT_MARGIN + 1);
        expect(out.top).toBeGreaterThanOrEqual(0);
      }
    }
  });
});
