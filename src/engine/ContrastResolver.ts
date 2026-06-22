import { Shape, isGroup } from '../shapes/Shape';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import { getContrastColor } from '../utils/color';
import { Vec2 } from '../math/Vec2';

/**
 * Sentinel value used in shape `fill` / `stroke` / group `backgroundColor`
 * to request automatic contrast-aware color resolution at render time.
 *
 * Documents containing this sentinel are forward/backward compatible: older
 * code paths that compare colors as plain strings will simply pass it through
 * (and renderers that don't recognize it will fall back to default behavior).
 */
export const AUTO_COLOR = 'auto' as const;

export type AutoColor = typeof AUTO_COLOR;

/**
 * Check whether a color value is the automatic sentinel.
 */
export function isAutoColor(value: string | null | undefined): boolean {
  return value === AUTO_COLOR;
}

/**
 * Minimum opacity for a shape's fill to count as background coverage.
 * Below this threshold the shape is treated as transparent for contrast purposes.
 */
const OPAQUE_THRESHOLD = 0.5;

/**
 * Resolve the AUTO sentinel against the topmost opaque shape underneath a point.
 *
 * Algorithm:
 *   1. Walk `shapeOrder` from top to bottom (last to first).
 *   2. Skip the shape being resolved itself, and any shape with AUTO fill
 *      (auto-colored shapes can't be the background for another auto element).
 *   3. For each candidate, query its bounds via the shape registry. If the
 *      point falls inside, and the shape contributes a usable background
 *      (opaque fill, or — for groups — a `showBackground` background color),
 *      derive the contrast color from that fill.
 *   4. If nothing covers the point, fall back to the page background.
 *
 * Bounding-box check is intentionally used instead of precise hit testing:
 *   contrast resolution doesn't need pixel accuracy, and the bounds path is
 *   cheap enough to run for many points (e.g. per-segment connector sampling)
 *   without a SpatialIndex query.
 *
 * @param point - World-space point to resolve.
 * @param shapes - Map of shape id to shape data.
 * @param shapeOrder - Z-ordered shape ids (first = bottom).
 * @param pageBackground - Hex color of the page/canvas background.
 * @param excludeId - Optional shape id to skip (the shape being resolved).
 * @returns Resolved hex color (#000000 or #ffffff).
 */
export function resolveAutoColor(
  point: { x: number; y: number },
  shapes: Record<string, Shape> | Map<string, Shape>,
  shapeOrder: string[],
  pageBackground: string,
  excludeId?: string
): string {
  const get = (id: string): Shape | undefined =>
    shapes instanceof Map ? shapes.get(id) : shapes[id];

  for (let i = shapeOrder.length - 1; i >= 0; i--) {
    const id = shapeOrder[i];
    if (!id || id === excludeId) continue;

    const shape = get(id);
    if (!shape || !shape.visible) continue;
    if ((shape.opacity ?? 1) < OPAQUE_THRESHOLD) continue;

    // Determine the effective background color for this shape, if any.
    const bg = effectiveBackground(shape);
    if (!bg) continue;

    // Containment: a cheap AABB pre-filter, then a precise outline hit-test so a
    // point in a non-rectangular shape's empty bounding-box corner (e.g. a
    // diamond's corner, actually over the canvas) is not falsely attributed to
    // that shape and coloured against its fill. The hit-test runs only for the
    // few shapes whose box contains the point, and the whole resolution is
    // memoised by the contrast cache, so the cost is negligible.
    try {
      const handler = shapeRegistry.getHandler(shape.type);
      const bounds = handler.getBounds(shape);
      const inAABB =
        point.x >= bounds.minX &&
        point.x <= bounds.maxX &&
        point.y >= bounds.minY &&
        point.y <= bounds.maxY;
      if (!inAABB) continue;
      if (!handler.hitTest(shape, new Vec2(point.x, point.y))) continue;
    } catch {
      continue;
    }

    return getContrastColor(bg);
  }

  return getContrastColor(pageBackground);
}

/**
 * Extract the color a shape contributes as a background for contrast purposes.
 * Returns null if the shape has no usable background (transparent fill,
 * AUTO fill that hasn't been resolved, or a group with no shown background).
 */
function effectiveBackground(shape: Shape): string | null {
  if (isGroup(shape)) {
    if (!shape.showBackground) return null;
    const bg = shape.backgroundColor;
    if (!bg || isAutoColor(bg)) return null;
    return bg;
  }

  const fill = shape.fill;
  if (!fill || isAutoColor(fill)) return null;
  return fill;
}

/**
 * Replace AUTO colour sentinels in `fill`, `stroke`, and group `backgroundColor`
 * / `borderColor` / `labelColor` with a concrete `ink` colour (default black).
 * Used by the static export paths (PDF + SVG): the convention is that
 * "Automatic" resolves to a fixed colour at export rather than running the live
 * contrast resolver. PDF (paper) keeps the black default; SVG passes an ink that
 * suits its background (dark on light, light on dark). For SVG this also avoids
 * emitting `stroke="auto"`, which renders as `none`.
 *
 * Returns a new shape map; the input is not mutated. Shapes that don't use
 * AUTO are returned by reference (no clone) for cheapness.
 */
export function normalizeAutoColorsForExport(
  shapes: Record<string, Shape>,
  ink: string = '#000000'
): Record<string, Shape> {
  const out: Record<string, Shape> = {};
  for (const id in shapes) {
    const shape = shapes[id]!;
    let next: Shape = shape;
    if (isAutoColor(shape.fill) || isAutoColor(shape.stroke)) {
      next = {
        ...shape,
        fill: isAutoColor(shape.fill) ? ink : shape.fill,
        stroke: isAutoColor(shape.stroke) ? ink : shape.stroke,
      };
    }
    // `labelColor` is optional on rectangle/ellipse/connector/file/library
    // (and group, handled below). Normalise it generically when present.
    if ('labelColor' in next && isAutoColor((next as { labelColor?: string }).labelColor)) {
      const patched = { ...next } as typeof next & { labelColor?: string };
      patched.labelColor = ink;
      next = patched;
    }
    if (isGroup(next)) {
      const g = next;
      if (isAutoColor(g.backgroundColor) || isAutoColor(g.borderColor)) {
        const patched = { ...g };
        if (isAutoColor(g.backgroundColor)) patched.backgroundColor = ink;
        if (isAutoColor(g.borderColor)) patched.borderColor = ink;
        next = patched;
      }
    }
    out[id] = next;
  }
  return out;
}

/**
 * Pre-resolve AUTO `fill` / `stroke` / `labelColor` on non-connector, non-group
 * shapes against `pageBackground`, mirroring what the live Renderer does in
 * `resolveAutoFillStroke`. Connectors and groups handle AUTO themselves at
 * render time (per-segment contrast / dynamic background lookup), so they are
 * returned by reference.
 *
 * Used by export paths that render shapes via the canvas handlers but don't
 * have access to the live Renderer's pre-resolution pass — e.g. embedded
 * group thumbnails — so AUTO colours pick up the embed's theme rather than
 * collapsing to the no-context fallback.
 */
export function preResolveAutoColors(
  shapes: Record<string, Shape>,
  shapeOrder: string[],
  pageBackground: string
): Record<string, Shape> {
  const out: Record<string, Shape> = {};
  for (const id in shapes) {
    const shape = shapes[id]!;
    if (isGroup(shape) || shape.type === 'connector') {
      out[id] = shape;
      continue;
    }
    const fillIsAuto = isAutoColor(shape.fill);
    const strokeIsAuto = isAutoColor(shape.stroke);
    const labelColorIsAuto =
      'labelColor' in shape &&
      isAutoColor((shape as { labelColor?: string }).labelColor);
    if (!fillIsAuto && !strokeIsAuto && !labelColorIsAuto) {
      out[id] = shape;
      continue;
    }
    const resolved = resolveAutoColor(
      { x: shape.x, y: shape.y },
      shapes,
      shapeOrder,
      pageBackground,
      shape.id
    );
    const next = { ...shape } as Shape & { labelColor?: string };
    if (fillIsAuto) (next as { fill: string | null }).fill = resolved;
    if (strokeIsAuto) (next as { stroke: string | null }).stroke = resolved;
    if (labelColorIsAuto) next.labelColor = resolved;
    out[id] = next;
  }
  return out;
}

/**
 * Per-frame memoization helper. The Renderer should construct one of these
 * at the start of each frame and discard it after; resolutions for the same
 * (point, exclude) tuple within a frame return cached values.
 */
export class ContrastCache {
  private cache = new Map<string, string>();

  resolve(
    point: { x: number; y: number },
    shapes: Record<string, Shape>,
    shapeOrder: string[],
    pageBackground: string,
    excludeId?: string
  ): string {
    // Quantize the cache key to integer world coords — sub-pixel differences
    // never change contrast. This collapses near-identical samples (e.g. an
    // entire shape's fill region) onto a single cache slot.
    const key = `${Math.round(point.x)},${Math.round(point.y)}|${excludeId ?? ''}`;
    const hit = this.cache.get(key);
    if (hit !== undefined) return hit;

    const resolved = resolveAutoColor(point, shapes, shapeOrder, pageBackground, excludeId);
    this.cache.set(key, resolved);
    return resolved;
  }

  clear(): void {
    this.cache.clear();
  }
}
