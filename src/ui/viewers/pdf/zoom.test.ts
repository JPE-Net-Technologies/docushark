import { describe, it, expect } from 'vitest';
import {
  ZOOM_STEPS,
  MIN_ZOOM,
  MAX_ZOOM,
  nextZoomIn,
  nextZoomOut,
  clampPage,
} from './zoom';

describe('ZOOM_STEPS', () => {
  it('is strictly ascending', () => {
    for (let i = 1; i < ZOOM_STEPS.length; i++) {
      expect(ZOOM_STEPS[i]!).toBeGreaterThan(ZOOM_STEPS[i - 1]!);
    }
  });

  it('bounds match MIN/MAX', () => {
    expect(ZOOM_STEPS[0]).toBe(MIN_ZOOM);
    expect(ZOOM_STEPS[ZOOM_STEPS.length - 1]).toBe(MAX_ZOOM);
  });
});

describe('nextZoomIn', () => {
  it('advances to the next step from an exact stop', () => {
    expect(nextZoomIn(1.0)).toBe(1.1);
    expect(nextZoomIn(0.25)).toBe(0.33);
  });

  it('advances from a between-stops value to the next stop above', () => {
    expect(nextZoomIn(0.8)).toBe(0.9);
    expect(nextZoomIn(1.3)).toBe(1.5);
  });

  it('treats a hair-under value as being at that stop (epsilon)', () => {
    expect(nextZoomIn(0.9995)).toBe(1.1);
  });

  it('saturates at MAX_ZOOM', () => {
    expect(nextZoomIn(MAX_ZOOM)).toBe(MAX_ZOOM);
    expect(nextZoomIn(99)).toBe(MAX_ZOOM);
  });
});

describe('nextZoomOut', () => {
  it('steps down from an exact stop', () => {
    expect(nextZoomOut(1.0)).toBe(0.9);
    expect(nextZoomOut(5.0)).toBe(4.0);
  });

  it('steps down from a between-stops value to the next stop below', () => {
    expect(nextZoomOut(0.8)).toBe(0.75);
    expect(nextZoomOut(1.3)).toBe(1.25);
  });

  it('treats a hair-over value as being at that stop (epsilon)', () => {
    expect(nextZoomOut(1.0005)).toBe(0.9);
  });

  it('saturates at MIN_ZOOM', () => {
    expect(nextZoomOut(MIN_ZOOM)).toBe(MIN_ZOOM);
    expect(nextZoomOut(0.01)).toBe(MIN_ZOOM);
  });
});

describe('clampPage', () => {
  it('passes through in-range pages', () => {
    expect(clampPage(3, 10)).toBe(3);
  });

  it('clamps below 1 and above numPages', () => {
    expect(clampPage(0, 10)).toBe(1);
    expect(clampPage(-5, 10)).toBe(1);
    expect(clampPage(11, 10)).toBe(10);
  });

  it('floors fractional input', () => {
    expect(clampPage(2.7, 10)).toBe(2);
  });

  it('handles NaN/Infinity and degenerate numPages', () => {
    expect(clampPage(Number.NaN, 10)).toBe(1);
    expect(clampPage(Number.POSITIVE_INFINITY, 10)).toBe(1);
    expect(clampPage(5, 0)).toBe(1);
  });
});
