/**
 * `adaptiveBudget` derives editor degradation scalars from the `device` hints.
 * These tests drive the derivation by mocking the browser surfaces `device`
 * reads (`window.matchMedia`, `navigator.hardwareConcurrency`/`deviceMemory`),
 * then call `refreshAdaptiveBudget()` to re-derive against the mocked env.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { refreshAdaptiveBudget } from './adaptiveBudget';

interface DeviceEnv {
  coarsePointer?: boolean;
  reduceMotion?: boolean;
  cores?: number;
  memory?: number;
}

function setupDevice({
  coarsePointer = false,
  reduceMotion = false,
  cores = 8,
  memory = 8,
}: DeviceEnv): void {
  vi.spyOn(window, 'matchMedia').mockImplementation(
    (query: string) =>
      ({
        matches:
          (query.includes('pointer: coarse') && coarsePointer) ||
          (query.includes('prefers-reduced-motion') && reduceMotion),
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(),
      }) as unknown as MediaQueryList
  );
  Object.defineProperty(navigator, 'hardwareConcurrency', { value: cores, configurable: true });
  Object.defineProperty(navigator, 'deviceMemory', { value: memory, configurable: true });
}

afterEach(() => {
  vi.restoreAllMocks();
  delete document.documentElement.dataset['reducedMotion'];
});

describe('adaptiveBudget', () => {
  it('desktop / fine pointer: full motion, ~30fps cadence, no hit-target scaling', () => {
    setupDevice({});
    const budget = refreshAdaptiveBudget();
    expect(budget.reduceMotion).toBe(false);
    expect(budget.cursorBroadcastMs).toBe(33);
    expect(budget.hitTargetScale).toBe(1);
    expect(document.documentElement.dataset['reducedMotion']).toBeUndefined();
  });

  it('coarse pointer: enlarges hit targets only', () => {
    setupDevice({ coarsePointer: true });
    const budget = refreshAdaptiveBudget();
    expect(budget.hitTargetScale).toBeGreaterThan(1);
    expect(budget.reduceMotion).toBe(false);
    expect(budget.cursorBroadcastMs).toBe(33);
  });

  it('prefers-reduced-motion: sets reduceMotion + mirrors to root attribute', () => {
    setupDevice({ reduceMotion: true });
    const budget = refreshAdaptiveBudget();
    expect(budget.reduceMotion).toBe(true);
    expect(document.documentElement.dataset['reducedMotion']).toBe('true');
  });

  it('low-power device: reduceMotion + slower broadcast cadence', () => {
    setupDevice({ cores: 2, memory: 2 });
    const budget = refreshAdaptiveBudget();
    expect(budget.reduceMotion).toBe(true);
    expect(budget.cursorBroadcastMs).toBe(120);
    expect(document.documentElement.dataset['reducedMotion']).toBe('true');
  });
});
