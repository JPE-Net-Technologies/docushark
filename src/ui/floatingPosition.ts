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

// ---------------------------------------------------------------------------
// Floating file-viewer panel (JP-398)
// ---------------------------------------------------------------------------

export interface PanelBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Smallest usable floating-viewer size (toolbar + a readable page column). */
export const MIN_PANEL_SIZE: Size = { w: 360, h: 420 };

/**
 * Clamp a panel's size into [min, viewport − margins] and then its position
 * fully on-screen. Used on drag, resize, restore, and window resize so a
 * stored panel can never be stranded off-screen or larger than the window.
 */
export function clampPanelBounds(
  bounds: PanelBounds,
  viewport: Viewport,
  min: Size = MIN_PANEL_SIZE,
  margin: number = VIEWPORT_MARGIN
): PanelBounds {
  const maxW = Math.max(min.w, viewport.w - 2 * margin);
  const maxH = Math.max(min.h, viewport.h - 2 * margin);
  const w = Math.min(Math.max(bounds.w, min.w), maxW);
  const h = Math.min(Math.max(bounds.h, min.h), maxH);
  const pos = clampToViewport({ x: bounds.x, y: bounds.y }, { w, h }, viewport, margin);
  return { x: pos.x, y: pos.y, w, h };
}

/**
 * Effective bounds for the floating file viewer: stored bounds clamped into
 * the viewport, or a right-side default sized to the window (reading a PDF
 * beside the document is the point, so the default leaves the canvas usable).
 */
export function resolveViewerPanelBounds(
  stored: PanelBounds | null,
  viewport: Viewport
): PanelBounds {
  if (stored) return clampPanelBounds(stored, viewport);
  const w = Math.min(560, Math.max(MIN_PANEL_SIZE.w, Math.round(viewport.w * 0.42)));
  const h = Math.min(720, Math.max(MIN_PANEL_SIZE.h, Math.round(viewport.h * 0.7)));
  return clampPanelBounds(
    { x: viewport.w - w - VIEWPORT_MARGIN, y: DEFAULT_TOP, w, h },
    viewport
  );
}

// ---------------------------------------------------------------------------
// Anchored menu / popover placement (JP-253)
// ---------------------------------------------------------------------------

/** The parts of a trigger's rect that placement actually depends on. */
export interface TriggerRect {
  top: number;
  bottom: number;
  right: number;
}

export interface MenuPlacementInput {
  trigger: TriggerRect;
  viewport: Viewport;
  /** Width the menu wants when there is room for it. */
  preferredWidth: number;
  /** Narrow viewport band — shrink to fit rather than keeping the full width. */
  narrow: boolean;
  /** The menu's natural (unconstrained) height. */
  contentHeight: number;
  /** Space between trigger and menu. */
  gap?: number;
  /** Below this much room underneath, opening downward is not worth it. */
  minDropHeight?: number;
  margin?: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  width: number;
  /** Cap for the menu's height — the menu scrolls past it, never truncates. */
  maxHeight: number;
  /** Opened above the trigger instead of below. */
  flipped: boolean;
}

/**
 * Place a menu anchored under (or over) a trigger, right-aligned to it, fully
 * inside the viewport.
 *
 * Pure, so the behaviour that matters — a narrow viewport shrinks the menu, a
 * short one caps and scrolls it, and neither can push it off-screen — is
 * unit-tested without a DOM. This is the logic behind the layout menu's
 * overflow fix; a hand-rolled `position: absolute; right: 0` had none of it.
 */
export function resolveMenuPlacement({
  trigger,
  viewport,
  preferredWidth,
  narrow,
  contentHeight,
  gap = 6,
  minDropHeight = 260,
  margin = VIEWPORT_MARGIN,
}: MenuPlacementInput): MenuPlacement {
  const width = narrow
    ? Math.min(preferredWidth, Math.max(0, viewport.w - margin * 2))
    : preferredWidth;

  const below = viewport.h - trigger.bottom - gap - margin;
  const above = trigger.top - gap - margin;
  // Flip only when downward is genuinely cramped AND upward is roomier —
  // otherwise a menu near the bottom would flip for no gain.
  const flipped = below < minDropHeight && above > below;

  const maxHeight = Math.max(160, flipped ? above : below);
  const height = Math.min(contentHeight, maxHeight);
  const top = flipped ? trigger.top - gap - height : trigger.bottom + gap;

  const clamped = clampToViewport(
    { x: trigger.right - width, y: top },
    { w: width, h: height },
    viewport,
    margin
  );

  return { left: clamped.x, top: clamped.y, width, maxHeight, flipped };
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
