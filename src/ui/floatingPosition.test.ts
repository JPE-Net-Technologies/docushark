import { describe, it, expect } from 'vitest';
import {
  clampToViewport,
  resolveIndicatorPosition,
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
