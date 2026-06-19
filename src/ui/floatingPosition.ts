/**
 * Pure positioning helpers for the floating collaboration indicator (JP-315).
 *
 * Kept dependency-free and side-effect-free so the placement logic — default
 * anchor + viewport clamping — is unit-testable without a DOM.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  w: number;
  h: number;
}

export interface Viewport {
  w: number;
  h: number;
}

/** Gap (px) kept between the indicator and the viewport edges. */
export const VIEWPORT_MARGIN = 16;

/** Default vertical offset (px) of the top-right anchor — clears the toolbar. */
export const DEFAULT_TOP = 64;

/**
 * Clamp a top-left point so the element stays fully on screen, never closer
 * than `margin` to any edge. When the element is wider/taller than the room
 * available, it pins to the top-left margin rather than going off the left/top.
 */
export function clampToViewport(
  pos: Point,
  size: Size,
  viewport: Viewport,
  margin: number = VIEWPORT_MARGIN
): Point {
  const maxX = Math.max(margin, viewport.w - size.w - margin);
  const maxY = Math.max(margin, viewport.h - size.h - margin);
  return {
    x: Math.min(Math.max(pos.x, margin), maxX),
    y: Math.min(Math.max(pos.y, margin), maxY),
  };
}

/**
 * Resolve the effective top-left for the indicator. A `null` stored position
 * falls back to the top-right anchor; a stored position is clamped into the
 * current viewport (so a window resize can never strand it off-screen).
 */
export function resolveIndicatorPosition(
  stored: Point | null,
  size: Size,
  viewport: Viewport
): Point {
  if (stored == null) {
    return clampToViewport(
      { x: viewport.w - size.w - VIEWPORT_MARGIN, y: DEFAULT_TOP },
      size,
      viewport
    );
  }
  return clampToViewport(stored, size, viewport);
}
