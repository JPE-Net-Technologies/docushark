import { describe, it, expect, vi, afterEach } from 'vitest';
import { readBreakpointState } from './useBreakpoint';

/**
 * `readBreakpointState` is the pure snapshot reader behind the hook — it leans
 * on `platform.device` (innerWidth-based band, coarse-pointer detection) plus a
 * `(display-mode: standalone)` check. We drive it by stubbing `innerWidth` and
 * `matchMedia` so it can be unit-tested without a DOM render harness.
 */

function stubMatchMedia(matchedQueries: string[]): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches: matchedQueries.includes(query),
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
        onchange: null,
        dispatchEvent: () => false,
      }) as unknown as MediaQueryList
  );
}

function stubWidth(width: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('readBreakpointState', () => {
  it('classifies the viewport band from width', () => {
    stubMatchMedia([]);
    stubWidth(500);
    expect(readBreakpointState().band).toBe('narrow');
    stubWidth(800);
    expect(readBreakpointState().band).toBe('medium');
    stubWidth(1400);
    expect(readBreakpointState().band).toBe('wide');
  });

  it('reports coarse pointer and standalone capability flags', () => {
    stubWidth(1400);
    stubMatchMedia(['(pointer: coarse)', '(display-mode: standalone)']);
    const state = readBreakpointState();
    expect(state.isTouch).toBe(true);
    expect(state.standalone).toBe(true);
  });

  it('defaults capability flags to false when nothing matches', () => {
    stubWidth(1400);
    stubMatchMedia([]);
    const state = readBreakpointState();
    expect(state.isTouch).toBe(false);
    expect(state.standalone).toBe(false);
  });
});
