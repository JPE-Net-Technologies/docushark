import { describe, it, expect, beforeEach } from 'vitest';
import { measureWith, getMeasurer, clearMeasureCache, measureCacheSize } from './measureCache';

/**
 * Fake canvas context: `measureText` derives width from the currently-set
 * `font` string (e.g. "10px sans-serif") so caching keys are exercised, and a
 * call counter lets us assert cache hits.
 */
function makeFakeCtx() {
  let calls = 0;
  const ctx = {
    font: '',
    measureText(text: string) {
      calls++;
      const px = parseInt(ctx.font, 10) || 0;
      return { width: text.length * px * 0.5 } as TextMetrics;
    },
  };
  return {
    ctx: ctx as unknown as CanvasRenderingContext2D,
    calls: () => calls,
  };
}

describe('measureCache', () => {
  beforeEach(() => clearMeasureCache());

  it('returns the measured width and caches repeat lookups', () => {
    const { ctx, calls } = makeFakeCtx();
    const w1 = measureWith(ctx, 'hello', 10, 'sans-serif');
    const w2 = measureWith(ctx, 'hello', 10, 'sans-serif');
    expect(w1).toBe(25); // 5 chars * 10 * 0.5
    expect(w2).toBe(25);
    expect(calls()).toBe(1); // second call served from cache
  });

  it('keys distinctly on font size and family', () => {
    const { ctx, calls } = makeFakeCtx();
    measureWith(ctx, 'hello', 10, 'sans-serif');
    measureWith(ctx, 'hello', 20, 'sans-serif');
    measureWith(ctx, 'hello', 10, 'serif');
    expect(calls()).toBe(3);
  });

  it('getMeasurer binds to a context', () => {
    const { ctx } = makeFakeCtx();
    const measure = getMeasurer(ctx);
    expect(measure('abcd', 10, 'sans-serif')).toBe(20);
  });

  it('stays within the capacity bound under heavy insertion', () => {
    const { ctx } = makeFakeCtx();
    for (let i = 0; i < 5000; i++) {
      measureWith(ctx, `text-${i}`, 10, 'sans-serif');
    }
    expect(measureCacheSize()).toBeLessThanOrEqual(4096);
  });
});
