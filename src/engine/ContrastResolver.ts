import { Shape, isGroup } from '../shapes/Shape';
import { shapeRegistry } from '../shapes/ShapeRegistry';
import { getContrastColor } from '../utils/color';
import { Vec2 } from '../math/Vec2';
import { segmentBoxOverlap } from '../math/geometry';

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

/** A stretch of a segment, from `t0` to `t1` along it (0 at its start, 1 at its end), in one colour. */
export interface ColorRun {
  t0: number;
  t1: number;
  color: string;
}

/** Longest gap between hit-test samples along a shape's stretch, in world units. */
const RUN_SAMPLE_STEP = 8;
/** Most hit-test samples per stretch: a long crossing is sampled more coarsely. */
const RUN_MAX_SAMPLES = 32;
/** How closely bisection places a run's edge, in world units. */
const RUN_EDGE_PRECISION = 0.25;

/**
 * Resolve the AUTO sentinel along a segment, as runs of one colour each
 * (DSK-215): a run takes the contrast colour of the topmost opaque shape
 * beneath it, or of the page. One point can't speak for a whole segment: a
 * long line whose midpoint fell on a light shape went dark across the dark
 * canvas too.
 *
 * Each shape's stretch starts where the segment crosses its bounding box and
 * is refined to its outline by bisection on the shape's own hit test, so an
 * ellipse's empty corners don't count. Runs shorter than `minRun` world units
 * fold into a neighbour, so a line that only touches a shape's edge (like a
 * connector clipped to the outline of the shape it is hitched to) keeps one
 * colour there (JP-137).
 *
 * @param minRun - The shortest run worth a colour of its own, in world units.
 */
export function resolveAutoColorRuns(
  a: { x: number; y: number },
  b: { x: number; y: number },
  shapes: Record<string, Shape> | Map<string, Shape>,
  shapeOrder: string[],
  pageBackground: string,
  excludeId?: string,
  minRun = 0
): ColorRun[] {
  const get = (id: string): Shape | undefined =>
    shapes instanceof Map ? shapes.get(id) : shapes[id];
  const length = Math.hypot(b.x - a.x, b.y - a.y);
  if (length === 0) {
    return [{ t0: 0, t1: 1, color: resolveAutoColor(a, shapes, shapeOrder, pageBackground, excludeId) }];
  }
  const from = new Vec2(a.x, a.y);
  const to = new Vec2(b.x, b.y);
  const at = (t: number) => new Vec2(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);

  // The opaque shapes the segment crosses, topmost first, with the stretches
  // of it that lie over each.
  const covers: Array<{ color: string; spans: Array<[number, number]> }> = [];
  for (let i = shapeOrder.length - 1; i >= 0; i--) {
    const id = shapeOrder[i];
    if (!id || id === excludeId) continue;

    const shape = get(id);
    if (!shape || !shape.visible) continue;
    if ((shape.opacity ?? 1) < OPAQUE_THRESHOLD) continue;

    const bg = effectiveBackground(shape);
    if (!bg) continue;

    try {
      const handler = shapeRegistry.getHandler(shape.type);
      const overlap = segmentBoxOverlap(from, to, handler.getBounds(shape));
      if (!overlap) continue;
      const spans = insideSpans(overlap, length, (t) => handler.hitTest(shape, at(t)));
      if (spans.length > 0) covers.push({ color: getContrastColor(bg), spans });
    } catch {
      continue;
    }
  }

  // Cut the segment wherever a stretch starts or ends; each piece takes the
  // colour of the topmost shape over its middle, or the page's.
  const page = getContrastColor(pageBackground);
  const cuts = [0, 1];
  for (const cover of covers) for (const [s0, s1] of cover.spans) cuts.push(s0, s1);
  cuts.sort((p, q) => p - q);
  const runs: ColorRun[] = [];
  for (let i = 1; i < cuts.length; i++) {
    const t0 = cuts[i - 1]!;
    const t1 = cuts[i]!;
    if (t1 <= t0) continue;
    const mid = (t0 + t1) / 2;
    const over = covers.find((cover) => cover.spans.some(([s0, s1]) => mid >= s0 && mid <= s1));
    joinRun(runs, { t0, t1, color: over ? over.color : page });
  }
  return foldShortRuns(runs, minRun / length);
}

/**
 * The stretches of `[t0, t1]` where `inside` holds: sampled at most every
 * RUN_SAMPLE_STEP world units (up to RUN_MAX_SAMPLES), each change bisected
 * to RUN_EDGE_PRECISION. `length` is the whole segment's, in world units.
 */
function insideSpans(
  [t0, t1]: [number, number],
  length: number,
  inside: (t: number) => boolean
): Array<[number, number]> {
  const steps = Math.min(RUN_MAX_SAMPLES, Math.max(2, Math.ceil(((t1 - t0) * length) / RUN_SAMPLE_STEP)));
  const precision = RUN_EDGE_PRECISION / length;
  // Where `inside` changes between lo (where it is `was`) and hi (where it isn't).
  const edge = (lo: number, hi: number, was: boolean): number => {
    while (hi - lo > precision) {
      const mid = (lo + hi) / 2;
      if (inside(mid) === was) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };

  const spans: Array<[number, number]> = [];
  let previous = t0;
  let wasInside = inside(t0);
  let start: number | null = wasInside ? t0 : null;
  for (let k = 1; k <= steps; k++) {
    const t = t0 + ((t1 - t0) * k) / steps;
    const isInside = inside(t);
    if (isInside !== wasInside) {
      const changeAt = edge(previous, t, wasInside);
      if (isInside) start = changeAt;
      else if (start !== null) {
        spans.push([start, changeAt]);
        start = null;
      }
    }
    previous = t;
    wasInside = isInside;
  }
  if (start !== null) spans.push([start, t1]);
  return spans;
}

/** Append a run, extending the last one instead when the colours match. */
function joinRun(runs: ColorRun[], run: ColorRun): void {
  const last = runs[runs.length - 1];
  if (last && last.color === run.color) last.t1 = run.t1;
  else runs.push(run);
}

/**
 * Fold runs shorter than `minT` (a fraction of the segment) into a neighbour,
 * shortest first, until every run is long enough or one is left. There are
 * only two inks and equal neighbours already join, so both neighbours of a run
 * carry the other ink: either will do.
 */
function foldShortRuns(runs: ColorRun[], minT: number): ColorRun[] {
  let result = runs;
  while (result.length > 1) {
    let shortest = -1;
    result.forEach((run, i) => {
      const size = run.t1 - run.t0;
      if (size < minT && (shortest < 0 || size < result[shortest]!.t1 - result[shortest]!.t0)) shortest = i;
    });
    if (shortest < 0) break;

    const into = (result[shortest - 1] ?? result[shortest + 1])!;
    const folded: ColorRun[] = [];
    result.forEach((run, i) => joinRun(folded, { ...run, color: i === shortest ? into.color : run.color }));
    result = folded;
  }
  return result;
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
  private runs = new Map<string, ColorRun[]>();

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

  /**
   * Memoised `resolveAutoColorRuns`, keyed like the points (integer world
   * coordinates) by both ends of the segment.
   */
  resolveRuns(
    a: { x: number; y: number },
    b: { x: number; y: number },
    shapes: Record<string, Shape>,
    shapeOrder: string[],
    pageBackground: string,
    excludeId?: string,
    minRun = 0
  ): ColorRun[] {
    const key = `${Math.round(a.x)},${Math.round(a.y)}>${Math.round(b.x)},${Math.round(b.y)}|${excludeId ?? ''}|${minRun}`;
    const hit = this.runs.get(key);
    if (hit !== undefined) return hit;

    const resolved = resolveAutoColorRuns(a, b, shapes, shapeOrder, pageBackground, excludeId, minRun);
    this.runs.set(key, resolved);
    return resolved;
  }

  clear(): void {
    this.cache.clear();
    this.runs.clear();
  }
}
