/**
 * `platform.device` — adaptive-UI hints (touch vs mouse, viewport band,
 * low-power signals). Browser-based and identical on both shells.
 *
 * Consumed by adaptive-UI logic (animation budget, collab heartbeat
 * frequency, touch-friendly hit targets). Per the Final OSS App Design §5,
 * the editor degrades gracefully when these report constrained conditions;
 * the "10k shapes @ 60fps" budget is a desktop-class target only.
 */

export type ViewportBand = 'narrow' | 'medium' | 'wide';

export interface DeviceHints {
  /** Primary input is touch (no fine pointer). */
  isTouch(): boolean;
  /** Coarse viewport width band. */
  viewportBand(): ViewportBand;
  /** User asked the OS to minimize motion. */
  prefersReducedMotion(): boolean;
  /** Heuristic low-power device (few cores / little memory). */
  isLowPower(): boolean;
}

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    ? window.matchMedia(query).matches
    : false;
}

export const device: DeviceHints = {
  isTouch() {
    return matches('(pointer: coarse)');
  },
  viewportBand() {
    const width = typeof window !== 'undefined' ? window.innerWidth : 1280;
    if (width < 640) return 'narrow';
    if (width < 1024) return 'medium';
    return 'wide';
  },
  prefersReducedMotion() {
    return matches('(prefers-reduced-motion: reduce)');
  },
  isLowPower() {
    if (typeof navigator === 'undefined') return false;
    const cores = navigator.hardwareConcurrency ?? 8;
    const memory = (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? 8;
    return cores <= 4 || memory <= 4;
  },
};
