/**
 * Pure zoom/page helpers for the PDF reader. Kept free of pdf.js so the
 * stepping and clamping logic is unit-testable in jsdom.
 */

/** Discrete zoom stops the −/+ buttons and Ctrl+wheel walk through. */
export const ZOOM_STEPS = [
  0.25, 0.33, 0.5, 0.67, 0.75, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0,
  4.0, 5.0,
] as const;

export const MIN_ZOOM = ZOOM_STEPS[0];
export const MAX_ZOOM = ZOOM_STEPS[ZOOM_STEPS.length - 1] as number;

/**
 * Comparisons use a small epsilon so a fit-derived scale that lands a hair
 * off a stop (e.g. 0.9999) still advances to the next stop instead of
 * "zooming" to the stop it is visually already at.
 */
const EPSILON = 0.001;

/** Smallest step strictly above `current`, or MAX_ZOOM when already at/past it. */
export function nextZoomIn(current: number): number {
  for (const step of ZOOM_STEPS) {
    if (step > current + EPSILON) return step;
  }
  return MAX_ZOOM;
}

/** Largest step strictly below `current`, or MIN_ZOOM when already at/past it. */
export function nextZoomOut(current: number): number {
  for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) {
    const step = ZOOM_STEPS[i] as number;
    if (step < current - EPSILON) return step;
  }
  return MIN_ZOOM;
}

/** Clamp a 1-based page number into [1, numPages]; NaN becomes 1. */
export function clampPage(page: number, numPages: number): number {
  if (!Number.isFinite(page)) return 1;
  const max = Math.max(1, Math.floor(numPages));
  return Math.min(max, Math.max(1, Math.floor(page)));
}
