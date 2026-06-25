import { describe, expect, it } from 'vitest';
import { isMobileViewport, shouldAdaptToMobile } from './useMobileAdaptation';
import type { BreakpointState } from './useBreakpoint';

/** A touch + narrow baseline; override per case. */
function bp(partial: Partial<BreakpointState> = {}): BreakpointState {
  return { band: 'narrow', isTouch: true, standalone: false, ...partial };
}

describe('isMobileViewport', () => {
  it('is true only for a touch device at a narrow viewport', () => {
    expect(isMobileViewport(bp({ isTouch: true, band: 'narrow' }))).toBe(true);
    expect(isMobileViewport(bp({ isTouch: false, band: 'narrow' }))).toBe(false);
    expect(isMobileViewport(bp({ isTouch: true, band: 'medium' }))).toBe(false);
    expect(isMobileViewport(bp({ isTouch: true, band: 'wide' }))).toBe(false);
  });
});

describe('shouldAdaptToMobile', () => {
  it('does not render mobile chrome until accepted', () => {
    expect(shouldAdaptToMobile(bp(), false, false)).toBe(false);
    expect(shouldAdaptToMobile(bp(), true, false)).toBe(true);
  });

  it('opting out (forceDesktop) wins over acceptance', () => {
    expect(shouldAdaptToMobile(bp(), true, true)).toBe(false);
  });

  it('requires a touch device (a narrowed desktop window never adapts)', () => {
    expect(shouldAdaptToMobile(bp({ isTouch: false }), true, false)).toBe(false);
  });

  it('holds through narrow and medium but not wide (no orientation thrash)', () => {
    expect(shouldAdaptToMobile(bp({ band: 'narrow' }), true, false)).toBe(true);
    expect(shouldAdaptToMobile(bp({ band: 'medium' }), true, false)).toBe(true);
    expect(shouldAdaptToMobile(bp({ band: 'wide' }), true, false)).toBe(false);
  });
});
